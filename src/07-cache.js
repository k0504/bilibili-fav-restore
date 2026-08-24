    // ─── Persistent per-avid cache ──────────────────────────────────────
    //
    // CACHE_VERSION exists so that adding a new source (or changing merge
    // semantics) can invalidate every cached entry at once — otherwise
    // items cached before the new source was added would never get the
    // chance to be re-fetched from it.
    //
    // BUMP CACHE_VERSION when:
    //   - adding a new SOURCES entry
    //   - changing FIELD_PRIORITY / QUALITY in a way that affects merge
    //   - changing the merged-item shape (renaming fields etc.)

    var CACHE_PREFIX  = 'item:av';
    var CACHE_VERSION = 6;   // bumped: +SOURCES.backup (IndexedDB snapshots lead FIELD_PRIORITY)
    var CACHE_TTL_MS  = 1000 * 60 * 60 * 24 * 30;   // 30 days
    // Short TTL for NOT-confidently-recovered merges (_degenerate / _pending).
    // This is a STALENESS guard, NOT a retry timer: live retry is owned wholly
    // by the background runFlapRecovery loop (08-resolver.js), which re-walks
    // android on its own backoff and re-patches in place. The short TTL only
    // governs what a FUTURE fresh resolve (a reload / folder-switch minutes or
    // hours later) does — after it expires, that fresh resolve re-fetches and
    // re-kicks the loop instead of reusing a stale "still deleted" snapshot.
    // A 30-day lock-in would instead turn one bad android walk into a permanent
    // failure, so these stay short.
    var CACHE_TTL_DEGENERATE_MS = 1000 * 60 * 10;   // 10 min

    function loadCache(av) {
        var v = GM_getValue(CACHE_PREFIX + av, null);
        if (!v) return null;
        if (v._cache_version !== CACHE_VERSION) {
            log('cache av', av, 'version', v._cache_version, '!=', CACHE_VERSION, '— invalidating');
            return null;
        }
        // Short TTL for any NOT-confidently-recovered entry:
        //   _degenerate    — some source returned only placeholders, or
        //   _pending       — android may still flap the real snapshot back in
        //                    (see runFlapRecovery in 08-resolver.js), or
        //   _cover_pending — the title was recovered but the cover is still a
        //                    placeholder; the card is patched, yet the flap
        //                    loop is still chasing the image. Long-TTL locking
        //                    here is what a title-only LOCAL BACKUP record
        //                    (which never expires) would otherwise impose on
        //                    every future resolve of that av.
        // Locking these for 30 days would turn a transient android walk-to-walk
        // drop into a permanent "deleted" (observed: a war-footage folder where
        // android returned 58/89 on one walk and the dropped items all fell to
        // _no_source). Only a confidently-recovered merge gets the long TTL.
        var ttl = (v._degenerate || v._pending || v._cover_pending)
                ? CACHE_TTL_DEGENERATE_MS : CACHE_TTL_MS;
        if (v._cached_at && (Date.now() - v._cached_at > ttl)) return null;
        return v;
    }
    function saveCache(av, merged) {
        merged._cache_version = CACHE_VERSION;
        merged._cached_at = Date.now();
        try { GM_setValue(CACHE_PREFIX + av, merged); }
        catch (e) { warn('saveCache failed for av', av, e); }
    }
    // Note for anyone extending the clearing paths below: they clear DERIVED
    // data (re-fetchable merges) only. The IndexedDB backup store
    // (15a-backup.js) is user-authored data with no upstream to re-fetch from
    // and must NEVER be dropped here.
    function clearItemCache(av) { GM_deleteValue(CACHE_PREFIX + av); }
    function clearAllItemCache() {
        if (typeof GM_listValues !== 'function') {
            warn('GM_listValues not granted — bulk clear unavailable');
            return -1;
        }
        var n = 0;
        GM_listValues().forEach(function (k) {
            if (k.indexOf(CACHE_PREFIX) === 0) { GM_deleteValue(k); n++; }
        });
        return n;
    }

