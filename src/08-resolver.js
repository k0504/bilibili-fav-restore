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

        // Avs the "停止重试" list (07a-noretry.js) still allows network work for.
        // Both modes count here because this is the AUTOMATIC path. Everything
        // below that costs a request is scoped to activeTodo; todoAvs keeps its
        // full membership for phase 0 and for the merge, because neither of
        // those touches the network and a suppressed av must still be
        // classified (and restored from a local backup) exactly as before.
        var activeTodo = todoAvs.filter(function (av) { return !isRetrySuppressed(av); });
        if (activeTodo.length !== todoAvs.length) {
            log('noretry: ' + (todoAvs.length - activeTodo.length) + ' of ' + todoAvs.length
                + ' todo av(s) suppressed — no network retry for them this pass');
        }

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

        // ─── Phase 0: local backup (IndexedDB) ───────────────────────
        // The manual backup (15a-backup.js) is the only source that captured
        // the item while it was still ALIVE, so it runs before anything on the
        // network and leads FIELD_PRIORITY. A hit here cascades: the av passes
        // hasGoodCoverAndTitle, so phase 2 never spends budget on third-party
        // archives for it, and the merge is neither _degenerate nor _pending,
        // so the background flap loop never chases it. Every todoAv is marked
        // attempted — a miss is a real "已查询但无记录" answer, exactly like a
        // paginated source whose page didn't list the av. A broken or blocked
        // IDB must never take the resolver down: warn and fall through to the
        // network sources.
        if (SOURCES.backup && SOURCES.backup.enabled()) {
            todoAvs.forEach(function (av) { markAttempted(av, 'backup'); });
            try {
                var backupHits = await SOURCES.backup.fetchAvs(todoAvs);
                backupHits.forEach(function (item, av) { pageItems.set('backup|' + av, item); });
                if (backupHits.size) log('phase 0: backup covered', backupHits.size, 'of', todoAvs.length);
            } catch (e) {
                warn('phase 0 backup lookup failed:', e && e.message);
            }
        }

        // ─── Phase 1: paginated sources (android, public) ────────────
        // Walk pages of each enabled paginated source until every ACTIVE todoAv
        // appears or we hit MAX_PN. Page Promises are deduped by ensurePage.
        //
        // The whole phase is skipped when every todo av is suppressed — this is
        // the feature's main throttle: re-entering a folder whose invalid items
        // were all abandoned must not fire a single request. attemptedPerAv is
        // deliberately left alone for suppressed avs (nothing was queried, so
        // claiming "已查询但无记录" would be a lie), and the walk's termination
        // test must read activeTodo too: with todoAvs it would never see
        // allFound for a suppressed av and would run the full page-walk cap.
        if (!activeTodo.length && todoAvs.length) {
            log('phase 1 skipped — all', todoAvs.length, 'todo av(s) on the 停止重试 list');
        }
        for (var s = 0; activeTodo.length && s < srcOrder.length; s++) {
            var src = srcOrder[s];
            var def = SOURCES[src];
            if (!def.enabled())  { log(src, 'disabled, skip'); continue; }
            if (!def.paginated)  continue;
            // Mark every active todoAv as attempted up-front: paginated sources
            // fetch the entire page, so each av is implicitly looked up
            // whether or not the response actually contains it. "Got no
            // record" = the av wasn't in the response.
            activeTodo.forEach(function (av) { markAttempted(av, src); });
            var pn = 1, MAX_PN = cfg('maxPageWalk');
            while (pn <= MAX_PN) {
                var allFound = activeTodo.every(function (av) { return pageItems.has(src + '|' + av); });
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
        // represented — see the FLAP_* block in 01-constants.js for the data).
        // This used to do ONE synchronous extra android walk here, which (a)
        // only recovered the easy half of the flappers and (b) froze every
        // loading spinner for its ~5-8s. It is now a single self-driving
        // BACKGROUND loop (runFlapRecovery, kicked off at the end of this
        // function) that re-walks android on an adaptive backoff and re-patches
        // recovered cards in place — so first paint is never blocked and the
        // stubborn subset gets the multiple samples it statistically needs.
        // Phase 2 (3rd-party) still runs synchronously below so first paint has
        // a best-available cover.

        // ─── Phase 2: per-av sources (biliplus, jijidown) ────────────
        // Only query 3rd-party archives for avs whose cover OR title is
        // still bad after phase 1. Skip entirely if everything is satisfied.
        // attemptedPerAv already tracks phase 1; phase 2 adds 3rd-party
        // sources to the same map so the tooltip sees the union.

        // Overall budget for ALL phase-2 sources combined. Per-request
        // timeouts (5s) bound a single chunk; this bounds the total wall
        // time so a single dead archive can't postpone the DOM patch.
        // If we blow the budget, abort the loop and merge with what we have.
        var PHASE2_BUDGET_MS = cfg('phase2BudgetMs');
        var phase2Deadline = Date.now() + PHASE2_BUDGET_MS;
        for (var s = 0; s < srcOrder.length; s++) {
            var src = srcOrder[s];
            var def = SOURCES[src];
            if (def.paginated)   continue;
            if (src === 'backup') continue;   // local, already queried in phase 0
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
            // activeTodo, not todoAvs: a suppressed av must not cost a
            // third-party request either. Its merge still lands as _pending —
            // the classification describes the DATA, not our intent to chase it.
            var needed = activeTodo.filter(function (av) { return !hasGoodCoverAndTitle(av); });
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
                // No source returned this av this pass. For a SUPPRESSED av
                // that is not a finding: phase 1 was skipped and phase 2 never
                // asked for it, so an empty perSource means "we did not look",
                // not "nobody has it". Writing the bare _pending stub below
                // would overwrite the previous merge — typically a
                // _cover_pending record whose title / UP / date are already
                // patched onto the card — and nothing would ever restore it,
                // because every automatic path stays switched off until the
                // record expires (each later visit would rewrite the same
                // stub). Serve the stored merge past its staleness TTL instead
                // and leave storage untouched. This is the hazard 11-menu.js
                // already guards on the manual path by clearing the record
                // before 清缓存并重抓; the TTL-expiry path needs it too.
                if (isRetrySuppressed(av)) {
                    var kept = loadCacheStale(av);
                    if (kept) {
                        log('av', av, 'suppressed and not queried this pass — keeping the stored merge'
                            + ' instead of overwriting it with a pending stub');
                        result.set(av, kept);
                        return;
                    }
                }
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
                // Title recovered, cover still missing / a placeholder. NOT
                // _pending — the title is real and belongs on the card right
                // now — but not settled either: android flaps covers exactly as
                // it flaps whole rows. Flag it so loadCache keeps the short
                // staleness TTL and the background loop keeps sampling for the
                // image (holding out for a COVER, not retiring on the title it
                // already has). Without this, a title-only merge locks the card
                // to its placeholder cover for 30 days — and a title-only local
                // BACKUP record, which never expires, would re-impose that lock
                // on every later resolve, permanently disabling the only retry
                // path the system has.
                else if (androidUp && rec._src_title && !rec._src_cover) rec._cover_pending = true;
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
        // `_cover_pending` avs join the same loop but with a stricter promotion
        // test (they already have a title; only a cover retires them).
        if (androidUp) {
            var bgCandidates = [];
            var bgCoverOnly  = [];
            todoAvs.forEach(function (av) {
                var m = result.get(av);
                if (!m) return;
                // Suppressed avs keep their _pending / _cover_pending marker but
                // must not arm the loop — otherwise "停止重试" would stop the
                // page walk and still spend four minutes sampling android.
                if (isRetrySuppressed(av)) return;
                if (m._pending) bgCandidates.push(av);
                else if (m._cover_pending) { bgCandidates.push(av); bgCoverOnly.push(av); }
            });
            if (bgCandidates.length) {
                runFlapRecovery(mediaId, bgCandidates, bgCoverOnly)
                    .catch(function (e) { warn('flap-bg threw:', e && e.message); });
            }
        }

        return result;
    }

    // ─── Background android flap recovery (single self-driving loop) ─────
    // THE retry mechanism. One loop owns a folder's whole retry lifecycle:
    // re-walks the android fav endpoint, UNIONing each fresh server sample into
    // pageItems, until every candidate recovers or it gives up. Each walk is a
    // new chance to catch an item the previous walk's eventually-consistent
    // filtering dropped. There is no other retry path — no cache-TTL timer, no
    // scroll-to-retry; the short _pending TTL in 07-cache.js is now purely a
    // staleness guard for a future fresh page load, NOT a retry trigger.
    //
    // It is no longer started unconditionally: resolveItems drops avs on the
    // 停止重试 list (07a-noretry.js) from its candidate set, this loop prunes
    // avs the user stops mid-run at the top of every round, and its finally
    // records an auto stop for whatever it genuinely gave up on — so the same
    // hopeless folder is not re-sampled from scratch on every visit.
    //
    // Adaptive backoff (cfg('flapBackoffMs') / cfg('flapMaxDry')): the
    // `dry` counter drives BOTH cadence and termination. A walk that recovers
    // something resets dry → next walk fires after the short burst gap; a walk
    // that recovers nothing bumps dry → the gap widens and, at maxDry,
    // the loop concludes the leftovers are genuinely filtered and stops. So a
    // still-flapping folder is sampled fast and converges; a truly-deleted set
    // is abandoned after ~7 cheap samples (~4 min) instead of being hammered.
    //
    // Two kinds of candidate share the loop: `_pending` avs (nothing usable yet
    // — any cover OR title retires them) and `_cover_pending` avs (title already
    // patched onto the card, only the image missing — nothing but a cover
    // retires them). The caller passes the latter as `coverNeeded`; without that
    // distinction the title they already have would retire them on walk 1 and
    // the cover would never be chased.
    //
    // Re-patch strategy: when a walk recovers an av we saveCache() the upgraded
    // merge and call schedule(). The still-pending cards remain detectable by
    // findInvalidContainers Strategy 2 (their title is still "已失效视频"), and
    // loadCache now returns the good merge, so patchOnce's fast path swaps
    // cover+title in place — no stored DOM hits to go stale across bilibili's
    // virtualized scroll, no spinner re-flash (recovered avs hit the cache fast
    // path, not the resolver). Cards still pending while the loop is alive show
    // a "重试中" badge (applyPatch reads _flapBgRunning); they flip to "待重试"
    // only once the loop terminates (the finally's schedule()), or to
    // "已停止重试" the moment the user is on the stop list.
    //
    // Concurrency / race notes:
    //   - Single loop at a time (_flapBgRunning, true for the loop's WHOLE life
    //     including backoff sleeps). Re-entry is a no-op. Backoff sleeps are
    //     sliced ~1s so a folder switch frees _flapBgRunning within a second —
    //     the next folder's resolve (fired after the SPA settle delay) can then
    //     start its own loop instead of being locked out for minutes.
    //   - Walks call SOURCES.android.fetchPage DIRECTLY (not ensurePage) and
    //     write only pageItems — never pageCache. This deliberately bypasses
    //     the page-promise cache (we WANT a fresh sample each round) AND avoids
    //     racing a concurrent foreground ensurePage walk that shares pageCache.
    //     pageItems writes are same-shaped overwrites, safe under JS's single
    //     thread (no await mid-write).
    //   - Bails the instant the folder changes (detectMediaId() !== mediaId);
    //     dropAllInMemory() on SPA folder-switch clears pageItems out from
    //     under us, which is fine — we re-check before each page, walk, and
    //     backoff slice.
    var _flapBgRunning = false;
    // Live progress of the active flap loop, surfaced to the pending card's
    // hover tooltip (buildTipHtml _pending branch) so the user can SEE what the
    // background retry is doing — which walk, how many left, walking vs backing-
    // off, countdown to the next sample — instead of a static "重试中". null
    // whenever no loop runs (set on entry below, cleared in the finally).
    var _flapProgress = null;
    // Avs the loop GAVE UP on (still pending after it stopped), kept so a card's
    // "立即重试" menu item (kickManualRetry) can re-arm the loop with the WHOLE
    // leftover set in one walk instead of chasing a single av. Scoped to one
    // folder via _flapLeftoverMid; cleared on folder switch (dropAllInMemory).
    var _flapLeftover = new Set();
    // Subset of _flapLeftover whose retry is about the COVER only (the title is
    // already patched onto the card). Kept apart so a manual re-arm restores the
    // same promotion rule instead of retiring them on the first walk.
    var _flapLeftoverCover = new Set();
    var _flapLeftoverMid = null;
    async function runFlapRecovery(mediaId, candidates, coverNeeded) {
        if (_flapBgRunning) return;
        if (!candidates || !candidates.length) return;
        if (!SOURCES.android.enabled()) return;
        _flapBgRunning = true;
        // Flip any on-screen pending badges to "重试中" right away: the loop may
        // sleep on its first backoff before any recovery-driven schedule(), and
        // a MANUAL re-arm has nothing else to repaint the cards.
        schedule();
        var pending = new Set(candidates.map(String));
        // Avs enqueued because their COVER is missing while the title is
        // already good (`_cover_pending`). The default promotion test below
        // (!_degenerate) is already satisfied by that title, so it would retire
        // them after one walk without ever obtaining the image — for these the
        // merge has to actually carry a cover.
        var needCover = new Set((coverNeeded || []).map(String));
        // The loop's own parameters are snapshotted ONCE, here. This run can
        // last the better part of an hour; re-reading them mid-flight would
        // change the rules under a half-finished sampling campaign (a lowered
        // maxDry would end it retroactively, on evidence gathered under the
        // old one). An edit lands on the next armed loop instead.
        var maxDry   = cfg('flapMaxDry');
        var backoff  = cfg('flapBackoffMs');
        var deadline = Date.now() + cfg('flapTimeBudgetMin') * 60000;
        var walk = 0, dry = 0;
        // Consecutive walks whose android requests ALL threw — an expired /
        // invalidated access_key (code -101), risk control (-352), a few
        // minutes offline. android has no sourceFailureGate (05-sources.js only
        // checks that an access_key string exists) and nothing clears the key on
        // an API error, so such a run continues until this loop stops it. Those
        // walks sample NOTHING, so they must not feed `dry`: otherwise a
        // transient outage stamps 7-day auto 停止重试 records on a whole folder
        // on the strength of zero evidence, and the next visit (phase 1 skipped,
        // loop never armed) does no network work at all. They still widen the
        // backoff and still terminate the loop — but without a verdict.
        var errRun = 0;
        // Did any walk ever obtain a sample? Guards the budget-exhausted exit
        // below for the same reason.
        var everSampled = false;
        // Did the loop reach a CONCLUSION (dry ran out / the time budget did),
        // as opposed to being interrupted? Only a conclusion may write the
        // auto 停止重试 records in the finally. Re-deriving this from `dry` down
        // there would misfire: a folder switch can abort the loop at a moment
        // when dry happens to sit at maxDry, and an interrupted loop is
        // not a verdict on a folder it never finished sampling.
        var gaveUp = false;
        _flapProgress = {
            mediaId: mediaId, startedAt: Date.now(), deadline: deadline,
            total: pending.size, remaining: pending.size,
            walk: 0, dry: 0, maxDry: maxDry,
            phase: 'walking', page: 0, nextWalkAt: 0, lastRecovered: 0
        };
        try {
            log('flap-bg: start', pending.size, 'candidate(s):',
                Array.from(pending).slice(0, 5).join(',') + (pending.size > 5 ? ',…' : ''));
            while (pending.size && dry < maxDry) {
                if (detectMediaId() !== mediaId) { log('flap-bg: folder changed, abort'); break; }
                // Budget exhausted counts as a conclusion only if android
                // answered at least once: 30 minutes of failed requests is a
                // statement about the connection, not about the videos.
                if (Date.now() > deadline)       { log('flap-bg: time budget exhausted'); gaveUp = everSampled; break; }
                // Drop anything the user stopped WHILE the loop was running:
                // pressing 停止重试 has to take effect on the next round, not
                // whenever the loop happens to run out of budget. Only the
                // 'user' mode is honoured — the 'auto' records are written by
                // THIS loop's own finally, and a manual re-arm exists precisely
                // to override them.
                var stopped = 0;
                Array.from(pending).forEach(function (av) {
                    if (isNoRetryUser(av)) { pending.delete(av); stopped++; }
                });
                if (stopped) log('flap-bg: dropped', stopped, 'candidate(s) the user stopped');
                // Pending emptied by those stops is NOT a give-up: there is
                // nothing left to record, and the loop simply retires.
                if (!pending.size) { log('flap-bg: no candidates left to chase'); break; }
                walk++;
                _flapProgress.walk = walk;
                _flapProgress.phase = 'walking';
                _flapProgress.remaining = pending.size;

                // One fresh android walk straight into pageItems.
                //   sampledOk — this walk actually holds android's answer about
                //     the candidates: a page came back, or every candidate
                //     already has a row so there was nothing left to ask for.
                //     A walk whose every request threw has neither.
                //   interrupted — a folder switch truncated the walk. The
                //     observer's dropAllInMemory() has cleared pageItems out
                //     from under it, so the promotion pass below can recover
                //     nothing BY CONSTRUCTION; that is not a result either.
                var sampledOk = false, interrupted = false;
                var pn = 1;
                while (pn <= cfg('maxPageWalk')) {
                    if (detectMediaId() !== mediaId) { interrupted = true; break; }
                    if (Date.now() > deadline) break;
                    var allFound = true;
                    pending.forEach(function (av) { if (!pageItems.has('android|' + av)) allFound = false; });
                    if (allFound) { sampledOk = true; break; }
                    _flapProgress.page = pn;
                    var page;
                    try { page = await SOURCES.android.fetchPage({ mediaId: mediaId, pn: pn }); }
                    catch (e) { warn('flap-bg walk ' + walk + ' pn ' + pn + ' failed:', e.message); break; }
                    sampledOk = true;
                    (page.list || []).forEach(function (it) {
                        if (it && it.oid != null) pageItems.set('android|' + it.oid, it);
                    });
                    if (!page.has_more) break;
                    pn++;
                }
                // Leave before an interrupted walk can be read as a verdict. The
                // top-of-loop guard would break next round anyway — but only
                // AFTER this round's dry++ had possibly pushed `dry` to
                // maxDry and stamped auto records on every remaining av of
                // the folder the user has just left.
                if (interrupted) { log('flap-bg: folder changed mid-walk, abort'); break; }
                if (sampledOk) everSampled = true;

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
                    // Keep trying while the walk has not produced what this av
                    // was enqueued for: a cover for the _cover_pending set, any
                    // usable cover-or-title for everyone else.
                    if (needCover.has(av) ? !merged._src_cover : merged._degenerate) return;
                    saveCache(av, merged);
                    pending.delete(av);
                    recovered.push(av);
                });

                if (recovered.length) {
                    dry = 0; errRun = 0;   // progress → reset cadence to the burst gap and keep sampling fast
                    log('flap-bg walk ' + walk + ': recovered', recovered.length,
                        '→ re-patch;', pending.size, 'left');
                    // Upgrade on-screen cards via the normal fast path.
                    schedule();
                } else if (!sampledOk) {
                    // android never answered. Back off exactly like a dry walk
                    // does, but do not count it as one — the candidates were not
                    // sampled, so there is nothing to conclude about them.
                    errRun++;
                    log('flap-bg walk ' + walk + ': android unreachable (' + errRun + '/' + maxDry
                        + ' consecutive) — not counted toward dry');
                } else {
                    errRun = 0;
                    dry++;     // no progress → widen the gap, step toward giving up
                    log('flap-bg walk ' + walk + ': 0 new (dry ' + dry + '/' + maxDry + ')');
                }
                _flapProgress.dry = dry;
                _flapProgress.lastRecovered = recovered.length;
                _flapProgress.remaining = pending.size;

                if (!pending.size || dry >= maxDry || errRun >= maxDry) {
                    if (dry >= maxDry) gaveUp = true;
                    // An error run stops the loop WITHOUT a verdict: the cards
                    // stay 待重试 and a reload — or 立即重试, or the user simply
                    // logging in again — re-arms the loop exactly as before.
                    else if (errRun >= maxDry) log('flap-bg: stopping for now — ' + errRun
                        + ' consecutive walk(s) could not reach android; no auto 停止重试 written');
                    break;
                }

                // Adaptive backoff before the next walk: gap widens with `dry`.
                // Sleep in ~1s slices so a folder switch / budget expiry breaks
                // out within a second (frees _flapBgRunning for the next folder).
                // Widen on whichever counter is running: a failing android must
                // back off just as a fruitless one does, or an outage would be
                // hammered at the 1s burst gap.
                var gap = backoff[Math.min(Math.max(dry, errRun), backoff.length - 1)];
                var until = Date.now() + gap;
                _flapProgress.phase = 'sleeping';
                _flapProgress.nextWalkAt = until;
                while (Date.now() < until) {
                    if (detectMediaId() !== mediaId || Date.now() > deadline) break;
                    await new Promise(function (r) { setTimeout(r, Math.min(1000, until - Date.now())); });
                }
            }
            log('flap-bg: done after', walk, 'walk(s);', pending.size,
                'still unrecovered (stays 待重试 until a fresh reload re-attempts)');
        } finally {
            _flapBgRunning = false;
            _flapProgress = null;
            // Auto 停止重试 records — written ONLY when the loop reached a
            // conclusion (gaveUp). They expire after 7 days, so the next visit
            // within that window skips the page walk entirely instead of
            // re-running ~4 minutes of sampling for items that are almost
            // certainly deleted; after it, the folder gets a fresh chance.
            if (gaveUp && pending.size) {
                pending.forEach(function (av) { markAutoNoRetry(av); });
                log('flap-bg: recorded auto 停止重试 for', pending.size, 'av(s)');
            }
            // Remember the avs we gave up on so a card's "立即重试" can re-arm
            // the loop over the WHOLE leftover set (not just the clicked card).
            // If the loop recovered everything, pending is empty → no leftover →
            // the retry menu item won't render (cards are no longer _pending).
            // Avs the user stopped are excluded: the leftover set is the manual
            // re-arm's payload, and a manual retry must never resurrect a card
            // whose retries the user switched off.
            _flapLeftover = new Set();
            pending.forEach(function (av) { if (!isNoRetryUser(av)) _flapLeftover.add(av); });
            _flapLeftoverCover = new Set();
            _flapLeftover.forEach(function (av) { if (needCover.has(av)) _flapLeftoverCover.add(av); });
            _flapLeftoverMid = mediaId;
            // Re-run the patch pass with the loop now inactive so any still-
            // pending cards flip their badge from "重试中" to "待重试".
            // Recovered cards already upgraded via the per-walk schedule() calls.
            schedule();
        }
    }

    // Manual re-arm of the flap loop from a card's "立即重试" menu item. Re-runs
    // THE loop (runFlapRecovery) over every av it gave up on in THIS folder, so a
    // single android walk recovers all still-pending cards, not just the clicked
    // one. Falls back to [clickedAv] if the leftover set is stale/empty (e.g. a
    // fresh page load started a new loop). No-op with a toast if a loop is alive
    // (the card already shows 重试中) or android is unavailable.
    function kickManualRetry(clickedAv) {
        var mid = detectMediaId();
        if (!mid) { toast('无法识别当前收藏夹', 'warn'); return; }
        if (!SOURCES.android.enabled()) { toast('android 接口不可用，无法重试', 'warn'); return; }
        if (_flapBgRunning) { toast('后台正在重试中，请稍候', 'ok'); return; }
        var sameFolder = (_flapLeftoverMid === mid);
        var cands     = sameFolder ? Array.from(_flapLeftover)      : [];
        var coverOnly = sameFolder ? Array.from(_flapLeftoverCover) : [];
        if (!cands.length && clickedAv) { cands = [String(clickedAv)]; coverOnly = []; }
        // Honour the user's manual stops only. An 'auto' record is exactly what
        // this button is for overriding — the user is telling us to ignore the
        // loop's give-up and sample once more — but a card the user stopped
        // by hand must stay stopped even when it rides along in the leftover set.
        cands     = cands.filter(function (av) { return !isNoRetryUser(av); });
        coverOnly = coverOnly.filter(function (av) { return !isNoRetryUser(av); });
        if (!cands.length) { toast('没有待重试的视频', 'ok'); return; }
        // The leftover set can also hold cards that ARE patched and only lack a
        // cover, so the wording is deliberately not "待重试" alone.
        toast('正在重新抓取 ' + cands.length + ' 项未完全还原的视频', 'ok');
        runFlapRecovery(mid, cands, coverOnly).catch(function (e) { warn('manual retry threw:', e); });
    }

