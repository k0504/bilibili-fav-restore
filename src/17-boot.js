    // ─── Boot ───────────────────────────────────────────────────────────

    function boot() {
        if (!isFavPage()) { log('not a fav page, idle'); return; }
        log('booting on', location.href);
        startObserver();
        schedule();
        // Independent missing-items check from boot — patchOnce only runs
        // detectMissingAndRender at its END, and patchOnce early-returns
        // when there are no invalid cards. Without this boot-trigger,
        // collections with NO visible invalid cards but with "ghost"
        // (silently-dropped) items wouldn't show a banner at all. Delay
        // 1500ms so bilibili's SPA has time to settle the URL and DOM.
        setTimeout(function () {
            var mid = detectMediaId();
            if (mid) detectMissingAndRender(mid);
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    // ─── Debug surface ──────────────────────────────────────────────────
    //
    // Lives on `pageWin` (= unsafeWindow if available) so DevTools F12 console
    // can reach it. `window.__biliFavFix` from page world would be undefined
    // because the userscript runs in isolated world.

    pageWin.__biliFavFix = {
        VERSION: CORE_VERSION,
        version: CORE_VERSION,   // legacy alias

        // --- inspection ---
        // REDACTED on purpose. This object lives on unsafeWindow (page world)
        // so DevTools can reach it — which means ANY script on the bilibili
        // page (official code, ads, another extension, an injected payload)
        // can read whatever we expose here. The raw access_key is a ~30-day
        // account credential; returning it would let a hostile page script
        // exfiltrate it, defeating the whole point of running in the isolated
        // world. Debugging never needs the raw token — surface the same
        // redacted view as the "查看登录状态" menu instead.
        getAuth: function () {
            var a = getAuth();
            return {
                mode: a.mode,
                hasAccessKey: !!a.access_key,
                ageDays: a.ts ? Math.floor((Date.now() - a.ts) / 86400000) : null
            };
        },
        loadCache: loadCache,
        cache: { pages: pageCache, items: pageItems },
        sources: SOURCES,
        // stats() returns a quick health check: cache sizes + last patch result
        stats: function () {
            // Card count via the shared CARD_SELECTOR (same list Strategy 2
            // scopes its scan to) so the two never drift.
            var cardCount = document.querySelectorAll(CARD_SELECTOR).length;
            var invalidNow = (typeof findInvalidContainers === 'function')
                ? findInvalidContainers().length : null;
            // markPatched sets data-fav-fix-marked (NOT data-fav-fix-patched).
            // patchCover sets data-fav-fix-original on the <img>. Count both
            // so a partial patch (cover only / mark only) is visible.
            var cardsMarked = document.querySelectorAll('[data-fav-fix-marked]').length;
            var coversPatched = document.querySelectorAll('img[data-fav-fix-original]').length;
            // cardsLoading: in-flight cards still showing the orange "处理中"
            // badge. Should drop to 0 once patchOnce settles; if it stays >0
            // across multiple stats() calls, a hit is leaking past clearLoading.
            var cardsLoading = document.querySelectorAll('[data-fav-fix-loading]').length;
            return {
                version: CORE_VERSION,
                authMode: getAuth().mode,
                hasAccessKey: !!getAuth().access_key,
                pageCacheSize: pageCache ? pageCache.size : null,
                itemCacheSize: pageItems ? pageItems.size : null,
                cardsInDom: cardCount,
                invalidDetectedNow: invalidNow,
                coversPatched: coversPatched,
                cardsMarked: cardsMarked,
                cardsLoading: cardsLoading,
                sourceBackoff: sourceFailureGate.snapshot()
            };
        },
        // listSources() — quick "which sources are enabled, of what kind"
        listSources: function () {
            return Object.keys(SOURCES).map(function (k) {
                var s = SOURCES[k];
                // s.enabled is a function (not a bool) — invoke it so the
                // JSON dump shows true/false instead of '{}'.
                var enabledNow;
                try { enabledNow = !!s.enabled(); } catch (e) { enabledNow = 'threw: ' + e.message; }
                return {
                    name: k,
                    enabled: enabledNow,
                    kind: s.paginated ? 'paginated' : 'per-av'
                };
            });
        },

        // --- actions ---
        clearAuth: clearAuth,
        clearAllItemCache: clearAllItemCache,
        clearItemCache: clearItemCache,
        resolveItems: resolveItems,
        ensurePage: ensurePage,
        detectMediaId: detectMediaId,
        // Manually drive a background android flap-recovery pass for a set of
        // avs (loop-until-dry; see runFlapRecovery). Useful for verifying the
        // recovery path, e.g.:
        //   __biliFavFix.runFlapRecovery(__biliFavFix.detectMediaId(), ['12345'])
        // No-op if another pass is already running.
        runFlapRecovery: runFlapRecovery,
        // DOM-layer internals, exposed for diagnostics/verification (same
        // spirit as resolveItems/ensurePage above): inspect what the scanner
        // detects and drive a single card's patch in isolation.
        findInvalidContainers: findInvalidContainers,
        applyPatch: applyPatch,
        patchTitle: patchTitle,
        patchNow: function () { pageCache.clear(); pageItems.clear(); return patchOnce(); },
        // forceRefetch(avOrBv) — drop cache for one av and re-run patch
        forceRefetch: function (avOrBv) {
            var av = String(avOrBv);
            if (/^BV/i.test(av)) av = bvToAv(av);
            // dropItemCaches, not bare clearItemCache: also flush the in-memory
            // raw rows + page promises, otherwise patchOnce re-merges the same
            // stale rows and re-saves them — no real refetch happens in-session.
            dropItemCaches(av);
            return patchOnce();
        },
        // Manual IndexedDB backup (15a-backup.js). run() walks the current
        // folder and stores metadata + cover Blobs; status() reports item
        // count, cover bytes, browser quota and this folder's last run.
        // manage() opens the in-page browse/delete panel (15b-backup-manage.js).
        // Same trio the Tampermonkey menu commands drive, exposed here so the
        // whole flow can be verified from the console.
        backup: { run: backupCurrentFolder, status: backupStatus, manage: openBackupManager },
        // Missing-item recovery (task #15): inspection + manual trigger
        fetchAllAvList: fetchAllAvList,
        fetchFullPhase1Avs: fetchFullPhase1Avs,
        detectMissing: function () {
            var mid = detectMediaId();
            if (!mid) throw new Error('not on a fav page (no mediaId)');
            _idsListCache.delete(mid);
            _phase1AvsCache.delete(mid);
            _missingBannerShown.delete(mid);
            return detectMissingAndRender(mid);
        },

        // --- utilities ---
        md5: md5,
        signParams: signParams,
        bvToAv: bvToAv,
        avToBv: avToBv,

        help: function () {
            console.log([
                '__biliFavFix.VERSION              core version (' + CORE_VERSION + ')',
                '__biliFavFix.stats()              quick health: auth / cache / DOM counts',
                '__biliFavFix.listSources()        which sources are enabled, what kind',
                '__biliFavFix.cache                live pages + items Maps',
                '__biliFavFix.getAuth()            { mode, hasAccessKey, ageDays } (key redacted)',
                '__biliFavFix.patchNow()           drop caches and re-scan DOM',
                '__biliFavFix.forceRefetch(bvOrAv) drop one item cache + re-patch',
                '__biliFavFix.backup.run()         back up this folder (metadata + covers) to IndexedDB',
                '__biliFavFix.backup.status()      backup size / covers / quota / last run here',
                '__biliFavFix.backup.manage()      open the backup manager panel (browse / delete)',
                '__biliFavFix.clearAllItemCache()  nuke all per-item GM storage (backup DB untouched)',
                '__biliFavFix.clearAuth()          drop access_key',
                '__biliFavFix.bvToAv(bv) / avToBv(av)'
            ].join('\n'));
        }
    };

    console.info('[fav-fix] core ' + CORE_VERSION + ' ready · type __biliFavFix.help() for commands');
})();
