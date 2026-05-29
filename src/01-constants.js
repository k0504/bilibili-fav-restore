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

