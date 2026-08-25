    // ─── "Stop retrying" list (user decision, deliberately NOT cache) ────
    //
    // Why this is its own GM prefix instead of a field on the item cache:
    // the item cache (07-cache.js, `item:av…`) holds DERIVED data — every entry
    // is re-fetchable, carries a TTL, and the "清除所有缓存" menu command wipes
    // the lot. A user's decision to stop retrying a video is none of those
    // things: it has to outlive the cache, survive a cache purge, and take
    // effect the instant the badge is clicked instead of when the snapshot next
    // expires. So it lives under its own prefix, is held in memory as a Set/Map
    // for O(1) render-time lookups, and is read LIVE everywhere — the cached
    // merge shape and CACHE_VERSION are untouched by this feature.
    //
    // Two modes, at most one record per av:
    //   'user' — the user pressed 停止重试. Never expires.
    //   'auto' — runFlapRecovery genuinely gave up on this av. Expires after
    //            the auto TTL, so a folder that merely flapped badly for
    //            one afternoon is not written off permanently.
    // 'user' overwrites 'auto'; 'auto' must NEVER overwrite 'user' (that would
    // silently downgrade a permanent decision into one expiring in a week).
    //
    // Which predicate to use where:
    //   isRetrySuppressed — every AUTOMATIC path (does resolveItems walk pages,
    //                       does the background loop arm itself). Honours both
    //                       modes.
    //   isNoRetryUser     — everything the user explicitly triggered (manual
    //                       retry, the loop's in-flight pruning). Honours the
    //                       'user' mode only, because a manual retry means
    //                       "ignore what the loop concluded and sample again".
    //
    // No new GM_* API is introduced: GM_getValue / GM_setValue / GM_deleteValue
    // / GM_listValues are all already in the bootstrap @grant block. In
    // particular GM_addValueChangeListener is NOT granted and the bootstrap
    // @version is frozen at 1.0.0 (it is a contract — see AGENTS.md), so this
    // list does NOT sync across tabs: a stop pressed in tab A is visible in
    // tab B only after a reload. That limit is documented in README 已知限制;
    // do not try to work around it here.

    var NORETRY_PREFIX      = 'noretry:av';
    // → cfg('autoNoRetryTtlDays'), default 7. Read through autoNoRetryTtlMs()
    // rather than inlined, because three call sites need the same conversion.
    function autoNoRetryTtlMs() { return cfg('autoNoRetryTtlDays') * 86400000; }

    var _noRetryUser   = new Map();   // av → ms the user pressed stop (permanent)
    var _noRetryAuto   = new Map();   // av → ms the loop gave up (7-day life)
    var _noRetryLoaded = false;

    // Build the in-memory index from GM storage once per page load, dropping
    // auto records that have aged out on the way through so the store cannot
    // grow without bound. Idempotent via _noRetryLoaded: boot() calls it once,
    // and every accessor below calls it too, so a future change to boot order
    // can never leave the list silently empty.
    function loadNoRetryIndex() {
        if (_noRetryLoaded) return;
        _noRetryLoaded = true;
        if (typeof GM_listValues !== 'function') {
            // Same degradation as clearAllItemCache: warn and carry on with an
            // empty list. Losing the feature is acceptable; throwing here would
            // take boot() — and with it the whole resolve path — down with it.
            warn('GM_listValues not granted — 停止重试 list unavailable');
            return;
        }
        var now = Date.now(), expired = 0;
        GM_listValues().forEach(function (k) {
            if (k.indexOf(NORETRY_PREFIX) !== 0) return;
            var av = k.slice(NORETRY_PREFIX.length);
            var v = GM_getValue(k, null);
            // Unreadable / shapeless record: drop it rather than guessing a
            // mode, otherwise a corrupt entry suppresses an av forever with no
            // way for the UI to show or clear it.
            if (!v || (v.mode !== 'user' && v.mode !== 'auto')) { GM_deleteValue(k); return; }
            if (v.mode === 'user') { _noRetryUser.set(av, v.at || 0); return; }
            if (now - (v.at || 0) > autoNoRetryTtlMs()) { GM_deleteValue(k); expired++; return; }
            _noRetryAuto.set(av, v.at || 0);
        });
        log('noretry: loaded', _noRetryUser.size, 'user +', _noRetryAuto.size,
            'auto record(s)' + (expired ? ' (' + expired + ' expired auto dropped)' : ''));
    }

    // Manual, permanent stop. The card menu and the cover badge both ask this.
    function isNoRetryUser(av) {
        loadNoRetryIndex();
        return _noRetryUser.has(String(av));
    }

    // When the user stopped this av, in ms — the tooltip prints it as
    // 「已于 YYYY-MM-DD 停止」. null when the av is not on the user list, or
    // when the record predates the timestamp being written.
    function noRetryUserAt(av) {
        loadNoRetryIndex();
        return _noRetryUser.get(String(av)) || null;
    }

    // The gate for automatic network work: a manual stop, or an auto record the
    // loop wrote less than autoNoRetryTtlMs() ago. Expired auto records are
    // cleared on the spot so the storage entry disappears with the suppression.
    function isRetrySuppressed(av) {
        loadNoRetryIndex();
        av = String(av);
        if (_noRetryUser.has(av)) return true;
        var at = _noRetryAuto.get(av);
        if (at == null) return false;
        if (Date.now() - at > autoNoRetryTtlMs()) { clearNoRetry(av); return false; }
        return true;
    }

    function setNoRetryUser(av) {
        loadNoRetryIndex();
        av = String(av);
        var at = Date.now();
        _noRetryUser.set(av, at);
        _noRetryAuto.delete(av);   // one record per av: user supersedes auto
        try { GM_setValue(NORETRY_PREFIX + av, { at: at, mode: 'user' }); }
        catch (e) { warn('setNoRetryUser failed for av', av, e); }
    }

    // Written by runFlapRecovery when it truly gives up (see its finally). A
    // pre-existing user record outranks it and must survive untouched.
    function markAutoNoRetry(av) {
        loadNoRetryIndex();
        av = String(av);
        if (_noRetryUser.has(av)) return;
        var at = Date.now();
        _noRetryAuto.set(av, at);
        try { GM_setValue(NORETRY_PREFIX + av, { at: at, mode: 'auto' }); }
        catch (e) { warn('markAutoNoRetry failed for av', av, e); }
    }

    function clearNoRetry(av) {
        loadNoRetryIndex();
        av = String(av);
        _noRetryUser.delete(av);
        _noRetryAuto.delete(av);
        GM_deleteValue(NORETRY_PREFIX + av);
    }

    // Returns what was cleared, so the menu command can report both modes.
    function clearAllNoRetry() {
        loadNoRetryIndex();
        var counts = { user: _noRetryUser.size, auto: _noRetryAuto.size };
        _noRetryUser.forEach(function (at, av) { GM_deleteValue(NORETRY_PREFIX + av); });
        _noRetryAuto.forEach(function (at, av) { GM_deleteValue(NORETRY_PREFIX + av); });
        _noRetryUser.clear();
        _noRetryAuto.clear();
        return counts;
    }

    function noRetryCounts() {
        loadNoRetryIndex();
        return { user: _noRetryUser.size, auto: _noRetryAuto.size };
    }

    // Flat dump for the debug surface (__biliFavFix.noRetry.list()).
    function noRetryList() {
        loadNoRetryIndex();
        var out = [];
        _noRetryUser.forEach(function (at, av) {
            out.push({ av: av, mode: 'user', at: at, when: at ? new Date(at).toLocaleString() : null });
        });
        _noRetryAuto.forEach(function (at, av) {
            out.push({ av: av, mode: 'auto', at: at, when: at ? new Date(at).toLocaleString() : null,
                       expiresAt: at ? new Date(at + autoNoRetryTtlMs()).toLocaleString() : null });
        });
        return out;
    }

