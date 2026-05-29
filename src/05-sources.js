    // ─── Source registry + resolver ─────────────────────────────────────
    //
    // Each source exposes:
    //   name:     short id used in priority maps
    //   enabled:  () => bool — whether we can call it right now
    //   fetchPage({mediaId, pn}) → Promise<{list:[normItem], has_more}>
    //     Each list item is normalized to the Android-app shape (oid is av,
    //     upper={mid,name,face}, cnt_info={play,danmaku,thumb_up,coin,
    //     reply,collect}, etc.) so the merge layer is field-name-stable.
    //
    // Merge layer: each field has a priority order (which source's value
    // to prefer) plus a QUALITY predicate (a value that fails the quality
    // check — e.g. the global placeholder cover URL — is skipped, falling
    // through to the next source).
    //
    // Cache: merged per-avid records are persisted in GM storage so a tab
    // reload doesn't re-call any API.  In-memory per-page Promise cache
    // dedups concurrent requests within a session.

    // ─── Source failure gate (backoff) ─────────────────────────────────
    // Tracks consecutive timeout/network failures per source. After N hits
    // in a row, the source is considered "down" and `gate.isOpen(name)`
    // returns false for BACKOFF_MS so callers can short-circuit. State is
    // intentionally process-memory only: a page reload resets the gate so
    // the user gets a fresh attempt without waiting for the cooldown.
    var sourceFailureGate = (function () {
        var FAIL_THRESHOLD = 3;
        var BACKOFF_MS = 5 * 60 * 1000;          // 5 min
        var failureCounts = {};                  // src → consecutive fail count
        var openAt = {};                         // src → Date.now() when re-enabled
        return {
            isOpen: function (src) {
                var until = openAt[src] || 0;
                if (until && Date.now() < until) return false;
                // Window expired — reset and try again.
                if (until && Date.now() >= until) {
                    failureCounts[src] = 0;
                    openAt[src] = 0;
                }
                return true;
            },
            onFail: function (src, reason) {
                failureCounts[src] = (failureCounts[src] || 0) + 1;
                if (failureCounts[src] >= FAIL_THRESHOLD && !openAt[src]) {
                    openAt[src] = Date.now() + BACKOFF_MS;
                    console.warn('[fav-fix/' + src + '] gated for ' + (BACKOFF_MS / 60000)
                                 + ' min after ' + failureCounts[src] + ' consecutive failures (last: '
                                 + reason + '). Reload the page to retry sooner.');
                }
            },
            onOk: function (src) {
                if (failureCounts[src] || openAt[src]) {
                    console.info('[fav-fix/' + src + '] backoff gate reset after successful response');
                }
                failureCounts[src] = 0;
                openAt[src] = 0;
            },
            // For stats() inspection.
            snapshot: function () {
                var out = {};
                Object.keys(failureCounts).forEach(function (s) {
                    var until = openAt[s] || 0;
                    out[s] = {
                        consecutiveFailures: failureCounts[s],
                        gatedUntilMs: until,
                        gatedForSec: until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0
                    };
                });
                return out;
            }
        };
    })();

    var SOURCES = {
        android: {
            name: 'android',
            paginated: true,
            enabled: function () { return !!getAuth().access_key; },
            fetchPage: function (ctx) {
                var auth = getAuth();
                var base = {
                    media_id:     String(ctx.mediaId),
                    pn:           String(ctx.pn),
                    ps:           '20',
                    appkey:       appkeyFor(auth.mode),
                    access_key:   auth.access_key,
                    ts:           String(Math.floor(Date.now() / 1000)),
                    // Required-for-invalid-items hints (verified by bisect
                    // against the captured Android-app traffic — dropping
                    // any of these four causes the server to silently
                    // filter invalid items out of the page response):
                    mobi_app:     'android',
                    platform:     'android',
                    build:        '8940300',
                    disable_rcmd: '0',
                    c_locale:     'en',
                    s_locale:     'en',
                    channel:      'bili',
                    statistics:   '{"appId":1,"platform":3,"version":"8.94.0","abtest":""}'
                };
                var signed = signParams(base, appsecFor(auth.mode));
                var url = 'https://api.bilibili.com/x/v3/fav/folder/resources?' + toQuery(signed);
                return gmGet(url).then(function (r) {
                    if (r.code !== 0) throw new Error('android API code=' + r.code + ' msg=' + r.message);
                    var d = r.data || {};
                    // Already in Android-app shape — pass through.
                    return { list: d.list || [], has_more: !!d.has_more, total: d.total };
                });
            }
        },
        'public': {
            name: 'public',
            paginated: true,
            enabled: function () { return true; },
            fetchPage: function (ctx) {
                // Try public spaceDetail (no auth, works for own public favs)
                // first, then fall back to fav/resource/list?platform=web
                // (uses SESSDATA cookie sent by GM_xmlhttpRequest, works for
                // own private favs). Both endpoints return placeholders for
                // invalid items' cover/title, but preserve pubtime / fav_time
                // / tid / pages / cnt_info — the fields the Android-app
                // endpoint omits.
                var qs = 'media_id=' + ctx.mediaId + '&pn=' + ctx.pn + '&ps=20'
                       + '&keyword=&order=mtime&type=0&tid=0';
                var publicUrl  = 'https://api.bilibili.com/medialist/gateway/base/spaceDetail?' + qs + '&jsonp=jsonp';
                var privateUrl = 'https://api.bilibili.com/x/v3/fav/resource/list?'             + qs + '&platform=web';
                return gmGet(publicUrl).then(function (r1) {
                    if (r1.code === 0 && r1.data) return normalizePublicResp(r1.data);
                    log('public spaceDetail code=', r1.code, '— falling back to private/web');
                    return gmGet(privateUrl).then(function (r2) {
                        if (r2.code !== 0) throw new Error('public failed (public=' + r1.code + ' private=' + r2.code + ' msg=' + r2.message + ')');
                        return normalizePublicResp(r2.data);
                    });
                });
            }
        },
        // ─── Third-party archives ──────────────────────────────────────
        // Per-AV (not paginated). The resolver calls fetchAvs(avs) ONLY
        // for avs whose cover or title is still poor quality after the
        // paginated sources (android + public) finish — gates expensive
        // off-site calls. Both sites rate-limit aggressively, so we
        // retry-once on -503 and otherwise just skip the missing av.
        //
        // Failure backoff (sourceFailureGate): if a source eats its full
        // per-request timeout (5s) on N consecutive chunks, we mark it
        // disabled for the next BACKOFF_MS so we don't waste another 5s
        // per patch cycle. State is in-memory only — a TM page reload
        // resets and retries everything (typical "is it back yet" check).
        biliplus: {
            name: 'biliplus',
            paginated: false,
            enabled: function () { return sourceFailureGate.isOpen('biliplus'); },
            fetchAvs: async function (avs) {
                var out = new Map();
                if (!avs.length) return out;
                // Always-on (not gated by debug mode): 3rd-party calls are
                // rare and the user often wants to see whether they fired.
                console.info('[fav-fix/biliplus] querying', avs.length, 'av(s):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var CHUNK = 50;
                // All 3rd-party archives (biliplus / xbeibeix / jijidown)
                // are best-effort fallbacks; never let a slow archive hold
                // up patching the DOM. Per-chunk timeout 5s (vs gmGet's 15s
                // default) keeps the worst case bounded.
                var REQ_TIMEOUT = 5000;
                var sawAnySuccess = false;
                var sawAnyFailure = false;
                for (var i = 0; i < avs.length; i += CHUNK) {
                    var chunk = avs.slice(i, i + CHUNK);
                    var url = 'https://www.biliplus.com/api/aidinfo?aid=' + chunk.join(',');
                    var r;
                    try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                    catch (e) {
                        console.warn('[fav-fix/biliplus] network error:', e.message);
                        sawAnyFailure = true;
                        continue;
                    }
                    if (r && r.code === -503) {
                        console.warn('[fav-fix/biliplus] rate-limited (code -503), retrying in 2s');
                        await new Promise(function (res) { setTimeout(res, 2000); });
                        try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                        catch (e) { sawAnyFailure = true; continue; }
                    }
                    if (!r || r.code !== 0 || !r.data) {
                        console.warn('[fav-fix/biliplus] chunk failed: code=',
                                     r && r.code, 'message=', r && r.message);
                        sawAnyFailure = true;
                        continue;
                    }
                    sawAnySuccess = true;
                    var chunkHits = 0;
                    for (var av in r.data) {
                        var info = r.data[av];
                        if (!info || !info.title) continue;
                        out.set(String(av), {
                            oid:   Number(av),
                            title: info.title,
                            cover: info.pic,
                            upper: info.author ? { name: info.author } : undefined
                        });
                        chunkHits++;
                    }
                    console.info('[fav-fix/biliplus] chunk', i / CHUNK + 1,
                                 'returned', chunkHits, 'of', chunk.length);
                }
                // Feed the backoff gate: any single successful response
                // resets the counter (server's back). If every chunk failed
                // (timeouts, -503, or malformed responses), count it as a
                // single failure event for this fetchAvs call.
                if (sawAnySuccess) sourceFailureGate.onOk('biliplus');
                else if (sawAnyFailure) sourceFailureGate.onFail('biliplus', 'all chunks failed');
                console.info('[fav-fix/biliplus] total:', out.size, '/', avs.length);
                return out;
            }
        },
        xbeibeix: {
            name: 'xbeibeix',
            paginated: false,
            enabled: function () { return sourceFailureGate.isOpen('xbeibeix'); },
            // xbeibeix is BV-keyed HTML scraping (no JSON API), so:
            //   - we avToBv each av before request
            //   - parse the response with DOMParser
            //   - title from `.fw-bold`, cover from `img.img-thumbnail`,
            //     author from the first `<input>` value
            // It also gates behind a CAPTCHA on heavy traffic; detected by
            // the `<meta name="robots">` tag (cerenkov's check). When that
            // happens we skip the av silently — the user can verify human
            // manually by visiting any xbeibeix.com/video/BVx URL once.
            fetchAvs: async function (avs) {
                var out = new Map();
                if (!avs.length) return out;
                console.info('[fav-fix/xbeibeix] querying', avs.length, 'av(s) (sequential, HTML):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var REQ_TIMEOUT = 5000;
                var sawAnyResponse = false;     // any HTTP-level success (incl. redirect / robots)
                for (var i = 0; i < avs.length; i++) {
                    var av = avs[i];
                    var bv = avToBv(av);
                    if (!bv) {
                        console.info('[fav-fix/xbeibeix] av', av, 'avToBv failed, skip');
                        continue;
                    }
                    var url = 'https://xbeibeix.com/video/' + bv;
                    var r;
                    try { r = await gmGet(url, { raw: true, timeout: REQ_TIMEOUT }); }
                    catch (e) {
                        console.warn('[fav-fix/xbeibeix] av', av, 'network error:', e.message);
                        continue;
                    }
                    if (!r || !r.body) continue;
                    sawAnyResponse = true;
                    // Server-side redirect to landing means the av isn't there.
                    if (r.finalUrl && !/\/video\//.test(r.finalUrl)) {
                        console.info('[fav-fix/xbeibeix] av', av, 'redirected (no record)');
                        continue;
                    }
                    var doc;
                    try { doc = new DOMParser().parseFromString(r.body, 'text/html'); }
                    catch (e) { continue; }
                    if (doc.querySelector('meta[name="robots"]')) {
                        console.warn('[fav-fix/xbeibeix] av', av, 'CAPTCHA — visit https://xbeibeix.com/video/' + bv + ' once to clear');
                        continue;
                    }
                    var titleEl = doc.querySelector('.fw-bold');
                    var imgEl   = doc.querySelector('img.img-thumbnail');
                    var authorEl = doc.querySelector('input');
                    var title = titleEl && titleEl.textContent && titleEl.textContent.trim();
                    var cover = imgEl && imgEl.getAttribute('src');
                    var author = authorEl && authorEl.getAttribute('value');
                    if (!title && !cover) continue;
                    // cerenkov: covers not under /bfs/archive/ are likely stale.
                    // We still keep them (better than placeholder) but mark
                    // quality lower implicitly via QUALITY.cover.
                    out.set(String(av), {
                        oid:   Number(av),
                        title: title || undefined,
                        cover: cover || undefined,
                        upper: author ? { name: author } : undefined
                    });
                }
                // Backoff: any HTTP-level response means the site is up
                // even if the av wasn't archived. Only flag failure if
                // every single request errored.
                if (sawAnyResponse) sourceFailureGate.onOk('xbeibeix');
                else sourceFailureGate.onFail('xbeibeix', 'all requests errored');
                console.info('[fav-fix/xbeibeix] total:', out.size, '/', avs.length);
                return out;
            }
        },
        jijidown: {
            name: 'jijidown',
            paginated: false,
            enabled: function () { return sourceFailureGate.isOpen('jijidown'); },
            fetchAvs: async function (avs) {
                if (!avs.length) return new Map();
                console.info('[fav-fix/jijidown] querying', avs.length, 'av(s) (sequential):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var out = new Map();
                // Per-av timeout 5s — see biliplus comment above.
                var REQ_TIMEOUT = 5000;
                var sawAnyResponse = false;
                for (var i = 0; i < avs.length; i++) {
                    var av = avs[i];
                    var url = 'https://www.jijidown.com/api/v1/video/get_info?id=' + av;
                    var r;
                    try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                    catch (e) {
                        console.warn('[fav-fix/jijidown] av', av, 'network error:', e.message);
                        continue;
                    }
                    if (!r) continue;
                    sawAnyResponse = true;
                    if (!r.upid || r.upid <= 0) {
                        console.info('[fav-fix/jijidown] av', av, 'no record (upid=' + r.upid + ')');
                        continue;
                    }
                    if (r.title === '视频去哪了呢？' || r.title === '该视频或许已经被删除了') {
                        console.info('[fav-fix/jijidown] av', av, 'archive empty:', r.title);
                        continue;
                    }
                    if (r.title === String(av) && !r.img) continue;
                    out.set(String(av), {
                        oid:   Number(av),
                        title: r.title,
                        cover: r.img,
                        upper: r.up && r.up.author ? { name: r.up.author, mid: r.upid } : undefined
                    });
                }
                if (sawAnyResponse) sourceFailureGate.onOk('jijidown');
                else sourceFailureGate.onFail('jijidown', 'all requests errored');
                console.info('[fav-fix/jijidown] total:', out.size, '/', avs.length);
                return out;
            }
        }
    };

    function normalizePublicResp(d) {
        // Both spaceDetail and fav/resource/list return { medias: [...], info: {...}, has_more }.
        // medias[].id is the avid (vs Android's oid). Otherwise field
        // names line up closely; we rename id→oid and pass the rest through.
        var medias = d.medias || [];
        var list = medias.map(function (m) {
            var out = {};
            for (var k in m) out[k] = m[k];
            out.oid = m.id != null ? m.id : m.oid;
            return out;
        });
        return { list: list, has_more: !!d.has_more, total: d.info && d.info.media_count };
    }

