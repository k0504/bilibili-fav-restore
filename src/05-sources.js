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
    // returns false for the cooldown window so callers can short-circuit.
    // State is intentionally process-memory only: a page reload resets the
    // gate so the user gets a fresh attempt without waiting out the cooldown.
    var sourceFailureGate = (function () {
        // Threshold and cooldown are read at FAILURE time, not captured here:
        // this IIFE runs once at load, and a value captured now could never
        // reflect a setting changed later in the same page.
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
                var backoffMs = cfg('sourceBackoffMin') * 60000;
                failureCounts[src] = (failureCounts[src] || 0) + 1;
                if (failureCounts[src] >= cfg('sourceFailThreshold') && !openAt[src]) {
                    openAt[src] = Date.now() + backoffMs;
                    console.warn('[fav-fix/' + src + '] gated for ' + (backoffMs / 60000)
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
        // off-site calls. biliplus rate-limits with code -503 (retry-once);
        // jijidown answers a cold aid with a "loading" stub first and only
        // serves the real record on a follow-up poll (see its fetchAvs).
        //
        // (xbeibeix was removed: the whole site now sits behind Cloudflare's
        // interactive Turnstile challenge, which GM_xmlhttpRequest cannot
        // solve — every request returned the "Just a moment…" page. The
        // missing-item banner in 13-missing.js still links xbeibeix.com for
        // MANUAL clicks, which a real browser CAN clear.)
        //
        // Failure backoff (sourceFailureGate): if a source eats its full
        // per-request timeout (5s) on N consecutive chunks, we mark it
        // disabled for the whole cooldown window so we don't waste another 5s
        // per patch cycle. State is in-memory only — a TM page reload
        // resets and retries everything (typical "is it back yet" check).
        biliplus: {
            name: 'biliplus',
            paginated: false,
            enabled: function () { return cfg('enableBiliplus') && sourceFailureGate.isOpen('biliplus'); },
            fetchAvs: async function (avs) {
                var out = new Map();
                if (!avs.length) return out;
                // Always-on (not gated by debug mode): 3rd-party calls are
                // rare and the user often wants to see whether they fired.
                console.info('[fav-fix/biliplus] querying', avs.length, 'av(s):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                // Snapshotted for the whole sweep so the chunk boundaries and
                // the progress numbers below stay consistent with each other.
                var CHUNK = cfg('biliplusChunk');
                // All 3rd-party archives (biliplus / jijidown) are
                // best-effort fallbacks; never let a slow archive hold
                // up patching the DOM. The per-request timeout is deliberately
                // shorter than gmGet's default, keeping the worst case bounded.
                var REQ_TIMEOUT = cfg('thirdPartyTimeoutMs');
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
        jijidown: {
            name: 'jijidown',
            paginated: false,
            enabled: function () { return cfg('enableJijidown') && sourceFailureGate.isOpen('jijidown'); },
            fetchAvs: async function (avs) {
                if (!avs.length) return new Map();
                console.info('[fav-fix/jijidown] querying', avs.length, 'av(s) (sequential):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var out = new Map();
                // Per-av timeout — see the biliplus comment above.
                var REQ_TIMEOUT = cfg('thirdPartyTimeoutMs');
                // get_info is two-phase: the FIRST hit for an aid jijidown
                // hasn't warmed returns a loading stub
                // ({code:0, msg:'loading', title:'正在加载数据...'} with NO
                // upid); the real record only lands a second or two later. A
                // single shot therefore drops every cold aid (upid undefined →
                // "no record"), which is most invalid items — the exact case
                // this source exists for. Re-poll the stub a few times before
                // giving up. The phase-2 budget in resolveItems still caps
                // total wall time, so a folder full of cold aids can't stall
                // the DOM patch.
                var LOADING_POLL_MS   = cfg('jijidownPollMs');
                var LOADING_MAX_POLLS = cfg('jijidownMaxPolls');   // 1 initial request + this many re-polls
                var sawAnyResponse = false;
                for (var i = 0; i < avs.length; i++) {
                    var av = avs[i];
                    var url = 'https://www.jijidown.com/api/v1/video/get_info?id=' + av;
                    var r = null;
                    for (var attempt = 0; attempt <= LOADING_MAX_POLLS; attempt++) {
                        try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                        catch (e) {
                            console.warn('[fav-fix/jijidown] av', av, 'network error:', e.message);
                            r = null;
                            break;
                        }
                        sawAnyResponse = true;
                        if (r && (r.msg === 'loading' || r.title === '正在加载数据...')) {
                            if (attempt < LOADING_MAX_POLLS) {
                                await new Promise(function (res) { setTimeout(res, LOADING_POLL_MS); });
                                continue;        // still warming up — re-poll
                            }
                            console.info('[fav-fix/jijidown] av', av, 'still loading after',
                                         LOADING_MAX_POLLS + 1, 'polls, skip');
                            r = null;
                        }
                        break;
                    }
                    if (!r) continue;
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
        // folderTitle: the folder's own display name, carried by both public
        // endpoints in d.info.title. The backup walker persists it into the
        // meta store so the manager panel can label folders by name instead
        // of a raw media_id. Resolver callers simply ignore the field.
        return { list: list, has_more: !!d.has_more, total: d.info && d.info.media_count,
                 folderTitle: (d.info && d.info.title) || null };
    }

