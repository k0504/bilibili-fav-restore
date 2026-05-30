    // ─── Resolver ───────────────────────────────────────────────────────

    var pageCache = new Map();   // key=`${src}|${mediaId}|${pn}` → Promise<page>
    var pageItems = new Map();   // key=`${src}|${oid}` → raw item from that source

    // Drop EVERY cache layer for a single av so the next patchOnce truly
    // re-fetches it from the network:
    //   - persistent GM item (clearItemCache)
    //   - in-memory raw rows for ALL sources (pageItems)
    //   - the paginated page-promise cache (pageCache) — otherwise ensurePage
    //     hands back the resolved page whose list ALREADY dropped this av, so
    //     the merge re-runs on stale rows and re-saves identical data.
    // Shared by the card menu "清缓存并重抓" and the forceRefetch() debug API
    // so both paths behave identically.
    function dropItemCaches(av) {
        clearItemCache(av);
        Object.keys(SOURCES).forEach(function (src) {
            pageItems.delete(src + '|' + av);
        });
        pageCache.clear();
    }

    function ensurePage(src, mediaId, pn) {
        var key = src + '|' + mediaId + '|' + pn;
        if (pageCache.has(key)) return pageCache.get(key);
        var p = SOURCES[src].fetchPage({ mediaId: mediaId, pn: pn }).then(function (page) {
            (page.list || []).forEach(function (it) {
                if (it && it.oid != null) pageItems.set(src + '|' + it.oid, it);
            });
            log(src, 'page', pn, '→', (page.list || []).length, 'items has_more=', page.has_more);
            return page;
        });
        pageCache.set(key, p);
        // On error, evict so the next attempt can retry.
        p.catch(function () { pageCache.delete(key); });
        return p;
    }

    // True iff any source already gave us a passable cover AND title for
    // this av — used to gate expensive 3rd-party calls in phase 2.
    function hasGoodCoverAndTitle(av) {
        var srcs = Object.keys(SOURCES);
        var hasCover = false, hasTitle = false;
        for (var s = 0; s < srcs.length; s++) {
            var item = pageItems.get(srcs[s] + '|' + av);
            if (!item) continue;
            if (QUALITY.cover(item.cover) >= 5)  hasCover = true;
            if (QUALITY.title(item.title) >= 10) hasTitle = true;
        }
        return hasCover && hasTitle;
    }

    async function resolveItems(avs, mediaId) {
        var result = new Map();    // av → merged item
        var todoAvs = [];

        for (var i = 0; i < avs.length; i++) {
            var c = loadCache(avs[i]);
            if (c) result.set(avs[i], c);
            else todoAvs.push(avs[i]);
        }
        if (todoAvs.length === 0) {
            log('all', avs.length, 'avs satisfied by cache');
            return result;
        }
        log('todo', todoAvs.length, 'of', avs.length, '(cache hit', avs.length - todoAvs.length + ')');

        var srcOrder = Object.keys(SOURCES);

        // Track which sources (paginated AND per-av) were attempted per av.
        // Tooltip uses this for "已查询但无记录" so the user can see "we
        // asked android + public but they had no record" instead of those
        // sources silently vanishing from the UI. Defined here (not in
        // phase 2 like before) because phase 1 also writes to it.
        var attemptedPerAv = new Map();   // av → Set<srcName>
        function markAttempted(av, src) {
            if (!attemptedPerAv.has(av)) attemptedPerAv.set(av, new Set());
            attemptedPerAv.get(av).add(src);
        }

        // ─── Phase 1: paginated sources (android, public) ────────────
        // Walk pages of each enabled paginated source until every todoAv
        // appears or we hit MAX_PN. Page Promises are deduped by ensurePage.
        for (var s = 0; s < srcOrder.length; s++) {
            var src = srcOrder[s];
            var def = SOURCES[src];
            if (!def.enabled())  { log(src, 'disabled, skip'); continue; }
            if (!def.paginated)  continue;
            // Mark every todoAv as attempted up-front: paginated sources
            // fetch the entire page, so each av is implicitly looked up
            // whether or not the response actually contains it. "Got no
            // record" = the av wasn't in the response.
            todoAvs.forEach(function (av) { markAttempted(av, src); });
            var pn = 1, MAX_PN = MAX_PAGE_WALK;
            while (pn <= MAX_PN) {
                var allFound = todoAvs.every(function (av) { return pageItems.has(src + '|' + av); });
                if (allFound) break;
                var page;
                try { page = await ensurePage(src, mediaId, pn); }
                catch (e) { warn(src + ' page ' + pn + ' failed:', e.message); break; }
                if (!page.has_more) break;
                pn++;
            }
        }

        // ─── Phase 1.5 (REMOVED — now background) ──────────────────────
        // The android fav endpoint is eventually-consistent (~5% of invalid
        // items flap in/out per walk; deactivated-account items 7.6x over-
        // represented — see MAX_FLAP_WALKS in 01-constants.js for the data).
        // This used to do ONE synchronous extra android walk here, which (a)
        // only recovered the easy half of the flappers and (b) froze every
        // loading spinner for its ~5-8s. It is now a BACKGROUND loop-until-dry
        // (runFlapRecovery, kicked off at the end of this function) that does
        // several independent walks and re-patches recovered cards in place —
        // so first paint is never blocked and the stubborn subset gets the
        // multiple samples it statistically needs. Phase 2 (3rd-party) still
        // runs synchronously below so first paint has a best-available cover.

        // ─── Phase 2: per-av sources (biliplus, xbeibeix, jijidown) ───
        // Only query 3rd-party archives for avs whose cover OR title is
        // still bad after phase 1. Skip entirely if everything is satisfied.
        // attemptedPerAv already tracks phase 1; phase 2 adds 3rd-party
        // sources to the same map so the tooltip sees the union.

        // Overall budget for ALL phase-2 sources combined. Per-request
        // timeouts (5s) bound a single chunk; this bounds the total wall
        // time so a single dead archive can't postpone the DOM patch.
        // If we blow the budget, abort the loop and merge with what we have.
        var PHASE2_BUDGET_MS = 10000;
        var phase2Deadline = Date.now() + PHASE2_BUDGET_MS;
        for (var s = 0; s < srcOrder.length; s++) {
            var src = srcOrder[s];
            var def = SOURCES[src];
            if (def.paginated)   continue;
            if (!def.enabled()) {
                // Most commonly this means the source is in the backoff
                // window (sourceFailureGate.isOpen returned false). Loud
                // log so the user understands why a source was skipped
                // without diving into the cache state.
                console.info('[fav-fix] phase 2 skip', src, '(disabled / in backoff window)');
                continue;
            }
            if (Date.now() > phase2Deadline) {
                warn('phase 2 budget exhausted, skipping remaining sources (e.g. ' + src + ')');
                break;
            }
            var needed = todoAvs.filter(function (av) { return !hasGoodCoverAndTitle(av); });
            if (needed.length === 0) { log(src, 'all avs already good, skip'); continue; }
            needed.forEach(function (av) { markAttempted(av, src); });
            // Race fetchAvs against the remaining budget so even an
            // ill-behaved source (no per-request timeout, infinite redirect,
            // etc.) cannot push us past the deadline.
            var remaining = Math.max(1000, phase2Deadline - Date.now());
            try {
                var batch = await Promise.race([
                    def.fetchAvs(needed),
                    new Promise(function (_, rej) {
                        setTimeout(function () { rej(new Error('budget exceeded (' + remaining + 'ms)')); }, remaining);
                    })
                ]);
                batch.forEach(function (item, av) { pageItems.set(src + '|' + av, item); });
            } catch (e) {
                warn(src + ' fetchAvs failed:', e.message);
            }
        }

        // ─── Merge ─────────────────────────────────────────────────────
        // Terminal-vs-retriable classification (the crux of android flap
        // handling): when android is UP, an item that came back with no usable
        // cover/title THIS pass is NOT terminal. android's fav endpoint is
        // eventually-consistent and, for some folders, badly so (observed: a
        // war-footage folder returned 58/89 on one walk; `public` returns ZERO
        // invalid snapshots for it, so android is the only source). An item
        // android flapped out this pass therefore lands as either:
        //   - _no_source  (no source had it — public doesn't carry invalids here)
        //   - _degenerate (only placeholders)
        // Either way android may return its real snapshot on a LATER walk, so we
        // flag it `_pending` (short TTL, card kept in the native "已失效视频"
        // state = re-detectable, no terminal "（视频已删除）") and let
        // runFlapRecovery chase it across several union walks. Only when android
        // is DOWN (no access_key → no retry possible) do we write the terminal
        // _no_source stub ("（视频已删除）", long TTL).
        var androidUp = SOURCES.android.enabled();
        todoAvs.forEach(function (av) {
            var perSource = {};
            for (var s2 = 0; s2 < srcOrder.length; s2++) {
                var item = pageItems.get(srcOrder[s2] + '|' + av);
                if (item) perSource[srcOrder[s2]] = item;
            }
            var attempted = attemptedPerAv.get(av);
            var rec;
            if (Object.keys(perSource).length === 0) {
                // No source returned this av this pass.
                rec = {
                    oid: Number(av),
                    // _attempted: union of every source that queried this av
                    // (phase 1 paginated + phase 2 per-av). Tooltip "已查询
                    // 但无记录" reads this; old entries used _attempted_3rd.
                    _attempted: attempted ? Array.from(attempted) : [],
                    _tried_sources: srcOrder.slice()
                };
                if (androidUp) {
                    rec._pending = true;   // retriable via background android re-walk
                    log('av', av, 'not found this pass — pending (android may flap it back)');
                } else {
                    rec._no_source = true; // terminal: no android to retry with
                    log('av', av, 'NOT FOUND in any source — caching stub (android down)');
                }
            } else {
                rec = mergeBySource(perSource);
                if (attempted) rec._attempted = Array.from(attempted);
                // Degenerate (placeholders only) but android could still recover
                // it on a later walk → keep retriable instead of stuck.
                if (rec._degenerate && androidUp) rec._pending = true;
                log('av', av, 'merged from {' + Object.keys(perSource).join(',') + '}',
                    attempted ? '(attempted: ' + Array.from(attempted).join(',') + ')' : '',
                    '→', 'cover=' + (rec._src_cover || '·'),
                    'title=' + (rec._src_title || '·'),
                    'upper=' + (rec._src_upper || '·'),
                    'cnt=' + (rec._src_cnt_info || '·'),
                    'dates=' + (rec._src_pubtime || rec._src_fav_time || '·'),
                    rec._pending ? '[pending]' : '');
            }
            saveCache(av, rec);
            result.set(av, rec);
        });

        // ─── Background: recover stubborn android flappers ───────────────
        // (replaces the old synchronous phase 1.5; see runFlapRecovery below)
        // Candidates = every item still `_pending` after phase 1 + phase 2:
        // android either flapped it out entirely (_no_source-would-have-been)
        // or only placeholders came back. android's per-walk flapping means
        // more independent UNION walks materially raise the hit rate. Fire-and-
        // forget: the caller paints from `result` immediately; recovered cards
        // are re-patched in place as each walk lands (they stay "已失效视频" so
        // findInvalidContainers keeps finding them until upgraded).
        if (androidUp) {
            var bgCandidates = todoAvs.filter(function (av) {
                var m = result.get(av);
                return m && m._pending;
            });
            if (bgCandidates.length) {
                runFlapRecovery(mediaId, bgCandidates)
                    .catch(function (e) { warn('flap-bg threw:', e && e.message); });
            }
        }

        return result;
    }

    // ─── Background android flap recovery (loop-until-dry) ───────────────
    // Re-walks the android fav endpoint several times for the still-degenerate
    // candidates, UNIONing each fresh server sample into pageItems. Each walk
    // is a new chance to catch an item the previous walk's eventually-consistent
    // filtering dropped (see MAX_FLAP_WALKS in 01-constants.js). Bounded by
    // MAX_FLAP_WALKS / FLAP_DRY_ROUNDS / FLAP_TIME_BUDGET_MS so it converges
    // and never hammers truly-permanent filtering.
    //
    // Re-patch strategy: when a walk recovers an av we saveCache() the upgraded
    // merge and call schedule(). The still-degenerate cards remain detectable
    // by findInvalidContainers Strategy 2 (their title is still "已失效视频"),
    // and loadCache now returns the good merge, so patchOnce's fast path swaps
    // cover+title in place — no stored DOM hits to go stale across bilibili's
    // virtualized scroll, no spinner re-flash (recovered avs hit the cache
    // fast path, not the resolver).
    //
    // Concurrency / race notes:
    //   - Single loop at a time (_flapBgRunning). Re-entry is a no-op: still-
    //     degenerate cards are short-TTL cached and fast-pathed, so a later
    //     patchOnce won't re-enter the resolver for them while this runs.
    //   - Walks call SOURCES.android.fetchPage DIRECTLY (not ensurePage) and
    //     write only pageItems — never pageCache. This deliberately bypasses
    //     the page-promise cache (we WANT a fresh sample each round) AND avoids
    //     racing a concurrent foreground ensurePage walk that shares pageCache.
    //     pageItems writes are same-shaped overwrites, safe under JS's single
    //     thread (no await mid-write).
    //   - Bails the instant the folder changes (detectMediaId() !== mediaId);
    //     dropAllInMemory() on SPA folder-switch clears pageItems out from
    //     under us, which is fine — we re-check before each page and each walk.
    var _flapBgRunning = false;
    async function runFlapRecovery(mediaId, candidates) {
        if (_flapBgRunning) return;
        if (!candidates || !candidates.length) return;
        if (!SOURCES.android.enabled()) return;
        _flapBgRunning = true;
        var pending = new Set(candidates.map(String));
        var deadline = Date.now() + FLAP_TIME_BUDGET_MS;
        var walk = 0, dry = 0;
        try {
            log('flap-bg: start', pending.size, 'candidate(s):',
                Array.from(pending).slice(0, 5).join(',') + (pending.size > 5 ? ',…' : ''));
            while (pending.size && walk < MAX_FLAP_WALKS && dry < FLAP_DRY_ROUNDS) {
                if (detectMediaId() !== mediaId) { log('flap-bg: folder changed, abort'); break; }
                if (Date.now() > deadline)       { log('flap-bg: time budget exhausted'); break; }
                walk++;

                // One fresh android walk straight into pageItems.
                var pn = 1;
                while (pn <= MAX_PAGE_WALK) {
                    if (detectMediaId() !== mediaId || Date.now() > deadline) break;
                    var allFound = true;
                    pending.forEach(function (av) { if (!pageItems.has('android|' + av)) allFound = false; });
                    if (allFound) break;
                    var page;
                    try { page = await SOURCES.android.fetchPage({ mediaId: mediaId, pn: pn }); }
                    catch (e) { warn('flap-bg walk ' + walk + ' pn ' + pn + ' failed:', e.message); break; }
                    (page.list || []).forEach(function (it) {
                        if (it && it.oid != null) pageItems.set('android|' + it.oid, it);
                    });
                    if (!page.has_more) break;
                    pn++;
                }

                // Promote any candidate android now covers with usable data.
                var recovered = [];
                Array.from(pending).forEach(function (av) {
                    var aItem = pageItems.get('android|' + av);
                    if (!aItem) return;
                    if (QUALITY.cover(aItem.cover) < 5 && QUALITY.title(aItem.title) < 10) return;
                    var perSource = {};
                    Object.keys(SOURCES).forEach(function (s) {
                        var it = pageItems.get(s + '|' + av);
                        if (it) perSource[s] = it;
                    });
                    var merged = mergeBySource(perSource);
                    if (merged._degenerate) return;   // still no good cover/title — keep trying
                    saveCache(av, merged);
                    pending.delete(av);
                    recovered.push(av);
                });

                if (recovered.length) {
                    dry = 0;
                    log('flap-bg walk ' + walk + ': recovered', recovered.length,
                        '→ re-patch;', pending.size, 'left');
                    // Upgrade on-screen cards via the normal fast path.
                    schedule();
                } else {
                    dry++;
                    log('flap-bg walk ' + walk + ': 0 new (dry ' + dry + '/' + FLAP_DRY_ROUNDS + ')');
                }
            }
            log('flap-bg: done after', walk, 'walk(s);', pending.size,
                'still unrecovered (fall through to 3rd-party / permanent filter)');
        } finally {
            _flapBgRunning = false;
        }
    }

