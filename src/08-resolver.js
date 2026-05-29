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

        // ─── Phase 1.5: Android flap retry ─────────────────────────────
        // Bilibili's android API is empirically non-deterministic: ~5% of
        // avs flap in/out across consecutive walks (same access_key, same
        // mediaId, seconds apart). Confirmed by 3-walk diagnostic on
        // mediaId=1687751814: walks returned 888 / 879 / 887 avs from a
        // claimed total of 923, with 44 avs (5%) appearing in some walks
        // but not others. Flapping correlates strongly with deactivated
        // accounts (7.6x over-represented) and short legacy aids — bilibili
        // is doing eventually-consistent server-side filtering for items
        // in a boundary state (account suspended / under review / etc).
        //
        // Detection: av must satisfy ALL THREE
        //   1. android missing in pageItems (flap symptom)
        //   2. public present (confirms the av exists; avoids retrying truly
        //      missing items where retry won't help)
        //   3. public's data is degenerate — both cover AND title fail
        //      QUALITY. This is the crucial guard: VALID videos can also
        //      flap (android drops them), but their public entry has real
        //      cover/title so the merge is fine without android. Only the
        //      INVALID-and-android-flapped case actually benefits from
        //      retry, and that's exactly the set this filter selects.
        //
        // Without guard #3, every page with healthy-but-android-missing
        // items triggers a wasteful full android walk (~5-8s) and freezes
        // all loading spinners for the entire patch cycle. With it, normal
        // browsing pays 0 cost; only patches with actual degenerate-
        // candidates incur the retry.
        //
        // Cost (with guard #3): one extra full android walk (~5-8s) ONLY
        // when there are real degenerate candidates. Early-exits as soon
        // as all candidates are recovered (typically pn=1-3).
        var flapCandidates = (SOURCES.android.enabled())
            ? todoAvs.filter(function (av) {
                if (pageItems.has('android|' + av)) return false;
                var p = pageItems.get('public|' + av);
                if (!p) return false;
                // Public has the av — would the merge be degenerate WITHOUT
                // android? If public alone has good cover OR good title,
                // merge is fine, no retry needed.
                var pubCoverOk = QUALITY.cover(p.cover) >= 5;
                var pubTitleOk = QUALITY.title(p.title) >= 10;
                return !pubCoverOk && !pubTitleOk;
            })
            : [];
        if (flapCandidates.length) {
            log('android flap retry for', flapCandidates.length, 'av(s):',
                flapCandidates.slice(0, 5).join(',') + (flapCandidates.length > 5 ? ',…' : ''));
            // Wipe android page cache so ensurePage re-issues network calls
            // instead of returning the cached page Promises from phase 1.
            // Only touch THIS mediaId's keys; other media's caches are
            // untouched (unlikely to matter — only one favlist per page —
            // but safer).
            var pcKeys = [];
            pageCache.forEach(function (_, k) { pcKeys.push(k); });
            for (var ki = 0; ki < pcKeys.length; ki++) {
                if (pcKeys[ki].indexOf('android|' + mediaId + '|') === 0) {
                    pageCache.delete(pcKeys[ki]);
                }
            }
            var pn = 1, MAX_PN = MAX_PAGE_WALK;
            while (pn <= MAX_PN) {
                var allFound = flapCandidates.every(function (av) { return pageItems.has('android|' + av); });
                if (allFound) { log('android flap retry: all candidates recovered at pn=' + pn); break; }
                var page;
                try { page = await ensurePage('android', mediaId, pn); }
                catch (e) { warn('android flap retry pn ' + pn + ' failed:', e.message); break; }
                if (!page.has_more) break;
                pn++;
            }
            // Log final outcome for visibility.
            var stillMissing = flapCandidates.filter(function (av) { return !pageItems.has('android|' + av); });
            if (stillMissing.length) {
                log('android flap retry: ' + (flapCandidates.length - stillMissing.length) + '/' + flapCandidates.length
                    + ' recovered;', stillMissing.length, 'still missing (likely permanent filter, falling through to 3rd-party)');
            } else {
                log('android flap retry: ' + flapCandidates.length + '/' + flapCandidates.length + ' recovered');
            }
        }

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
        todoAvs.forEach(function (av) {
            var perSource = {};
            for (var s2 = 0; s2 < srcOrder.length; s2++) {
                var item = pageItems.get(srcOrder[s2] + '|' + av);
                if (item) perSource[srcOrder[s2]] = item;
            }
            if (Object.keys(perSource).length === 0) {
                // None of the 4 sources have this av. Still emit a stub
                // merged record + persist it, so:
                //   - patchOnce sees an entry and runs markPatched (lets
                //     the user see "we tried" rather than "did nothing").
                //   - markPatched can render the unrecoverable styling
                //     based on `_no_source` flag.
                //   - the GM cache short-circuits the next page reload
                //     instead of re-walking 4 dead sources.
                var attemptedStub = attemptedPerAv.get(av);
                var stub = {
                    oid: Number(av),
                    _no_source: true,
                    // _attempted: union of every source that queried this av
                    // (phase 1 paginated + phase 2 per-av). Tooltip "已查询
                    // 但无记录" reads this. Old cache entries used the
                    // narrower _attempted_3rd field; tooltip falls back.
                    _attempted: attemptedStub ? Array.from(attemptedStub) : [],
                    _tried_sources: srcOrder.slice()
                };
                log('av', av, 'NOT FOUND in any source — caching stub');
                saveCache(av, stub);
                result.set(av, stub);
                return;
            }
            var merged = mergeBySource(perSource);
            var attempted = attemptedPerAv.get(av);
            if (attempted) merged._attempted = Array.from(attempted);
            log('av', av, 'merged from {' + Object.keys(perSource).join(',') + '}',
                attempted ? '(attempted: ' + Array.from(attempted).join(',') + ')' : '',
                '→', 'cover=' + (merged._src_cover || '·'),
                'title=' + (merged._src_title || '·'),
                'upper=' + (merged._src_upper || '·'),
                'cnt=' + (merged._src_cnt_info || '·'),
                'dates=' + (merged._src_pubtime || merged._src_fav_time || '·'));
            saveCache(av, merged);
            result.set(av, merged);
        });
        return result;
    }

