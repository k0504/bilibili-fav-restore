    // ─── Missing-item recovery (task #15) ────────────────────────────────
    //
    // bilibili's `/x/v3/fav/resource/list` (web) and `/x/v3/fav/folder/
    // resources` (android) both silently drop a small number of items from
    // certain collections — observed example: a 222-item collection where
    // both endpoints return only 205 items across all pages. Those 17 items
    // therefore never get a DOM card on the web page, so the user can't
    // even see they're missing.
    //
    // The recovery path uses the lesser-known `/x/v3/fav/resource/ids`
    // endpoint, which returns the FULL av/bvid list with no metadata, no
    // pagination, and no filtering — bilibili-API-collect docs confirm
    // this is the "raw inventory" endpoint. Diff against what we've
    // actually collected; render a sticky banner listing the gap so the
    // user has at least the av/bvid + links to recover from elsewhere.
    //
    // Per-mediaId cache so we don't hammer the endpoint on every patchOnce.

    var _idsListCache = new Map();   // mediaId → Array<{id, bvid}>
    var _phase1AvsCache = new Map(); // mediaId → { avs:Set<avStr>, complete:bool }
    var _missingBannerShown = new Set();   // mediaId values we've already rendered for
    var _missingInFlight = new Map();      // mediaId → Promise (dedup concurrent scans)

    // Flush EVERY in-memory cache at once: paginated page promises, raw rows,
    // ids list, phase-1 avs, banner-shown set, and in-flight scan dedup.
    // Used by the SPA folder-switch handler and the "清除所有缓存" menu.
    // Persistent GM item cache is NOT touched here — callers that want it gone
    // (the menu) call clearAllItemCache() separately.
    function dropAllInMemory() {
        pageCache.clear();
        pageItems.clear();
        _idsListCache.clear();
        _phase1AvsCache.clear();
        _missingBannerShown.clear();
        _missingInFlight.clear();
    }

    async function fetchAllAvList(mediaId) {
        if (_idsListCache.has(mediaId)) return _idsListCache.get(mediaId);
        var url = 'https://api.bilibili.com/x/v3/fav/resource/ids?media_id='
                + mediaId + '&platform=web';
        var d = await gmGet(url);
        if (d.code !== 0) throw new Error('ids endpoint code=' + d.code + ' ' + (d.message || ''));
        var list = d.data || [];
        _idsListCache.set(mediaId, list);
        return list;
    }

    // Walk EVERY phase-1 page of the first enabled paginated source until
    // has_more=false. This is the "what did bilibili actually return for
    // the whole collection" set. CANNOT use pageItems for this — patchOnce
    // stops phase 1 the moment all current-page invalid hits are covered,
    // so pageItems is a partial subset biased toward invalid items. Using
    // it would massively over-count "missing" on collections where the
    // current DOM page has few or no invalid cards. (Was the 0.8.0 bug:
    // a 99-item clean collection reported "static 99 项" because pageItems
    // was empty.)
    //
    // Cached per mediaId so a tab that lingers doesn't re-walk on every
    // observer tick. ensurePage adds its own request-level dedup.
    // Returns { avs:Set<avStr>, complete:bool }. `complete` is true ONLY when
    // the walk reached a natural has_more=false end (i.e. it saw the whole
    // collection). It is false when the walk stopped early — a page error or
    // the MAX_PAGE_WALK cap. Callers MUST NOT compute a "missing" diff against
    // an incomplete walk: the unwalked tail would be falsely flagged as
    // silently-dropped (the >600-item false-positive this `complete` flag
    // exists to prevent).
    async function fetchFullPhase1Avs(mediaId) {
        if (_phase1AvsCache.has(mediaId)) return _phase1AvsCache.get(mediaId);
        var collected = new Set();
        var srcOrder = Object.keys(SOURCES);
        var srcName = null;
        for (var s = 0; s < srcOrder.length; s++) {
            var def = SOURCES[srcOrder[s]];
            if (def.paginated && def.enabled()) { srcName = srcOrder[s]; break; }
        }
        if (!srcName) {
            log('fetchFullPhase1Avs: no enabled paginated source — abort');
            return { avs: collected, complete: false };
        }
        var complete = false;
        for (var pn = 1; pn <= MAX_PAGE_WALK; pn++) {
            var page;
            try { page = await ensurePage(srcName, mediaId, pn); }
            catch (e) {
                warn('fetchFullPhase1Avs:', srcName, 'page', pn, 'failed:', e.message);
                break;   // complete stays false — partial walk
            }
            (page.list || []).forEach(function (it) {
                if (it.oid != null) collected.add(String(it.oid));
            });
            if (!page.has_more) { complete = true; break; }
        }
        var result = { avs: collected, complete: complete };
        _phase1AvsCache.set(mediaId, result);
        log('fetchFullPhase1Avs: ' + srcName + ' walked → '
            + collected.size + ' items collected (complete=' + complete + ')');
        return result;
    }

    function renderMissingBanner(mediaId, totalDeclared, missing) {
        var BANNER_ID = '__fav_fix_missing_banner';
        var existing = document.getElementById(BANNER_ID);
        if (existing) existing.remove();
        if (!missing.length) return;

        var banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.style.cssText = [
            'position:fixed', 'top:80px', 'right:16px', 'z-index:99998',
            'width:340px', 'max-height:70vh',
            'background:#fff', 'color:#222',
            'border:1px solid rgba(192,57,43,.5)',
            'border-radius:10px',
            'box-shadow:0 4px 18px rgba(0,0,0,.18)',
            'font:13px/1.4 -apple-system,Segoe UI,sans-serif',
            'display:flex', 'flex-direction:column',
            'overflow:hidden'
        ].join(';');

        // Header — clickable to collapse/expand. Three flex children laid
        // out left-to-right: title text (grows), toggle hint, close × .
        // Previously close was position:absolute overlaying header, which
        // ran over "点击展开" once the header text wrapped (340px banner
        // can't fit "本收藏夹声明 N 项，bilibili 静默丢弃 M 项" + toggle
        // text on one line). Inline layout means each child reserves its
        // own width — no overlap regardless of wrap.
        var header = document.createElement('div');
        header.style.cssText = [
            'padding:10px 12px', 'cursor:pointer',
            'background:rgba(192,57,43,.08)',
            'border-bottom:1px solid rgba(192,57,43,.18)',
            // align-items:center — when the title wraps to 2 lines (e.g.
            // narrow viewport), toggle "点击展开" and × stay vertically
            // centered against the wrapped title block. flex-start would
            // pin them to the first line of the title.
            'display:flex', 'align-items:center',
            'gap:8px', 'user-select:none'
        ].join(';');

        var titleSpan = document.createElement('span');
        titleSpan.style.cssText = 'flex:1 1 auto; min-width:0';
        titleSpan.innerHTML =
              '<strong style="color:#c0392b">fav-fix</strong> · '
            + '本收藏夹声明 <strong>' + totalDeclared + '</strong> 项，'
            + 'bilibili 静默丢弃 <strong>' + missing.length + '</strong> 项';

        var toggleSpan = document.createElement('span');
        toggleSpan.className = '__fav_fix_banner_toggle';
        toggleSpan.style.cssText = 'color:#888; font-size:11px; flex:0 0 auto; white-space:nowrap';
        toggleSpan.textContent = '点击展开';

        var closeBtn = document.createElement('span');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = [
            'flex:0 0 auto',
            'cursor:pointer', 'color:#999', 'font-size:18px',
            'line-height:1', 'padding:0 4px', 'margin-left:2px'
        ].join(';');
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            banner.remove();
        });

        header.appendChild(titleSpan);
        header.appendChild(toggleSpan);
        header.appendChild(closeBtn);

        // Body — list of missing items. Default-collapsed per user
        // preference: the count alone in the header is enough at-a-glance
        // info; clicking expands when the user actually wants the list.
        var body = document.createElement('div');
        body.style.cssText = [
            'display:none', 'flex:1 1 auto', 'overflow-y:auto',
            'padding:6px 0'
        ].join(';');
        body.innerHTML = missing.map(function (m) {
            // esc av/bvid before interpolating into HTML text and href. The
            // source is bilibili's ids endpoint (format-constrained), so this
            // is defense in depth rather than a known injection — but every
            // other innerHTML path in this file escapes; keep it uniform.
            var av = esc(String(m.id));
            var bv = esc(m.bvid || '');
            var videoUrl = bv ? 'https://www.bilibili.com/video/' + bv
                              : 'https://www.bilibili.com/video/av' + av;
            return ''
                + '<div style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;line-height:1.5">'
                +   '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between">'
                +     '<code style="font-family:Consolas,monospace;color:#444;font-size:11px">'
                +       'av' + av + (bv ? ' · ' + bv : '')
                +     '</code>'
                +   '</div>'
                +   '<div style="margin-top:4px;display:flex;gap:10px;font-size:11px">'
                +     '<a href="' + videoUrl + '" target="_blank" rel="noopener" style="color:#00aeec">原视频页</a>'
                +     '<a href="https://www.biliplus.com/video/av' + av + '/" target="_blank" rel="noopener" style="color:#00aeec">biliplus 快照</a>'
                +     (bv ? '<a href="https://xbeibeix.com/video/' + bv + '" target="_blank" rel="noopener" style="color:#00aeec">xbeibeix</a>' : '')
                +     '<a href="https://www.jijidown.com/video/av' + av + '" target="_blank" rel="noopener" style="color:#00aeec">jijidown</a>'
                +   '</div>'
                + '</div>';
        }).join('');

        var expanded = false;  // default-collapsed; matches body.display:none above
        header.addEventListener('click', function () {
            expanded = !expanded;
            body.style.display = expanded ? 'block' : 'none';
            var toggle = header.querySelector('.__fav_fix_banner_toggle');
            if (toggle) toggle.textContent = expanded ? '点击收起' : '点击展开';
        });

        banner.appendChild(header);
        banner.appendChild(body);

        // Pin to body so bilibili's SPA re-renders don't blow it away.
        if (document.body) document.body.appendChild(banner);
    }

    function detectMissingAndRender(mediaId) {
        // De-dupe up front. Observer ticks fire patchOnce repeatedly; we
        // only need one render per (mediaId, session). Manual re-scan via
        // menu deletes from this set first.
        if (_missingBannerShown.has(mediaId)) return Promise.resolve();
        // In-flight dedup. The old code set _missingBannerShown only AFTER
        // two awaits, so boot()'s 1500ms trigger and patchOnce's end-of-run
        // trigger routinely raced through the guard and BOTH fetched + both
        // rendered (TOCTOU). Share one Promise per mediaId instead: a second
        // concurrent call returns the same in-flight scan. On failure the
        // entry is dropped (finally) WITHOUT marking shown, so a later tick
        // can retry.
        if (_missingInFlight.has(mediaId)) return _missingInFlight.get(mediaId);
        var p = (async function () {
            try {
                // Parallel: ids endpoint + full phase-1 walk. ids is cheap
                // (single GET, no auth); phase-1 walk is N pages so it
                // dominates the wall time on first scan.
                var all, phase1;
                try {
                    var r = await Promise.all([
                        fetchAllAvList(mediaId),
                        fetchFullPhase1Avs(mediaId)
                    ]);
                    all = r[0];
                    phase1 = r[1];
                } catch (e) {
                    warn('detectMissing: parallel fetch failed:', e.message);
                    return;
                }
                if (!all.length) return;
                var phase1Avs = phase1.avs;
                if (phase1Avs.size === 0) {
                    // Either no enabled paginated source or every page failed.
                    // Without a phase-1 baseline we can't compute a meaningful
                    // gap (subtracting against empty = false-positive 100%
                    // missing, which is exactly the 0.8.0 bug). Skip silently.
                    log('detectMissing: phase-1 set empty, skip');
                    return;
                }
                if (!phase1.complete) {
                    // The walk did NOT reach a natural has_more=false end —
                    // it was cut short by the MAX_PAGE_WALK cap or a page
                    // error. The unwalked tail would be falsely reported as
                    // "silently dropped" (the >600-item false positive). Skip
                    // WITHOUT marking shown: the {avs,complete} result is
                    // cached, so repeat ticks return instantly and re-skip;
                    // a manual rescan (which clears the cache) can retry.
                    log('detectMissing: phase-1 walk incomplete (declared=' + all.length
                        + ' walked=' + phase1Avs.size + ', cap=' + MAX_PAGE_WALK
                        + ' pages) — skipping gap detection to avoid false positives');
                    return;
                }
                var missing = all.filter(function (x) {
                    return !phase1Avs.has(String(x.id));
                });
                log('missing detect: declared=' + all.length
                    + ' phase1=' + phase1Avs.size + ' missing=' + missing.length);
                _missingBannerShown.add(mediaId);
                if (missing.length === 0) return;
                // Guard against a folder switch mid-scan: if the user
                // navigated to a different favlist while we were walking,
                // detectMediaId() no longer matches and the new folder will
                // run its own scan. Rendering here would paint the previous
                // folder's gap over the current page.
                if (detectMediaId() !== mediaId) {
                    log('detectMissing: folder changed mid-scan, skip render for', mediaId);
                    return;
                }
                renderMissingBanner(mediaId, all.length, missing);
            } catch (e) {
                warn('detectMissing failed:', e.message);
            } finally {
                _missingInFlight.delete(mediaId);
            }
        })();
        _missingInFlight.set(mediaId, p);
        return p;
    }

