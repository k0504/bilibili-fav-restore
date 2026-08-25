    // Apply a resolved item to one card. Returns 'patched' | 'unrecoverable'.
    // Extracted so the fast path (sync cache-hit) and the slow path (async
    // resolver result) share the same DOM-mutation logic — they only differ
    // in *when* applyPatch fires and whether markLoading ran first.
    function applyPatch(hit, real) {
        if (real._no_source) {
            // All sources whiffed. Replace title text with an explicit
            // "(永久删除)" marker so findInvalidContainers' Strategy 2
            // stops re-detecting this hit on every observer tick (the
            // raw "已失效视频" string would otherwise keep matching),
            // and grey out the placeholder image so it visually reads
            // as "we tried, gone forever". Still mark + bind tooltip.
            patchTitle(hit.container, '（视频已删除）');
            if (hit.img) {
                // Avoid replacing the src (the placeholder URL is at
                // least valid and rendered); just desaturate + dim.
                hit.img.style.filter = 'grayscale(1) opacity(.55)';
            }
            // No new cover src to wait for — clear loading overlay now.
            // (No-op for fast-path cards that never had loading marked.)
            clearLoading(hit);
            clearPending(hit);
            markPatched(hit, real);
            return 'unrecoverable';
        }
        if (real._pending) {
            // Still being chased by the background android flap loop
            // (runFlapRecovery). Leave the card's cover/title untouched (native
            // "已失效视频" placeholder) so it stays re-detectable and gets
            // upgraded IN PLACE the moment a walk recovers it — but DO show a
            // retry indicator so the user can see work is happening: a spinning
            // "重试中" badge while the loop is alive (it owns the retry and will
            // keep sampling on its backoff), a static "待重试" once the loop has
            // given up (only a fresh reload, after the short cache TTL, re-kicks
            // it), or a static "已停止重试" when the user switched this av off.
            // Clear the first-pass loading overlay so the two don't stack.
            clearLoading(hit);
            // The stop list is queried LIVE (07a-noretry.js), never through a
            // cache field: the user's press has to show on the very next render
            // pass, and the decision must survive a cache purge that the merge
            // record would not.
            // Three-way, and the middle case is the one that bites: an av
            // carrying an 'auto' record is NOT in the running loop's candidate
            // set (resolveItems dropped it via isRetrySuppressed), so borrowing
            // _flapBgRunning would paint 重试中 — spinner and all — on a card
            // nothing is sampling, while the loop's own progress block counts
            // "还剩 N 项" over a set that excludes it. Only a card the loop can
            // actually be chasing may show 'active'.
            var pav = real.oid != null ? String(real.oid) : null;
            var pSuppressed = pav ? isRetrySuppressed(pav) : false;
            markPending(hit, pav && isNoRetryUser(pav) ? 'stopped'
                           : ((_flapBgRunning && !pSuppressed) ? 'active' : 'waiting'), pav);
            // Pending cards used to stop here with only a bare badge — no
            // tooltip, none of our menu items. Give them the same hover tooltip
            // (now a 重试中/待重试 state explainer) and card menu (now incl.
            // "立即重试") as patched cards, minus the outline/title: those stay
            // native ("已失效视频") so the card remains re-detectable and gets
            // upgraded in place the moment a walk recovers it.
            bindCardAffordances(hit, real);
            return 'pending';
        }
        // Recovered (or android-down degenerate): drop any retry badge first.
        clearPending(hit);
        if (real.cover && hit.img) {
            // Defer clearLoading until the new cover actually paints.
            // Without this the overlay vanishes the moment we swap
            // src — but the new image takes ~100-300ms to download
            // from hdslb CDN, so the user sees the gray placeholder
            // flash before the real cover appears. With the deferred
            // clear, the spinner covers that gap and the swap looks
            // instant. Fast-path cards never had a spinner so the
            // clearLoading inside finish() is just a no-op for them.
            (function (img, h) {
                var done = false;
                var finish = function () {
                    if (done) return; done = true;
                    img.removeEventListener('load',  finish);
                    img.removeEventListener('error', finish);
                    clearLoading(h);
                };
                img.addEventListener('load',  finish);
                img.addEventListener('error', finish);
                // Safety net: if neither event fires (browser cached
                // the new src because the same hdslb URL was loaded
                // earlier this session, or some other edge), the
                // spinner would hang forever. 4s is generous for
                // hdslb but short enough to not feel broken.
                setTimeout(finish, 4000);
                // Third arg = av: lets patchCover fall back to the local
                // backup's cover Blob if this URL 404s (09-dom.js).
                patchCover(img, real.cover, real.oid != null ? String(real.oid) : null);
            })(hit.img, hit);
        } else {
            // Either no real.cover (rare — source returned title
            // only) or no hit.img (Strategy 2). No img-load event
            // to await; clear loading immediately. (For Strategy 2
            // markLoading skipped it anyway, so this is mostly the
            // title-only branch.)
            clearLoading(hit);
        }
        if (real.title) patchTitle(hit.container, real.title);
        markPatched(hit, real);
        return 'patched';
    }

    // ─── Credential-less restore ────────────────────────────────────────
    // Avs this pass already looked up locally and found nothing for. Without it
    // every observer tick would re-open an IndexedDB transaction per unpatched
    // card. Folder-scoped: dropAllInMemory() clears it (13-missing.js), and so
    // does a backup run, which is the one thing that can turn a miss into a hit
    // without a page load.
    var _localOnlyMiss = new Set();

    // Runs INSTEAD of the resolver when there is no access_key. It must not
    // touch the network (android owns every invalid-item snapshot and is
    // appkey+token signed, so the rescue chain genuinely cannot run) and must
    // not write the GM cache — a later logged-in resolve has to stay free to
    // ask android and the third-party archives about whatever the local layers
    // could not answer. Two credential-free sources are available: a merge
    // persisted by an earlier session, and the IndexedDB backup, which was
    // captured while the videos were still alive and needs no login at all.
    // Before this path existed, a fully backed-up folder restored NOTHING once
    // the user logged out.
    async function restoreLocalOnly(hits) {
        var todo = [];
        var patched = 0;
        hits.forEach(function (hit) {
            var av = getAvFromHit(hit);
            if (!av || _localOnlyMiss.has(av)) return;
            var c = loadCache(av);
            if (c) {
                try { if (applyPatch(hit, c) === 'patched') patched++; }
                catch (e) { warn('local-only fast-path applyPatch threw for av', av, e); }
            } else {
                todo.push({ hit: hit, av: av });
            }
        });
        if (todo.length && SOURCES.backup && SOURCES.backup.enabled()) {
            var avs = todo.map(function (t) { return t.av; });
            var recs = null;
            try { recs = await SOURCES.backup.fetchAvs(avs); }
            catch (e) { warn('local-only backup lookup failed:', e && e.message); }
            if (recs) {
                todo.forEach(function (t) {
                    var item = recs.get(t.av);
                    if (!item) { _localOnlyMiss.add(t.av); return; }
                    // Run it through the normal merge so the card, the tooltip
                    // and the clipboard text see exactly the shape they see on
                    // the logged-in path (_src_* provenance included).
                    var real = mergeBySource({ backup: item });
                    if (real._degenerate) { _localOnlyMiss.add(t.av); return; }
                    real._attempted = ['backup'];
                    try { if (applyPatch(t.hit, real) === 'patched') patched++; }
                    catch (e) { warn('local-only applyPatch threw for av', t.av, e); }
                });
            }
        } else {
            todo.forEach(function (t) { _localOnlyMiss.add(t.av); });
        }
        log('no access_key —', patched, 'of', hits.length,
            'invalid card(s) restored from local data (GM cache + backup);',
            'the rest need a login');
    }

    // Re-entrancy guard. patchOnceInner is async and a phase-1 walk can take
    // seconds; schedule()'s 400ms debounce clears pendingTick the instant the
    // timer fires, so a later observer tick (or the clear-cache menu, which
    // calls patchOnce directly) could start a SECOND run while the first is
    // still awaiting. Concurrent runs share pageCache/pageItems and could
    // clobber each other mid-walk. Serialize here: if a run is in flight, mark
    // dirty and let the current run loop once more when it finishes (so the
    // trigger that arrived mid-run — e.g. a clear-cache that just nuked the
    // cache, or the background flap recovery calling schedule() after it
    // upgrades a recovered item — is never dropped). The background flap loop
    // (runFlapRecovery) itself is NOT serialized by this guard: it runs
    // outside patchOnce and only writes pageItems (never pageCache), so it
    // can't corrupt a concurrent foreground walk.
    var _patchInFlight = false;
    var _patchDirty = false;
    async function patchOnce() {
        if (_patchInFlight) { _patchDirty = true; return; }
        _patchInFlight = true;
        try {
            do {
                _patchDirty = false;
                await patchOnceInner();
            } while (_patchDirty);
        } finally {
            _patchInFlight = false;
        }
    }

    async function patchOnceInner() {
        if (!isFavPage()) return;
        var mediaId = detectMediaId();
        if (!mediaId) { log('cannot detect mediaId from URL'); return; }
        var hits = findInvalidContainers();
        if (hits.length === 0) return;
        var auth = getAuth();
        if (!auth.access_key) {
            // No credential → the NETWORK rescue chain is unavailable, but the
            // local layers are not: restore what the GM cache and the local
            // backup can serve instead of leaving a fully backed-up folder
            // untouched. Nothing below this point is reachable without a login.
            await restoreLocalOnly(hits);
            return;
        }
        log('detected', hits.length, 'invalid items, mediaId=', mediaId);

        // ─── Cache-hit fast path ──────────────────────────────────────
        // Synchronously split hits BEFORE any markLoading: cards whose
        // av already has a valid GM-storage entry get patched IMMEDIATELY
        // with zero spinner. Only cache-miss cards go through the async
        // resolver, and only those cards show the loading pulse. Before
        // this split everything got markLoading'd up front and then the
        // whole batch awaited resolveItems — a single cache-miss card
        // (e.g. the one the user just cleared) would drag every other
        // card's spinner along for the entire phase-1 fetch.
        var cachedPairs = [];   // [{hit, av, real}, ...] → patch now
        var todoHits    = [];   // unresolved → async resolver
        hits.forEach(function (hit) {
            var av = getAvFromHit(hit);
            if (!av) { todoHits.push(hit); return; }  // BV-unconvertible → let finally cleanup catch it
            var c = loadCache(av);
            if (c) cachedPairs.push({ hit: hit, av: av, real: c });
            else   todoHits.push(hit);
        });

        var patched = 0;
        var unrecoverable = 0;

        // Patch cached cards first — no spinner, no await.
        cachedPairs.forEach(function (p) {
            try {
                var r = applyPatch(p.hit, p.real);
                if (r === 'patched') patched++;
                else if (r === 'unrecoverable') unrecoverable++;
            } catch (e) {
                warn('fast-path applyPatch threw for av', p.av, e);
            }
        });

        if (todoHits.length === 0) {
            log('all', hits.length, 'cards satisfied by GM cache (fast path)');
            detectMissingAndRender(mediaId);
            return;
        }

        // ─── Cache-miss slow path ────────────────────────────────────
        // Paint loading indicator only on cards that actually need a
        // network round-trip. Cache hits already got their cover above
        // and must not spin.
        todoHits.forEach(markLoading);

        var todoAvs = todoHits.map(getAvFromHit).filter(Boolean);
        var merged;
        try { merged = await resolveItems(todoAvs, mediaId); }
        catch (e) {
            warn('resolve failed:', e);
            toast('数据解析失败：' + e.message, 'err');
            // Resolve threw — never going to call applyPatch, so the
            // loading pulse would otherwise stick forever. Clear it.
            todoHits.forEach(clearLoading);
            return;
        }

        try {
            todoHits.forEach(function (hit) {
                var av = getAvFromHit(hit);
                if (!av) return;
                var real = merged.get(av);
                if (!real) { log('av', av, 'no data from any source'); return; }
                var r = applyPatch(hit, real);
                if (r === 'patched') patched++;
                else if (r === 'unrecoverable') unrecoverable++;
            });
        } finally {
            // Catch loading-state leaks. applyPatch() clears loading on
            // the success/nodata paths; this finally catches the rest:
            //   - BV un-convertible (getAvFromHit returned null)
            //   - merged.get(av) was null (no data from any source)
            //   - an exception was thrown mid-loop (patchTitle / patchCover
            //     on weird DOM); without finally, schedule()'s outer .catch
            //     would swallow the throw and leave the badge pulsing forever.
            // Only walks todoHits because cachedPairs never had loading.
            todoHits.forEach(function (hit) {
                if ((hit.container && hit.container.getAttribute('data-fav-fix-loading'))
                 || (hit.img       && hit.img.getAttribute('data-fav-fix-loading'))) {
                    clearLoading(hit);
                }
            });
        }
        if (patched > 0 || unrecoverable > 0) {
            log('patched', patched, '/ unrecoverable', unrecoverable,
                '/ total', hits.length,
                '(fast-path', cachedPairs.length, '+ slow-path', todoHits.length + ')');
        }

        // After main patching settles, async-check for "ghost" items —
        // avs that bilibili declared in the collection's full ids list but
        // never returned in any page response (silently dropped). Doesn't
        // block patchOnce; renders a sticky banner if a gap is found. Per-
        // mediaId dedup inside detectMissingAndRender prevents repeat
        // renders on observer re-ticks.
        detectMissingAndRender(mediaId);
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────

    var lastUrl = location.href;
    var pendingTick = null;
    function schedule() {
        if (pendingTick) return;
        pendingTick = setTimeout(function () {
            pendingTick = null;
            patchOnce().catch(function (e) { warn('patchOnce threw:', e); });
        }, 400);
    }

    function startObserver() {
        var mo = new MutationObserver(function () {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                // New folder → flush every in-memory cache (page promises,
                // raw rows, ids list, phase-1 avs, banner-shown, in-flight
                // scans). Per-avid GM storage cache is intentionally NOT
                // cleared (re-hits reuse stored data; clear from menu if
                // needed). The render-time detectMediaId() guard already stops
                // a stale in-flight scan from painting the new folder.
                dropAllInMemory();
                var oldBanner = document.getElementById('__fav_fix_missing_banner');
                if (oldBanner) oldBanner.remove();
                // Boot-style detection trigger for the new folder. Delay
                // matches the boot() path so bilibili's SPA has settled.
                setTimeout(function () {
                    var mid = detectMediaId();
                    if (mid) detectMissingAndRender(mid);
                }, 1500);
            }
            schedule();
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

