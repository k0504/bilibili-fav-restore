/* bilibili-fav-list-fix-core.js
 *
 * Loaded by bilibili-fav-list-fix.user.js bootstrap. Runs in the userscript
 * ISOLATED world (inherits GM_* APIs from the stub's @grant block).
 *
 * What it does:
 *   1. Detects bilibili web favorites pages (space.bilibili.com/{mid}/favlist
 *      OR www.bilibili.com/list/ml{media_id}).
 *   2. Walks the rendered list looking for items whose cover is the global
 *      "video deleted" placeholder (filename starts with `be27fd62…`) OR
 *      whose title is exactly "已失效视频".
 *   3. Calls /x/v3/fav/folder/resources with Android-app signing — that
 *      endpoint returns the ORIGINAL cover/title for invalid items
 *      (verified by capturing the genuine Android app via emulator + mitm).
 *   4. Patches the DOM: replaces the placeholder cover img src and the
 *      "已失效视频" title text with the real values, and overlays a small
 *      badge so the user knows the item is still invalid (just shown with
 *      its original metadata).
 *
 * Auth: TV QR login on first use (one scan via the bilibili mobile app,
 * access_key cached ~30 days). Manual access_key override available via
 * the Tampermonkey menu for users who already captured one another way.
 *
 * Caveat: the Android-main-app appkey (1d8b6e7d45233436) was the one
 * verified to return is_invalid + real cover. TV QR login issues an
 * access_key bound to the TV appkey (4409e2ce8ffd12b8). The same endpoint
 * with TV signing usually returns the same fields — but if you find it
 * silently strips invalid items, switch to manual mode and paste an
 * Android-app access_key (captured from the real app).
 */

(function () {
    'use strict';

    // Bump on every meaningful change so `__biliFavFix.VERSION` in DevTools
    // is a reliable "is this the version I just edited?" check. Same idea
    // as dl-manager's CORE_VERSION — see userscripts/bilibili/src/main.js.
    var CORE_VERSION = '0.8.17';

    // Pick the page-world window so `__biliFavFix` is reachable from
    // DevTools F12 console (which evaluates in page world). Without
    // unsafeWindow, the assignment goes to the userscript ISOLATED-world
    // window and `window.__biliFavFix` from DevTools returns undefined —
    // exactly the symptom that confused us for an hour. dl-manager uses
    // the same `typeof unsafeWindow !== 'undefined' ? unsafeWindow : window`
    // pattern (see bilibili-core.user.js:3560).
    var pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    if (pageWin.__biliFavFixLoaded) {
        console.warn('[fav-fix] already loaded — skipping (existing version: '
                     + (pageWin.__biliFavFix && pageWin.__biliFavFix.VERSION) + ')');
        return;
    }
    pageWin.__biliFavFixLoaded = true;
    pageWin.__biliFavFixVersion = CORE_VERSION;

