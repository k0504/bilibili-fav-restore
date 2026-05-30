    // ─── Constants ──────────────────────────────────────────────────────

    var TV_APPKEY  = '4409e2ce8ffd12b8';
    var TV_APPSEC  = '59b43e04ad6965f34319062b478f83dd';
    var AND_APPKEY = '1d8b6e7d45233436';
    var AND_APPSEC = '560c52ccd288fed045859ed18bffd973';

    // The global "video deleted" cover placeholder. All invalid items the
    // web API returns share this image (filename starts with `be27fd62`).
    var PLACEHOLDER_COVER_TOKEN = 'be27fd62';
    var INVALID_TITLE = '已失效视频';

    // Max pages walked for ANY full-collection traversal (ps=20 → this×20
    // items). Single source of truth for three call sites that previously
    // used 20/20/30 inconsistently:
    //   - phase-1 resolver + flap retry: the 20-page cap silently degraded
    //     invalid-card recovery past item #400 (av only reachable on a
    //     later page never resolved via paginated sources).
    //   - fetchFullPhase1Avs (missing-item baseline): the fixed 30-page cap
    //     made the >600-item case falsely report its tail as "silently
    //     dropped" because the diff compared the FULL ids list against a
    //     truncated walk. Now the walk also reports whether it reached a
    //     natural has_more=false end (see fetchFullPhase1Avs `complete`),
    //     and the banner only renders when it did.
    // 50 pages = 1000 items covers the overwhelming majority of real
    // collections; larger ones skip the (unreliable) missing banner rather
    // than emit a false positive.
    var MAX_PAGE_WALK = 50;

    // ─── Android flap recovery (background) ─────────────────────────────
    // The android fav endpoint is eventually-consistent: ~5% of invalid
    // items drop in/out across consecutive walks (same access_key, same
    // mediaId, seconds apart — confirmed by a 3-walk diagnostic returning
    // 888 / 879 / 887 of a claimed 923). Crucially the drop is NOT uniform:
    // deactivated-account / short-legacy-aid items are 7.6x over-represented,
    // so the stubborn subset misses far more than 5% per walk. A single extra
    // walk only recovers the easy half. The statistically-correct fix is to
    // UNION several INDEPENDENT walks — each walk is a fresh server sample, so
    // P(still missing after N) ≈ (per-walk miss)^N.
    //
    // ONE background loop (runFlapRecovery in 08-resolver.js) owns the ENTIRE
    // retry lifecycle for a folder — it is the SOLE retry path. No cache-TTL
    // timer, no scroll-to-retry: the loop re-walks android on an ADAPTIVE
    // backoff and live-patches each recovered card until everything recovers
    // or it gives up. The cadence AND the give-up are driven by one counter:
    //   - recovered ≥1 this walk → dry resets to 0 → sample again fast
    //   - recovered  0 this walk → dry++           → wait longer next walk
    // So while items keep flapping back it samples quickly; once recoveries
    // dry up it eases off and finally stops (dry === FLAP_MAX_DRY). This makes
    // a still-flapping folder converge fast while a genuinely-deleted set is
    // abandoned after ~7 cheap samples instead of being hammered.
    var FLAP_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000, 60000, 120000];
    //   Delay BEFORE the next walk, indexed by the current dry count (clamped
    //   to the last entry). Front-loaded burst (1-5s) catches seconds-level
    //   flapping; the tail widens to a gentle 2-min cadence for stubborn items.
    var FLAP_MAX_DRY        = 7;                  // give up after this many consecutive 0-recovery walks
    var FLAP_TIME_BUDGET_MS = 30 * 60 * 1000;     // 30-min overall hard ceiling (active-recovery backstop)

    // One bilibili fav "card" across the modern + legacy layouts. Single
    // source of truth shared by findInvalidContainers Strategy 2 (scope the
    // title-text scan to cards instead of the whole document) and stats()
    // (card count). If bilibili ships a new card class, add it HERE once and
    // both consumers pick it up. (Strategy 1's placeholder-img scan is
    // class-independent, so a missing class here at worst loses the SVG-
    // placeholder fallback for that layout, not the common <img> path.)
    var CARD_SELECTOR = '.bili-video-card, .fav-video-card, .small-item';

    // Settings (overridable via menu commands).
    var DEBUG = !!GM_getValue('debug', false);

    function log() {
        if (!DEBUG) return;
        var args = ['[fav-fix]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }
    function warn() {
        var args = ['[fav-fix]'].concat(Array.prototype.slice.call(arguments));
        console.warn.apply(console, args);
    }

