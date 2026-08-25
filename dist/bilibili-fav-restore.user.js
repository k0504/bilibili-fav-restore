// ==UserScript==
// @name         Bilibili 收藏夹失效视频信息还原
// @name:zh-TW   Bilibili 收藏夾失效影片資訊還原
// @name:en      Bilibili Fav Restore
// @namespace    https://github.com/k0504/bilibili-fav-restore
// @version      0.14.3
// @description  在 bilibili 网页版收藏夹页面，自动还原失效（已删除 / UP 自删）视频的原始封面、标题与 metadata。
// @description:zh-TW  在 bilibili 網頁版收藏夾頁面，自動還原失效（已刪除 / UP 自刪）影片的原始封面、標題與 metadata。
// @description:en  Restore original cover/title/metadata of invalid (deleted) videos on bilibili web favorites pages.
// @author       k0504
// @homepageURL  https://github.com/k0504/bilibili-fav-restore
// @supportURL   https://github.com/k0504/bilibili-fav-restore/issues
// @updateURL    https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js
// @downloadURL  https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/medialist/*
// @match        https://www.bilibili.com/favlist*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @connect      api.bilibili.com
// @connect      passport.bilibili.com
// @connect      hdslb.com
// @connect      biliplus.com
// @connect      jijidown.com
// @license      MIT
// ==/UserScript==

/*
 * AUTO-GENERATED — do not edit by hand.
 * Source: src/*.js assembled by bundle.py (CORE_VERSION = 0.14.3)
 * @match/@grant/@connect parsed from bilibili-fav-list-fix.user.js.
 * Regenerate with: python build.py
 *
 * For dev workflow (edit core + reload tab without rebuilding) see
 * README "Development" section — uses bilibili-fav-list-fix.user.js
 * (bootstrap) + serve.py instead.
 */
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
    var CORE_VERSION = '0.14.3';

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

    // Missing-item banner baseline (fetchFullPhase1Avs in 13-missing.js). The
    // "静默丢弃 N 项" count = (ids inventory) MINUS (what the paginated source
    // actually returned). When that source is android, a SINGLE walk drops a
    // large, VARIABLE fraction to flap (observed 42/89 = 47% on one walk), so a
    // one-walk baseline falsely flags those as dropped and inflates N. UNION
    // independent android walks until the union STOPS GROWING — an item only
    // counts dropped if EVERY walk missed it. A fixed walk count is fragile
    // (flap rate varies per folder/moment: too few → over-report, too many →
    // wasted load), so converge like runFlapRecovery instead: keep walking
    // until MISSING_DRY_ROUNDS consecutive walks add 0 new avs (union saturated),
    // capped at MISSING_MAX_WALKS. public is stable → one walk.
    var MISSING_DRY_ROUNDS = 2;   // union saturated after this many 0-new walks
    var MISSING_MAX_WALKS  = 8;   // hard backstop on android union walks

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

    // ─── MD5 (RFC 1321, compact public-domain implementation) ───────────
    // Source: blueimp-md5 (https://github.com/blueimp/JavaScript-MD5),
    // MIT-licensed. Minified inline so the core stays single-file.
    var md5 = (function () {
        function safeAdd(x, y) {
            var lsw = (x & 0xffff) + (y & 0xffff);
            var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
            return (msw << 16) | (lsw & 0xffff);
        }
        function bitRol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
        function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
        function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
        function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
        function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
        function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }
        function binlMD5(x, len) {
            x[len >> 5] |= 0x80 << (len % 32);
            x[(((len + 64) >>> 9) << 4) + 14] = len;
            var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
            for (var i = 0; i < x.length; i += 16) {
                var oa = a, ob = b, oc = c, od = d;
                a = md5ff(a, b, c, d, x[i],     7,  -680876936);
                d = md5ff(d, a, b, c, x[i+1],  12,  -389564586);
                c = md5ff(c, d, a, b, x[i+2],  17,   606105819);
                b = md5ff(b, c, d, a, x[i+3],  22, -1044525330);
                a = md5ff(a, b, c, d, x[i+4],   7,  -176418897);
                d = md5ff(d, a, b, c, x[i+5],  12,  1200080426);
                c = md5ff(c, d, a, b, x[i+6],  17, -1473231341);
                b = md5ff(b, c, d, a, x[i+7],  22,   -45705983);
                a = md5ff(a, b, c, d, x[i+8],   7,  1770035416);
                d = md5ff(d, a, b, c, x[i+9],  12, -1958414417);
                c = md5ff(c, d, a, b, x[i+10], 17,      -42063);
                b = md5ff(b, c, d, a, x[i+11], 22, -1990404162);
                a = md5ff(a, b, c, d, x[i+12],  7,  1804603682);
                d = md5ff(d, a, b, c, x[i+13], 12,   -40341101);
                c = md5ff(c, d, a, b, x[i+14], 17, -1502002290);
                b = md5ff(b, c, d, a, x[i+15], 22,  1236535329);
                a = md5gg(a, b, c, d, x[i+1],   5,  -165796510);
                d = md5gg(d, a, b, c, x[i+6],   9, -1069501632);
                c = md5gg(c, d, a, b, x[i+11], 14,   643717713);
                b = md5gg(b, c, d, a, x[i],    20,  -373897302);
                a = md5gg(a, b, c, d, x[i+5],   5,  -701558691);
                d = md5gg(d, a, b, c, x[i+10],  9,    38016083);
                c = md5gg(c, d, a, b, x[i+15], 14,  -660478335);
                b = md5gg(b, c, d, a, x[i+4],  20,  -405537848);
                a = md5gg(a, b, c, d, x[i+9],   5,   568446438);
                d = md5gg(d, a, b, c, x[i+14],  9, -1019803690);
                c = md5gg(c, d, a, b, x[i+3],  14,  -187363961);
                b = md5gg(b, c, d, a, x[i+8],  20,  1163531501);
                a = md5gg(a, b, c, d, x[i+13],  5, -1444681467);
                d = md5gg(d, a, b, c, x[i+2],   9,   -51403784);
                c = md5gg(c, d, a, b, x[i+7],  14,  1735328473);
                b = md5gg(b, c, d, a, x[i+12], 20, -1926607734);
                a = md5hh(a, b, c, d, x[i+5],   4,     -378558);
                d = md5hh(d, a, b, c, x[i+8],  11, -2022574463);
                c = md5hh(c, d, a, b, x[i+11], 16,  1839030562);
                b = md5hh(b, c, d, a, x[i+14], 23,   -35309556);
                a = md5hh(a, b, c, d, x[i+1],   4, -1530992060);
                d = md5hh(d, a, b, c, x[i+4],  11,  1272893353);
                c = md5hh(c, d, a, b, x[i+7],  16,  -155497632);
                b = md5hh(b, c, d, a, x[i+10], 23, -1094730640);
                a = md5hh(a, b, c, d, x[i+13],  4,   681279174);
                d = md5hh(d, a, b, c, x[i],    11,  -358537222);
                c = md5hh(c, d, a, b, x[i+3],  16,  -722521979);
                b = md5hh(b, c, d, a, x[i+6],  23,    76029189);
                a = md5hh(a, b, c, d, x[i+9],   4,  -640364487);
                d = md5hh(d, a, b, c, x[i+12], 11,  -421815835);
                c = md5hh(c, d, a, b, x[i+15], 16,   530742520);
                b = md5hh(b, c, d, a, x[i+2],  23,  -995338651);
                a = md5ii(a, b, c, d, x[i],     6,  -198630844);
                d = md5ii(d, a, b, c, x[i+7],  10,  1126891415);
                c = md5ii(c, d, a, b, x[i+14], 15, -1416354905);
                b = md5ii(b, c, d, a, x[i+5],  21,   -57434055);
                a = md5ii(a, b, c, d, x[i+12],  6,  1700485571);
                d = md5ii(d, a, b, c, x[i+3],  10, -1894986606);
                c = md5ii(c, d, a, b, x[i+10], 15,    -1051523);
                b = md5ii(b, c, d, a, x[i+1],  21, -2054922799);
                a = md5ii(a, b, c, d, x[i+8],   6,  1873313359);
                d = md5ii(d, a, b, c, x[i+15], 10,   -30611744);
                c = md5ii(c, d, a, b, x[i+6],  15, -1560198380);
                b = md5ii(b, c, d, a, x[i+13], 21,  1309151649);
                a = md5ii(a, b, c, d, x[i+4],   6,  -145523070);
                d = md5ii(d, a, b, c, x[i+11], 10, -1120210379);
                c = md5ii(c, d, a, b, x[i+2],  15,   718787259);
                b = md5ii(b, c, d, a, x[i+9],  21,  -343485551);
                a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
            }
            return [a, b, c, d];
        }
        function binl2rstr(input) {
            var out = '';
            for (var i = 0; i < input.length * 32; i += 8) {
                out += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff);
            }
            return out;
        }
        function rstr2binl(input) {
            var out = [];
            out[(input.length >> 2) - 1] = undefined;
            for (var i = 0; i < out.length; i += 1) out[i] = 0;
            for (var j = 0; j < input.length * 8; j += 8) {
                out[j >> 5] |= (input.charCodeAt(j / 8) & 0xff) << (j % 32);
            }
            return out;
        }
        function rstrMD5(s) { return binl2rstr(binlMD5(rstr2binl(s), s.length * 8)); }
        function rstr2hex(input) {
            var hexTab = '0123456789abcdef', out = '', x;
            for (var i = 0; i < input.length; i += 1) {
                x = input.charCodeAt(i);
                out += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f);
            }
            return out;
        }
        function str2rstrUTF8(input) {
            return unescape(encodeURIComponent(input));
        }
        return function (s) { return rstr2hex(rstrMD5(str2rstrUTF8(s))); };
    })();

    // ─── Signing ────────────────────────────────────────────────────────

    function signParams(params, appsec) {
        var keys = Object.keys(params).sort();
        var q = keys.map(function (k) { return k + '=' + params[k]; }).join('&');
        var out = {};
        for (var i = 0; i < keys.length; i++) out[keys[i]] = params[keys[i]];
        out.sign = md5(q + appsec);
        return out;
    }

    function toQuery(p) {
        return Object.keys(p).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]);
        }).join('&');
    }

    // ─── HTTP wrapper ──────────────────────────────────────────────────

    function gmGet(url, opts) {
        opts = opts || {};
        var timeoutMs = opts.timeout || 15000;
        // GM_xmlhttpRequest's `timeout` field is unreliable for connections
        // that stall mid-handshake (no FIN/RST ever sent — e.g. biliplus
        // when its server is overloaded). The `ontimeout` callback simply
        // never fires and the request hangs forever. Wrap with a client-side
        // Promise.race so caller-supplied budgets are HARD. Live request
        // continues in the background after we reject (no way to cancel
        // GM_xmlhttpRequest cleanly across all TM versions), but that's
        // acceptable for best-effort fallback sources.
        var underlying = new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: url,
                data: opts.data,
                headers: opts.headers || { 'User-Agent': 'Mozilla/5.0 BiliDroid/8.94.0' },
                timeout: timeoutMs,
                onload: function (resp) {
                    var text = resp.responseText;
                    // Some responses arrive with no text body — an empty 204,
                    // an opaque/blocked response, or a GM build that leaves
                    // responseText undefined for certain statuses. Guard
                    // BEFORE JSON.parse AND before building the error string:
                    // the old code did `resp.responseText.slice(0, 200)` inside
                    // the parse-failure catch, which itself threw a TypeError
                    // when responseText was undefined. That throw escaped as an
                    // *uncaught* error in GM's onload (reject was never reached),
                    // so the promise never rejected — it hung until the
                    // client-side guard fired timeoutMs+500 later. Turn it into
                    // a clean rejection the caller's .catch already handles.
                    if (typeof text !== 'string') {
                        reject(new Error('empty/non-text response (status=' + resp.status + '): ' + url));
                        return;
                    }
                    try { resolve(JSON.parse(text)); }
                    catch (e) { reject(new Error('JSON parse failed: ' + e.message + ' body=' + text.slice(0, 200))); }
                },
                onerror: function () { reject(new Error('network error: ' + url)); },
                ontimeout: function () { reject(new Error('timeout: ' + url)); }
            });
        });
        // Pad client-side guard by 500ms so the underlying GM timer wins
        // for legitimate timeouts (cleaner error message), and we only
        // catch the pathological stall case. Clear the guard once the race
        // settles so a successful request doesn't leave a live timer pending
        // for timeoutMs+500 (every call would otherwise leak one).
        var guardTimer = null;
        var guard = new Promise(function (_, rej) {
            guardTimer = setTimeout(function () {
                rej(new Error('client-side timeout (' + timeoutMs + 'ms+500): ' + url));
            }, timeoutMs + 500);
        });
        return Promise.race([underlying, guard]).finally(function () {
            if (guardTimer) clearTimeout(guardTimer);
        });
    }

    // Binary sibling of gmGet, for the manual backup (15a-backup.js): pulls a
    // cover image straight into a Blob so it can be stored in IndexedDB. Kept
    // as a separate function rather than a flag on gmGet because gmGet's whole
    // contract is "resolves to parsed JSON" and every caller depends on it.
    // Same client-side Promise.race guard, same reason (GM's own `timeout`
    // never fires on a connection that stalls mid-handshake).
    function gmGetBlob(url, opts) {
        opts = opts || {};
        var timeoutMs = opts.timeout || 10000;
        var underlying = new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                // hdslb serves covers without a Referer check today, but send
                // one anyway — a hotlink guard would otherwise turn every
                // backup into "封面失败 N".
                headers: opts.headers || { 'Referer': 'https://www.bilibili.com/' },
                timeout: timeoutMs,
                onload: function (resp) {
                    if (resp.status && (resp.status < 200 || resp.status >= 300)) {
                        reject(new Error('HTTP ' + resp.status + ': ' + url));
                        return;
                    }
                    var b = resp.response;
                    // Duck-typed, NOT `instanceof Blob`: the Blob is minted in
                    // the GM sandbox realm, whose Blob constructor is not
                    // necessarily the one visible here — instanceof can be
                    // false for a perfectly good Blob.
                    if (!b || typeof b.size !== 'number' || !b.size) {
                        reject(new Error('empty/non-blob response (status=' + resp.status + '): ' + url));
                        return;
                    }
                    resolve(b);
                },
                onerror: function () { reject(new Error('network error: ' + url)); },
                ontimeout: function () { reject(new Error('timeout: ' + url)); }
            });
        });
        var guardTimer = null;
        var guard = new Promise(function (_, rej) {
            guardTimer = setTimeout(function () {
                rej(new Error('client-side timeout (' + timeoutMs + 'ms+500): ' + url));
            }, timeoutMs + 500);
        });
        return Promise.race([underlying, guard]).finally(function () {
            if (guardTimer) clearTimeout(guardTimer);
        });
    }

    function gmPostForm(url, body) {
        return gmGet(url, {
            method: 'POST',
            data: body,
            headers: {
                'User-Agent': 'Mozilla/5.0 BiliDroid/8.94.0',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
    }

    // ─── Auth storage ───────────────────────────────────────────────────
    // Supports two modes:
    //   mode='tv'      → use access_key issued via TV QR login (TV appkey signing)
    //   mode='android' → use a manually-pasted access_key + Android-main-app signing

    function getAuth() {
        return {
            mode: GM_getValue('auth_mode', 'tv'),
            access_key: GM_getValue('access_key', ''),
            ts: GM_getValue('access_key_ts', 0)
        };
    }
    function setAuth(mode, ak) {
        GM_setValue('auth_mode', mode);
        GM_setValue('access_key', ak);
        GM_setValue('access_key_ts', Date.now());
    }
    function clearAuth() {
        GM_deleteValue('access_key');
        GM_deleteValue('access_key_ts');
        // Also drop the mode so getAuth() falls back to its 'tv' default
        // after logout instead of retaining a stale 'android'/'tv' choice.
        GM_deleteValue('auth_mode');
    }

    function appkeyFor(mode) { return mode === 'android' ? AND_APPKEY : TV_APPKEY; }
    function appsecFor(mode) { return mode === 'android' ? AND_APPSEC : TV_APPSEC; }

    // ─── TV QR login ────────────────────────────────────────────────────

    function tvAuthCode() {
        var p = signParams({ appkey: TV_APPKEY, local_id: '0', ts: String(Math.floor(Date.now() / 1000)) }, TV_APPSEC);
        return gmPostForm('https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', toQuery(p));
    }
    function tvPoll(authCode) {
        var p = signParams({ appkey: TV_APPKEY, auth_code: authCode, local_id: '0', ts: String(Math.floor(Date.now() / 1000)) }, TV_APPSEC);
        return gmPostForm('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', toQuery(p));
    }

    function showQrModal(loginUrl, onClose) {
        // Tiny modal. Uses api.qrserver.com to render the QR — bilibili
        // doesn't ship a JS QR encoder and pulling one would double the
        // file. qrserver.com has been live since ~2014; if it ever dies,
        // swap in a JS encoder (e.g. davidshimjs/qrcodejs).
        var qr = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(loginUrl);
        var host = document.createElement('div');
        host.id = '__fav_fix_qr_host';
        host.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647',
            'display:flex', 'align-items:center', 'justify-content:center',
            'background:rgba(0,0,0,.45)',
            'font:14px/1.4 -apple-system,Segoe UI,sans-serif'
        ].join(';');
        host.innerHTML = ''
            + '<div style="background:#fff;border-radius:12px;padding:20px 24px;min-width:300px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center">'
            +   '<div style="font-weight:600;font-size:16px;margin-bottom:4px">扫码登录（TV 端授权）</div>'
            +   '<div style="color:#888;font-size:12px;margin-bottom:12px">请使用 bilibili 手机客户端的扫一扫功能</div>'
            +   '<img src="' + qr + '" style="display:block;margin:0 auto 12px;width:240px;height:240px" />'
            +   '<div id="__fav_fix_qr_status" style="color:#666;font-size:12px;margin-bottom:8px">等待扫描</div>'
            +   '<button id="__fav_fix_qr_close" style="border:0;background:#f4f4f4;padding:6px 16px;border-radius:6px;cursor:pointer">取消</button>'
            + '</div>';
        document.body.appendChild(host);
        host.querySelector('#__fav_fix_qr_close').addEventListener('click', function () { onClose('cancel'); });
        return host;
    }
    function setQrStatus(host, text) {
        var el = host && host.querySelector('#__fav_fix_qr_status');
        if (el) el.textContent = text;
    }
    function closeQr(host) { if (host && host.parentNode) host.parentNode.removeChild(host); }

    async function tvLogin() {
        toast('正在请求登录授权…');
        var ac;
        try { ac = await tvAuthCode(); }
        catch (e) { toast('授权请求失败：' + e.message, 'err'); return; }
        if (ac.code !== 0 || !ac.data || !ac.data.auth_code || !ac.data.url) {
            toast('授权响应异常：错误码 ' + ac.code + '，' + ac.message, 'err'); return;
        }
        var host = null, done = false;
        var promise = new Promise(function (resolve) {
            host = showQrModal(ac.data.url, function (reason) {
                done = true; closeQr(host); resolve({ ok: false, reason: reason });
            });
            // Poll every 2s for up to 3 minutes.
            var deadline = Date.now() + 180000;
            (function tick() {
                if (done) return;
                if (Date.now() > deadline) {
                    setQrStatus(host, '登录超时，请重新尝试');
                    setTimeout(function () { closeQr(host); resolve({ ok: false, reason: 'timeout' }); }, 1500);
                    return;
                }
                tvPoll(ac.data.auth_code).then(function (r) {
                    if (done) return;
                    if (r.code === 0 && r.data && r.data.access_token) {
                        done = true;
                        setAuth('tv', r.data.access_token);
                        setQrStatus(host, '登录成功');
                        setTimeout(function () { closeQr(host); resolve({ ok: true }); }, 800);
                        return;
                    }
                    // 86039 = waiting for scan; 86090 = scanned, waiting for confirm; 86038 = expired
                    if (r.code === 86090) setQrStatus(host, '已扫描，请在手机上确认登录');
                    else if (r.code === 86038) {
                        setQrStatus(host, '二维码已过期，请重新尝试');
                        setTimeout(function () { closeQr(host); resolve({ ok: false, reason: 'expired' }); }, 1500);
                        return;
                    }
                    setTimeout(tick, 2000);
                }).catch(function (e) {
                    warn('poll failed', e); setTimeout(tick, 2000);
                });
            })();
        });
        var res = await promise;
        if (res.ok) toast('登录成功，凭据已保存', 'ok');
        else toast('登录已取消（' + res.reason + '）', 'warn');
    }

    function manualLogin() {
        var ak = prompt('请输入 Android 主版 access_key\n（由 appkey ' + AND_APPKEY + ' 签发，对应 mobi_app=android）');
        if (!ak || !ak.trim()) return;
        setAuth('android', ak.trim());
        toast('凭据已保存（手动输入 / Android 模式）', 'ok');
    }

    // ─── Source registry + resolver ─────────────────────────────────────
    //
    // Each source exposes:
    //   name:     short id used in priority maps
    //   enabled:  () => bool — whether we can call it right now
    //   fetchPage({mediaId, pn}) → Promise<{list:[normItem], has_more}>
    //     Each list item is normalized to the Android-app shape (oid is av,
    //     upper={mid,name,face}, cnt_info={play,danmaku,thumb_up,coin,
    //     reply,collect}, etc.) so the merge layer is field-name-stable.
    //
    // Merge layer: each field has a priority order (which source's value
    // to prefer) plus a QUALITY predicate (a value that fails the quality
    // check — e.g. the global placeholder cover URL — is skipped, falling
    // through to the next source).
    //
    // Cache: merged per-avid records are persisted in GM storage so a tab
    // reload doesn't re-call any API.  In-memory per-page Promise cache
    // dedups concurrent requests within a session.

    // ─── Source failure gate (backoff) ─────────────────────────────────
    // Tracks consecutive timeout/network failures per source. After N hits
    // in a row, the source is considered "down" and `gate.isOpen(name)`
    // returns false for BACKOFF_MS so callers can short-circuit. State is
    // intentionally process-memory only: a page reload resets the gate so
    // the user gets a fresh attempt without waiting for the cooldown.
    var sourceFailureGate = (function () {
        var FAIL_THRESHOLD = 3;
        var BACKOFF_MS = 5 * 60 * 1000;          // 5 min
        var failureCounts = {};                  // src → consecutive fail count
        var openAt = {};                         // src → Date.now() when re-enabled
        return {
            isOpen: function (src) {
                var until = openAt[src] || 0;
                if (until && Date.now() < until) return false;
                // Window expired — reset and try again.
                if (until && Date.now() >= until) {
                    failureCounts[src] = 0;
                    openAt[src] = 0;
                }
                return true;
            },
            onFail: function (src, reason) {
                failureCounts[src] = (failureCounts[src] || 0) + 1;
                if (failureCounts[src] >= FAIL_THRESHOLD && !openAt[src]) {
                    openAt[src] = Date.now() + BACKOFF_MS;
                    console.warn('[fav-fix/' + src + '] gated for ' + (BACKOFF_MS / 60000)
                                 + ' min after ' + failureCounts[src] + ' consecutive failures (last: '
                                 + reason + '). Reload the page to retry sooner.');
                }
            },
            onOk: function (src) {
                if (failureCounts[src] || openAt[src]) {
                    console.info('[fav-fix/' + src + '] backoff gate reset after successful response');
                }
                failureCounts[src] = 0;
                openAt[src] = 0;
            },
            // For stats() inspection.
            snapshot: function () {
                var out = {};
                Object.keys(failureCounts).forEach(function (s) {
                    var until = openAt[s] || 0;
                    out[s] = {
                        consecutiveFailures: failureCounts[s],
                        gatedUntilMs: until,
                        gatedForSec: until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0
                    };
                });
                return out;
            }
        };
    })();

    var SOURCES = {
        android: {
            name: 'android',
            paginated: true,
            enabled: function () { return !!getAuth().access_key; },
            fetchPage: function (ctx) {
                var auth = getAuth();
                var base = {
                    media_id:     String(ctx.mediaId),
                    pn:           String(ctx.pn),
                    ps:           '20',
                    appkey:       appkeyFor(auth.mode),
                    access_key:   auth.access_key,
                    ts:           String(Math.floor(Date.now() / 1000)),
                    // Required-for-invalid-items hints (verified by bisect
                    // against the captured Android-app traffic — dropping
                    // any of these four causes the server to silently
                    // filter invalid items out of the page response):
                    mobi_app:     'android',
                    platform:     'android',
                    build:        '8940300',
                    disable_rcmd: '0',
                    c_locale:     'en',
                    s_locale:     'en',
                    channel:      'bili',
                    statistics:   '{"appId":1,"platform":3,"version":"8.94.0","abtest":""}'
                };
                var signed = signParams(base, appsecFor(auth.mode));
                var url = 'https://api.bilibili.com/x/v3/fav/folder/resources?' + toQuery(signed);
                return gmGet(url).then(function (r) {
                    if (r.code !== 0) throw new Error('android API code=' + r.code + ' msg=' + r.message);
                    var d = r.data || {};
                    // Already in Android-app shape — pass through.
                    return { list: d.list || [], has_more: !!d.has_more, total: d.total };
                });
            }
        },
        'public': {
            name: 'public',
            paginated: true,
            enabled: function () { return true; },
            fetchPage: function (ctx) {
                // Try public spaceDetail (no auth, works for own public favs)
                // first, then fall back to fav/resource/list?platform=web
                // (uses SESSDATA cookie sent by GM_xmlhttpRequest, works for
                // own private favs). Both endpoints return placeholders for
                // invalid items' cover/title, but preserve pubtime / fav_time
                // / tid / pages / cnt_info — the fields the Android-app
                // endpoint omits.
                var qs = 'media_id=' + ctx.mediaId + '&pn=' + ctx.pn + '&ps=20'
                       + '&keyword=&order=mtime&type=0&tid=0';
                var publicUrl  = 'https://api.bilibili.com/medialist/gateway/base/spaceDetail?' + qs + '&jsonp=jsonp';
                var privateUrl = 'https://api.bilibili.com/x/v3/fav/resource/list?'             + qs + '&platform=web';
                return gmGet(publicUrl).then(function (r1) {
                    if (r1.code === 0 && r1.data) return normalizePublicResp(r1.data);
                    log('public spaceDetail code=', r1.code, '— falling back to private/web');
                    return gmGet(privateUrl).then(function (r2) {
                        if (r2.code !== 0) throw new Error('public failed (public=' + r1.code + ' private=' + r2.code + ' msg=' + r2.message + ')');
                        return normalizePublicResp(r2.data);
                    });
                });
            }
        },
        // ─── Third-party archives ──────────────────────────────────────
        // Per-AV (not paginated). The resolver calls fetchAvs(avs) ONLY
        // for avs whose cover or title is still poor quality after the
        // paginated sources (android + public) finish — gates expensive
        // off-site calls. biliplus rate-limits with code -503 (retry-once);
        // jijidown answers a cold aid with a "loading" stub first and only
        // serves the real record on a follow-up poll (see its fetchAvs).
        //
        // (xbeibeix was removed: the whole site now sits behind Cloudflare's
        // interactive Turnstile challenge, which GM_xmlhttpRequest cannot
        // solve — every request returned the "Just a moment…" page. The
        // missing-item banner in 13-missing.js still links xbeibeix.com for
        // MANUAL clicks, which a real browser CAN clear.)
        //
        // Failure backoff (sourceFailureGate): if a source eats its full
        // per-request timeout (5s) on N consecutive chunks, we mark it
        // disabled for the next BACKOFF_MS so we don't waste another 5s
        // per patch cycle. State is in-memory only — a TM page reload
        // resets and retries everything (typical "is it back yet" check).
        biliplus: {
            name: 'biliplus',
            paginated: false,
            enabled: function () { return sourceFailureGate.isOpen('biliplus'); },
            fetchAvs: async function (avs) {
                var out = new Map();
                if (!avs.length) return out;
                // Always-on (not gated by debug mode): 3rd-party calls are
                // rare and the user often wants to see whether they fired.
                console.info('[fav-fix/biliplus] querying', avs.length, 'av(s):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var CHUNK = 50;
                // All 3rd-party archives (biliplus / jijidown) are
                // best-effort fallbacks; never let a slow archive hold
                // up patching the DOM. Per-chunk timeout 5s (vs gmGet's 15s
                // default) keeps the worst case bounded.
                var REQ_TIMEOUT = 5000;
                var sawAnySuccess = false;
                var sawAnyFailure = false;
                for (var i = 0; i < avs.length; i += CHUNK) {
                    var chunk = avs.slice(i, i + CHUNK);
                    var url = 'https://www.biliplus.com/api/aidinfo?aid=' + chunk.join(',');
                    var r;
                    try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                    catch (e) {
                        console.warn('[fav-fix/biliplus] network error:', e.message);
                        sawAnyFailure = true;
                        continue;
                    }
                    if (r && r.code === -503) {
                        console.warn('[fav-fix/biliplus] rate-limited (code -503), retrying in 2s');
                        await new Promise(function (res) { setTimeout(res, 2000); });
                        try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                        catch (e) { sawAnyFailure = true; continue; }
                    }
                    if (!r || r.code !== 0 || !r.data) {
                        console.warn('[fav-fix/biliplus] chunk failed: code=',
                                     r && r.code, 'message=', r && r.message);
                        sawAnyFailure = true;
                        continue;
                    }
                    sawAnySuccess = true;
                    var chunkHits = 0;
                    for (var av in r.data) {
                        var info = r.data[av];
                        if (!info || !info.title) continue;
                        out.set(String(av), {
                            oid:   Number(av),
                            title: info.title,
                            cover: info.pic,
                            upper: info.author ? { name: info.author } : undefined
                        });
                        chunkHits++;
                    }
                    console.info('[fav-fix/biliplus] chunk', i / CHUNK + 1,
                                 'returned', chunkHits, 'of', chunk.length);
                }
                // Feed the backoff gate: any single successful response
                // resets the counter (server's back). If every chunk failed
                // (timeouts, -503, or malformed responses), count it as a
                // single failure event for this fetchAvs call.
                if (sawAnySuccess) sourceFailureGate.onOk('biliplus');
                else if (sawAnyFailure) sourceFailureGate.onFail('biliplus', 'all chunks failed');
                console.info('[fav-fix/biliplus] total:', out.size, '/', avs.length);
                return out;
            }
        },
        jijidown: {
            name: 'jijidown',
            paginated: false,
            enabled: function () { return sourceFailureGate.isOpen('jijidown'); },
            fetchAvs: async function (avs) {
                if (!avs.length) return new Map();
                console.info('[fav-fix/jijidown] querying', avs.length, 'av(s) (sequential):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var out = new Map();
                // Per-av timeout 5s — see biliplus comment above.
                var REQ_TIMEOUT = 5000;
                // get_info is two-phase: the FIRST hit for an aid jijidown
                // hasn't warmed returns a loading stub
                // ({code:0, msg:'loading', title:'正在加载数据...'} with NO
                // upid); the real record only lands a second or two later. A
                // single shot therefore drops every cold aid (upid undefined →
                // "no record"), which is most invalid items — the exact case
                // this source exists for. Re-poll the stub a few times before
                // giving up. The phase-2 budget in resolveItems still caps
                // total wall time, so a folder full of cold aids can't stall
                // the DOM patch.
                var LOADING_POLL_MS   = 1200;
                var LOADING_MAX_POLLS = 2;        // 1 initial request + 2 re-polls
                var sawAnyResponse = false;
                for (var i = 0; i < avs.length; i++) {
                    var av = avs[i];
                    var url = 'https://www.jijidown.com/api/v1/video/get_info?id=' + av;
                    var r = null;
                    for (var attempt = 0; attempt <= LOADING_MAX_POLLS; attempt++) {
                        try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                        catch (e) {
                            console.warn('[fav-fix/jijidown] av', av, 'network error:', e.message);
                            r = null;
                            break;
                        }
                        sawAnyResponse = true;
                        if (r && (r.msg === 'loading' || r.title === '正在加载数据...')) {
                            if (attempt < LOADING_MAX_POLLS) {
                                await new Promise(function (res) { setTimeout(res, LOADING_POLL_MS); });
                                continue;        // still warming up — re-poll
                            }
                            console.info('[fav-fix/jijidown] av', av, 'still loading after',
                                         LOADING_MAX_POLLS + 1, 'polls, skip');
                            r = null;
                        }
                        break;
                    }
                    if (!r) continue;
                    if (!r.upid || r.upid <= 0) {
                        console.info('[fav-fix/jijidown] av', av, 'no record (upid=' + r.upid + ')');
                        continue;
                    }
                    if (r.title === '视频去哪了呢？' || r.title === '该视频或许已经被删除了') {
                        console.info('[fav-fix/jijidown] av', av, 'archive empty:', r.title);
                        continue;
                    }
                    if (r.title === String(av) && !r.img) continue;
                    out.set(String(av), {
                        oid:   Number(av),
                        title: r.title,
                        cover: r.img,
                        upper: r.up && r.up.author ? { name: r.up.author, mid: r.upid } : undefined
                    });
                }
                if (sawAnyResponse) sourceFailureGate.onOk('jijidown');
                else sourceFailureGate.onFail('jijidown', 'all requests errored');
                console.info('[fav-fix/jijidown] total:', out.size, '/', avs.length);
                return out;
            }
        }
    };

    function normalizePublicResp(d) {
        // Both spaceDetail and fav/resource/list return { medias: [...], info: {...}, has_more }.
        // medias[].id is the avid (vs Android's oid). Otherwise field
        // names line up closely; we rename id→oid and pass the rest through.
        var medias = d.medias || [];
        var list = medias.map(function (m) {
            var out = {};
            for (var k in m) out[k] = m[k];
            out.oid = m.id != null ? m.id : m.oid;
            return out;
        });
        // folderTitle: the folder's own display name, carried by both public
        // endpoints in d.info.title. The backup walker persists it into the
        // meta store so the manager panel can label folders by name instead
        // of a raw media_id. Resolver callers simply ignore the field.
        return { list: list, has_more: !!d.has_more, total: d.info && d.info.media_count,
                 folderTitle: (d.info && d.info.title) || null };
    }

    // ─── Quality predicates ────────────────────────────────────────────
    //
    // Returning 0 means "skip this value, try the next source for this field".

    var COVER_PLACEHOLDER_RE = /be27fd62/i;
    var QUALITY = {
        cover: function (url) {
            if (!url) return 0;
            if (COVER_PLACEHOLDER_RE.test(url)) return 0;
            if (/bfs\/archive/i.test(url)) return 10;
            return 5;
        },
        title: function (t) {
            if (!t) return 0;
            t = String(t).trim();
            if (t === '已失效视频' || t === '该视频已被删除' || t === '已失效') return 0;
            return 10;
        },
        upper: function (u) {
            if (!u || typeof u !== 'object') return 0;
            if (!u.name || u.name === '账号已注销' || u.name === '账号已注销.') return 0;
            return 10;
        },
        cnt_info: function (c) {
            if (!c || typeof c !== 'object') return 0;
            // Public endpoint sometimes returns all zeros for invalid items;
            // Android-app endpoint preserves the snapshot. Prefer whichever
            // has more non-zero fields (handled by priority + this check).
            var nonzero = 0;
            for (var k in c) if (c[k] && typeof c[k] === 'number') nonzero++;
            return nonzero > 0 ? 10 : 1;
        },
        'default': function (v) {
            if (v == null) return 0;
            if (typeof v === 'string' && !v.trim()) return 0;
            if (Array.isArray(v) && v.length === 0) return 0;
            return 10;
        }
    };

    // Priority order: source name LEFT wins if its value passes QUALITY.
    // `backup` (15a-backup.js) leads every field it supplies: it is the only
    // source captured while the video was still ALIVE, so its snapshot beats
    // any post-mortem one by construction. It is absent from attr / link /
    // playback_desc on purpose — those describe the item's CURRENT state and
    // must come from a live source.
    // 3rd-party archives (biliplus / jijidown) carry only title/cover/
    // upper.name — they're the last-resort fallback for items even the
    // Android-app snapshot couldn't save.
    var FIELD_PRIORITY = {
        // Android endpoint preserves invalid-item snapshots for these.
        cover:    ['backup', 'android', 'public', 'biliplus', 'jijidown'],
        title:    ['backup', 'android', 'public', 'biliplus', 'jijidown'],
        upper:    ['backup', 'android', 'public', 'biliplus', 'jijidown'],
        intro:    ['backup', 'android', 'public'],
        duration: ['backup', 'android', 'public'],
        playback_desc: ['android', 'public'],
        attr:     ['android', 'public'],
        link:     ['android', 'public'],
        bvid:     ['backup', 'public', 'android'],
        // Public endpoint has these; Android omits them for invalid items:
        cnt_info: ['backup', 'public',  'android'],
        pubtime:  ['backup', 'public'],
        ctime:    ['backup', 'public',  'android'],
        fav_time: ['backup', 'public'],
        tid:      ['backup', 'public'],
        pages:    ['backup', 'public'],
        page:     ['backup', 'public',  'android']
    };

    function mergeBySource(perSource) {
        var out = {};
        var srcs = Object.keys(SOURCES);
        // Field-priority merge
        for (var field in FIELD_PRIORITY) {
            var order = FIELD_PRIORITY[field];
            for (var i = 0; i < order.length; i++) {
                var src = order[i];
                var data = perSource[src];
                if (!data) continue;
                var v = data[field];
                var q = (QUALITY[field] || QUALITY['default'])(v);
                if (q > 0) { out[field] = v; out['_src_' + field] = src; break; }
            }
        }
        // Pass-through for any field not covered by FIELD_PRIORITY (e.g.
        // oid, otype, ugc, card_type, jump_link…). First source that has
        // the field wins (Android > public by registry order).
        for (var s = 0; s < srcs.length; s++) {
            var d = perSource[srcs[s]];
            if (!d) continue;
            for (var k in d) {
                if (out[k] !== undefined) continue;
                if (FIELD_PRIORITY[k]) continue;
                out[k] = d[k];
            }
        }
        out._sources = Object.keys(perSource);
        // Degenerate = neither cover nor title passed QUALITY from any source.
        // Card will render visually unchanged (placeholder cover + "已失效视频"
        // text) but with the red marker — easy to confuse with a permanent
        // 404. Flagged so loadCache can use a short TTL: the most common
        // cause is Android API's walk-to-walk drop (server returns the av
        // on some walks, not others), and a fresh walk in ~10 min often
        // recovers it. Without the short TTL, one bad walk locks in 30 days.
        if (!out._src_cover && !out._src_title) out._degenerate = true;
        return out;
    }

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
    // loadCache without the staleness test. The entry is past its TTL, but it
    // is still the best thing this script knows about the av — and for an av on
    // the 停止重试 list that is the whole story, because no network work will be
    // scheduled to learn anything better. The resolver uses it there instead of
    // overwriting a title-bearing merge with a bare _pending stub (08-resolver.js
    // merge block). Deliberately does NOT refresh _cached_at: the entry has to
    // stay stale so the first resolve after the suppression lapses re-fetches.
    function loadCacheStale(av) {
        var v = GM_getValue(CACHE_PREFIX + av, null);
        if (!v) return null;
        if (v._cache_version !== CACHE_VERSION) return null;
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
    //            AUTO_NORETRY_TTL_MS, so a folder that merely flapped badly for
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
    var AUTO_NORETRY_TTL_MS = 1000 * 60 * 60 * 24 * 7;   // 7 days

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
            if (now - (v.at || 0) > AUTO_NORETRY_TTL_MS) { GM_deleteValue(k); expired++; return; }
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
    // loop wrote less than AUTO_NORETRY_TTL_MS ago. Expired auto records are
    // cleared on the spot so the storage entry disappears with the suppression.
    function isRetrySuppressed(av) {
        loadNoRetryIndex();
        av = String(av);
        if (_noRetryUser.has(av)) return true;
        var at = _noRetryAuto.get(av);
        if (at == null) return false;
        if (Date.now() - at > AUTO_NORETRY_TTL_MS) { clearNoRetry(av); return false; }
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
                       expiresAt: at ? new Date(at + AUTO_NORETRY_TTL_MS).toLocaleString() : null });
        });
        return out;
    }

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
        // allFound for a suppressed av and would run the full MAX_PAGE_WALK.
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
            var pn = 1, MAX_PN = MAX_PAGE_WALK;
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
        var PHASE2_BUDGET_MS = 10000;
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
    // Adaptive backoff (FLAP_BACKOFF_MS / FLAP_MAX_DRY in 01-constants.js): the
    // `dry` counter drives BOTH cadence and termination. A walk that recovers
    // something resets dry → next walk fires after the short burst gap; a walk
    // that recovers nothing bumps dry → the gap widens and, at FLAP_MAX_DRY,
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
        var deadline = Date.now() + FLAP_TIME_BUDGET_MS;
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
        // Did the loop reach a CONCLUSION (dry ran out / the 30-minute budget
        // did), as opposed to being interrupted? Only a conclusion may write the
        // auto 停止重试 records in the finally. Re-deriving this from `dry` down
        // there would misfire: a folder switch can abort the loop at a moment
        // when dry happens to sit at FLAP_MAX_DRY, and an interrupted loop is
        // not a verdict on a folder it never finished sampling.
        var gaveUp = false;
        _flapProgress = {
            mediaId: mediaId, startedAt: Date.now(), deadline: deadline,
            total: pending.size, remaining: pending.size,
            walk: 0, dry: 0, maxDry: FLAP_MAX_DRY,
            phase: 'walking', page: 0, nextWalkAt: 0, lastRecovered: 0
        };
        try {
            log('flap-bg: start', pending.size, 'candidate(s):',
                Array.from(pending).slice(0, 5).join(',') + (pending.size > 5 ? ',…' : ''));
            while (pending.size && dry < FLAP_MAX_DRY) {
                if (detectMediaId() !== mediaId) { log('flap-bg: folder changed, abort'); break; }
                // Budget exhausted counts as a conclusion only if android
                // answered at least once: 30 minutes of failed requests is a
                // statement about the connection, not about the videos.
                if (Date.now() > deadline)       { log('flap-bg: 30-min budget exhausted'); gaveUp = everSampled; break; }
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
                while (pn <= MAX_PAGE_WALK) {
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
                // FLAP_MAX_DRY and stamped auto records on every remaining av of
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
                    log('flap-bg walk ' + walk + ': android unreachable (' + errRun + '/' + FLAP_MAX_DRY
                        + ' consecutive) — not counted toward dry');
                } else {
                    errRun = 0;
                    dry++;     // no progress → widen the gap, step toward giving up
                    log('flap-bg walk ' + walk + ': 0 new (dry ' + dry + '/' + FLAP_MAX_DRY + ')');
                }
                _flapProgress.dry = dry;
                _flapProgress.lastRecovered = recovered.length;
                _flapProgress.remaining = pending.size;

                if (!pending.size || dry >= FLAP_MAX_DRY || errRun >= FLAP_MAX_DRY) {
                    if (dry >= FLAP_MAX_DRY) gaveUp = true;
                    // An error run stops the loop WITHOUT a verdict: the cards
                    // stay 待重试 and a reload — or 立即重试, or the user simply
                    // logging in again — re-arms the loop exactly as before.
                    else if (errRun >= FLAP_MAX_DRY) log('flap-bg: stopping for now — ' + errRun
                        + ' consecutive walk(s) could not reach android; no auto 停止重试 written');
                    break;
                }

                // Adaptive backoff before the next walk: gap widens with `dry`.
                // Sleep in ~1s slices so a folder switch / budget expiry breaks
                // out within a second (frees _flapBgRunning for the next folder).
                // Widen on whichever counter is running: a failing android must
                // back off just as a fruitless one does, or an outage would be
                // hammered at the 1s burst gap.
                var gap = FLAP_BACKOFF_MS[Math.min(Math.max(dry, errRun), FLAP_BACKOFF_MS.length - 1)];
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

    // ─── URL / page detection ───────────────────────────────────────────

    function detectMediaId() {
        // Pattern 1: www.bilibili.com/list/ml{media_id}
        var m = location.pathname.match(/\/list\/ml(\d+)/);
        if (m) return m[1];
        // Pattern 2: ?fid={media_id} on space.bilibili.com/{mid}/favlist
        var qs = new URLSearchParams(location.search);
        var fid = qs.get('fid');
        if (fid) return fid;
        // Pattern 3: ?fav_id={media_id} (some new pages)
        var favId = qs.get('fav_id');
        if (favId) return favId;
        return null;
    }

    function isFavPage() {
        return /\/favlist/.test(location.pathname) || /\/list\/ml\d+/.test(location.pathname);
    }

    // ─── DOM scanning / patching ────────────────────────────────────────

    function findInvalidContainers() {
        // Strategy 1: covers whose URL contains the placeholder hash token.
        // Filter out imgs we've already processed (recovered → solid red
        // mark, OR _no_source → "nodata" mark); they still match the
        // selector because we don't rewrite the placeholder URL on nodata,
        // but re-processing them is wasted observer work and inflates
        // `invalidDetectedNow` to the user.
        var imgs = document.querySelectorAll(
            'img[src*="' + PLACEHOLDER_COVER_TOKEN + '"]:not([data-fav-fix-marked])'
        );
        var nodes = Array.from(imgs).map(function (img) {
            // Resolve the container to the WHOLE fav card, not the first
            // ancestor that happens to hold a /video/ link. On the modern
            // layout that ancestor is `div.bili-video-card__cover`, which
            // contains the cover <img> but NOT the title — the title is a
            // sibling leaf <a>. A cover-only container means patchTitle can
            // never reach the title node, so a recovered item shows its real
            // cover with a stale "（视频已删除）" / "已失效视频" title (verified
            // on a real card). Scoping to the card keeps cover AND title in
            // one patchable subtree.
            var card = img.closest(CARD_SELECTOR);
            if (card) {
                return { container: card, img: img, link: card.querySelector('a[href*="/video/"]') };
            }
            // Fallback (img not inside a known card class): old walk-up.
            var n = img;
            while (n && n !== document.body) {
                var a = n.querySelector && n.querySelector('a[href*="/video/"]');
                if (a) return { container: n, img: img, link: a };
                n = n.parentElement;
            }
            return { container: img.parentElement, img: img, link: null };
        });

        // Strategy 2 (fallback): titles that match "已失效视频" exactly.
        // Only used to detect items whose cover URL doesn't include the
        // placeholder token (some pages render an inline SVG instead).
        //
        // Scope the scan to fav cards (CARD_SELECTOR) instead of every
        // p/span/div/a in the document. The old全-document querySelectorAll
        // returned thousands of nodes (sidebar / nav / recs / footer) and ran
        // on every debounced observer tick — the heaviest single step in the
        // patch cycle. Cards are ~20-40 per page, so this is one to two orders
        // of magnitude fewer nodes. Container resolution (walk up to the
        // nearest /video/ link ancestor) is kept identical to Strategy 1 so
        // the two strategies produce the SAME container object for a card and
        // the dedupe below still collapses them.
        var titleHits = [];
        var cards = document.querySelectorAll(CARD_SELECTOR);
        for (var ci = 0; ci < cards.length; ci++) {
            var card = cards[ci];
            var cand = card.querySelectorAll('p, span, div, a');
            var titleEl = null;
            for (var k = 0; k < cand.length; k++) {
                if (cand[k].children.length === 0 && cand[k].textContent.trim() === INVALID_TITLE) {
                    titleEl = cand[k];
                    break;
                }
            }
            if (!titleEl) continue;
            // Container = the whole card (same as Strategy 1), so the dedupe
            // below collapses both strategies' hits for one card into one and
            // patchTitle/patchCover share a single subtree that holds both the
            // title leaf and the cover <img>.
            var link2 = card.querySelector('a[href*="/video/"]');
            if (link2) titleHits.push({ container: card, img: card.querySelector('img'), link: link2, titleEl: titleEl });
        }

        // Merge by container (dedupe).
        var seen = new Set();
        var out = [];
        nodes.concat(titleHits).forEach(function (hit) {
            if (!hit.container || seen.has(hit.container)) return;
            seen.add(hit.container);
            out.push(hit);
        });
        return out;
    }

    function extractAvFromLink(href) {
        if (!href) return null;
        var m = href.match(/\/video\/av(\d+)/i);
        if (m) return m[1];
        // BV → bvid; we can't resolve to av without an extra API call.
        // The fav API returns oid as av number, so BV-only items would
        // need a BV→av conversion. For POC, skip BV-only items and log.
        var bv = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (bv) { log('skip BV-only item (av not derivable from DOM)', bv[1]); return null; }
        return null;
    }

    function avToBv(aid) {
        // 2023 new-algorithm AV→BV (mirror of bvToAv below). Verbatim from
        // bilibili-API-collect docs/misc/bvid_desc.md JS section.
        var XOR_CODE  = 23442827791579n;
        var MAX_AID   = 1n << 51n;
        var BASE      = 58n;
        var data = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
        try {
            var bytes = ['B','V','1','0','0','0','0','0','0','0','0','0'];
            var bvIdx = bytes.length - 1;
            var tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
            while (tmp > 0n) {
                bytes[bvIdx] = data[Number(tmp % BASE)];
                tmp = tmp / BASE;
                bvIdx -= 1;
            }
            var t;
            t = bytes[3]; bytes[3] = bytes[9]; bytes[9] = t;
            t = bytes[4]; bytes[4] = bytes[7]; bytes[7] = t;
            return bytes.join('');
        } catch (e) { return null; }
    }

    function bvToAv(bvid) {
        // 2023 new-algorithm BV→AV. Verbatim from bilibili-API-collect
        // docs/misc/bvid_desc.md JS section. Pure function; works for any
        // 12-char "BV1XXXXXXXXX" issued after 2020-03-23 (i.e. anything a
        // modern fav page would link to). Pre-2020 BVs with the old 6-char
        // layout will decode to garbage — but those are essentially extinct
        // on modern bilibili.
        var XOR_CODE  = 23442827791579n;
        var MASK_CODE = 2251799813685247n;
        var MAX_AID   = 1n << 51n;
        var BASE      = 58n;
        var data = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
        try {
            if (typeof bvid !== 'string' || bvid.length !== 12) return null;
            var arr = bvid.split('');
            var t;
            t = arr[3]; arr[3] = arr[9]; arr[9] = t;
            t = arr[4]; arr[4] = arr[7]; arr[7] = t;
            arr.splice(0, 3);
            var tmp = 0n;
            for (var i = 0; i < arr.length; i++) {
                var idx = data.indexOf(arr[i]);
                if (idx < 0) return null;
                tmp = tmp * BASE + BigInt(idx);
            }
            var avBig = (tmp & MASK_CODE) ^ XOR_CODE;
            if (avBig <= 0n || avBig >= MAX_AID) return null;
            return avBig.toString();
        } catch (e) { return null; }
    }

    function getAvFromHit(hit) {
        var href = hit.link && hit.link.getAttribute('href');
        if (!href) return null;
        var m = href.match(/\/video\/av(\d+)/i);
        if (m) return m[1];
        var bv = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (bv) return bvToAv(bv[1]);
        return null;
    }

    function patchCover(img, realCoverUrl, av) {
        if (!img || !realCoverUrl) return;
        // bilibili web is https — Android-app responses are sometimes http.
        var u = realCoverUrl.replace(/^http:\/\//, 'https://');
        if (img.getAttribute('data-fav-fix-original')) return; // already patched
        img.setAttribute('data-fav-fix-original', img.src || '');
        // Last-resort cover: bilibili sometimes purges the IMAGE while the
        // metadata snapshot survives, so the URL we just recovered 404s and the
        // card ends up with real title + broken cover. If a manual backup
        // (15a-backup.js) captured the bytes, swap in an objectURL.
        // data-fav-fix-blob-cover is the idempotence guard for BOTH the
        // observer (which re-enters patchCover on every tick) and the error
        // handler itself — without it an undecodable blob would re-fire
        // `error` on the objectURL and loop forever.
        if (av && !img.getAttribute('data-fav-fix-blob-cover')) {
            img.addEventListener('error', function onCoverError() {
                img.removeEventListener('error', onCoverError);
                if (img.getAttribute('data-fav-fix-blob-cover')) return;
                img.setAttribute('data-fav-fix-blob-cover', 'pending');
                backupCoverObjectUrl(av).then(function (objUrl) {
                    if (!objUrl) { img.setAttribute('data-fav-fix-blob-cover', 'miss'); return; }
                    img.setAttribute('data-fav-fix-blob-cover', 'hit');
                    img.src = objUrl;
                }).catch(function (e) {
                    img.setAttribute('data-fav-fix-blob-cover', 'miss');
                    warn('backup cover fallback failed for av', av, e && e.message);
                });
            });
        }
        img.src = u;
        img.style.opacity = '1';
    }

    // Rewrite an element's visible title text in place. The title is a leaf
    // (text-only) on bilibili's card, so we set its first non-empty text node
    // and blank any extras — keeping the element itself (and its listeners /
    // data attrs) rather than reassigning textContent wholesale.
    function setTitleText(el, text) {
        var tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var n, set = false;
        while ((n = tw.nextNode())) {
            if (!n.nodeValue.trim()) continue;
            if (!set) { n.nodeValue = text; set = true; }
            else n.nodeValue = '';
        }
        if (!set) el.textContent = text;
    }

    function patchTitle(container, realTitle) {
        if (!container || !realTitle) return;
        // Robust path: once a prior patch tagged the title element, update it
        // directly — independent of what it currently shows ("已失效视频",
        // "（视频已删除）", or a previous real title). The old text-match-only
        // approach was one-shot: after the first rewrite the text no longer
        // equalled INVALID_TITLE, so a later refetch (android flap → recovered)
        // updated the cover but never the title. Verified on a real card: the
        // title is a leaf <a> outside the cover container, reachable here only
        // via the INVALID_TITLE match, which can never fire twice.
        var tagged = container.querySelectorAll('[data-fav-fix-title]');
        if (tagged.length) {
            tagged.forEach(function (el) {
                // Leaf element → safe to rewrite text. Non-leaf (tagged only
                // for its title attribute) → leave children, just fix the attr.
                if (el.children.length === 0) setTitleText(el, realTitle);
                if (el.hasAttribute('title')) el.setAttribute('title', realTitle);
            });
            return;
        }
        // First touch: rewrite the INVALID_TITLE leaf and tag it so subsequent
        // patches skip the (fragile) text match.
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() === INVALID_TITLE) {
                node.nodeValue = node.nodeValue.replace(INVALID_TITLE, realTitle);
                if (node.parentElement) node.parentElement.setAttribute('data-fav-fix-title', '1');
            }
        }
        // Also patch + tag title attributes (native tooltip).
        container.querySelectorAll('[title="' + INVALID_TITLE + '"]').forEach(function (el) {
            el.setAttribute('title', realTitle);
            el.setAttribute('data-fav-fix-title', '1');
        });
    }

    // ─── Hover tooltip (rich) ───────────────────────────────────────────

    // Third-party archives (biliplus, jijidown) are an
    // untrusted boundary: a poisoned/compromised source could return a
    // cover/avatar URL of `javascript:…` or `data:text/html,…`. Setting such
    // a value as img.src is inert (browsers never execute it), but handing it
    // to GM_openInTab would navigate a real tab there. Whitelist absolute
    // http(s) before any URL crosses into GM_openInTab or an <img src> we
    // build from source data.
    function isHttpUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtCount(n) {
        if (n == null) return '';
        n = Number(n);
        if (!isFinite(n)) return '';
        if (n >= 1e8)  return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1) + '亿';
        if (n >= 1e4)  return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + '万';
        return String(n);
    }
    function fmtDuration(sec) {
        sec = Number(sec) || 0;
        if (sec <= 0) return '';
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        var pad = function (x) { return x < 10 ? '0' + x : String(x); };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }
    function fmtTime(ts) {
        if (!ts) return '';
        var d = new Date(Number(ts) * 1000);
        if (isNaN(d.getTime())) return '';
        var pad = function (x) { return x < 10 ? '0' + x : String(x); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    // Elapsed wall time for the pending-card live status ("已用时 …"). Takes a
    // millisecond delta (Date.now() - startedAt), NOT a unix ts like fmtTime.
    function fmtElapsed(ms) {
        var s = Math.max(0, Math.floor(ms / 1000));
        var m = Math.floor(s / 60);
        s = s % 60;
        return m > 0 ? (m + ' 分 ' + s + ' 秒') : (s + ' 秒');
    }

    // Single source of truth for "投稿时间" so the hover tooltip and the
    // "复制完整信息" clipboard text never diverge (AGENTS.md gotcha #83).
    // Both must read the SAME field-fallback chain and the SAME source tag,
    // otherwise an item that carries ctime but not pubtime shows a date on
    // hover but a blank one when copied.
    function pickPubTs(real) {
        return real.ctime || real.pubtime || real.pubdate || null;
    }
    function pickPubSrc(real) {
        return real._src_ctime || real._src_pubtime || real._src_pubdate || null;
    }

    // Single global tooltip element, reused across all hovers.
    var _tipEl = null;
    // While hovering a pending (重试中) card, the tooltip is rebuilt once a
    // second so its live status (countdown / elapsed / round) actually ticks —
    // visible proof the loop is not stuck. One timer at a time; cleared on hide
    // and when the card stops being pending.
    var _tipRefreshTimer = null;
    function stopTipRefresh() {
        if (_tipRefreshTimer) { clearInterval(_tipRefreshTimer); _tipRefreshTimer = null; }
    }
    function getTip() {
        if (_tipEl) return _tipEl;
        _tipEl = document.createElement('div');
        _tipEl.id = '__fav_fix_tip';
        _tipEl.style.cssText = [
            'position:fixed', 'z-index:2147483646', 'pointer-events:none',
            'max-width:340px', 'padding:10px 12px', 'border-radius:8px',
            'background:rgba(28,28,30,.96)', 'color:#fff',
            'box-shadow:0 8px 24px rgba(0,0,0,.35)',
            'font:12px/1.55 -apple-system,Segoe UI,"PingFang SC","Microsoft YaHei",sans-serif',
            'opacity:0', 'transition:opacity .12s', 'display:none'
        ].join(';');
        document.body.appendChild(_tipEl);
        return _tipEl;
    }

    // Two-column "label / value" row helper, used throughout the tooltip.
    function row(label, valueHtml, srcName) {
        return '<div style="display:flex;gap:10px;margin-bottom:4px;font-size:12px;align-items:flex-start">'
             + '<span style="color:#8a8a92;flex:0 0 52px;text-align:right">' + esc(label) + '</span>'
             + '<span style="color:#e6e6ea;flex:1;min-width:0;word-break:break-word">' + valueHtml + srcTag(srcName) + '</span>'
             + '</div>';
    }
    function codeTag(text) {
        return '<code style="background:rgba(255,255,255,.1);padding:1px 6px;border-radius:3px;font-size:11px;font-family:Consolas,Menlo,monospace">'
             + esc(text) + '</code>';
    }

    // Source attribution chips. Color-coded per source so the user can
    // see at a glance which API contributed which field of the snapshot.
    var SOURCE_COLORS = {
        backup:    '#8e44ad',
        android:   '#5b8def',
        'public':  '#67c23a',
        biliplus:  '#e6a23c',
        jijidown:  '#f56c6c'
    };
    function srcTag(src) {
        if (!src) return '';
        var color = SOURCE_COLORS[src] || '#909399';
        return ' <span style="display:inline-block;padding:0 6px;margin-left:6px;'
             + 'border-radius:3px;background:' + color + ';color:#fff;'
             + 'font-size:9px;font-weight:600;line-height:14px;vertical-align:1px;'
             + 'letter-spacing:.3px;text-transform:uppercase">' + esc(src) + '</span>';
    }

    function buildTipHtml(real) {
        if (!real) return '';

        // Unrecoverable stub — no source returned data. Render a slim
        // tooltip that says exactly that (and lists which sources we tried)
        // instead of the normal rich layout with empty fields everywhere.
        if (real._no_source) {
            var av = real.oid != null ? String(real.oid) : '';
            var bv = av ? avToBv(av) : null;
            // Prefer _attempted (new, accurate: phase 1 + phase 2 unioned).
            // Fall back to _attempted_3rd (legacy: 3rd-party only) for old
            // cache entries, then to _tried_sources (oldest: all possible
            // sources from the registry, not necessarily queried) as a
            // last-resort display.
            var attemptedList = real._attempted || real._attempted_3rd || real._tried_sources || [];
            var attemptedHtml = attemptedList.map(srcTag).join('');
            return '<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;'
                 + 'line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                 + '视频已删除 · 无任何数据来源保留快照</div>'
                 + (av ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">AV ' + codeTag('av' + av) + '</div>' : '')
                 + (bv ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">BV ' + codeTag(bv) + '</div>' : '')
                 + '<div style="margin-top:6px;color:#bdbdc2;font-size:11px;line-height:1.5">'
                 + '已查询以下数据来源，均无记录：'
                 + '</div>'
                 + '<div style="margin-top:4px">' + attemptedHtml + '</div>'
                 + '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                 + 'fav-fix · 视频可能已被永久删除' + '</div>';
        }

        // Pending — still being chased by the background android flap loop, or
        // waiting for a future retry after it gave up. There's no good snapshot
        // yet, so render a state-aware explainer (NOT the normal rich layout
        // with empty fields). _flapBgRunning and the 停止重试 list are read LIVE
        // here — showTip rebuilds innerHTML on every hover, and once a second
        // while hovering — so the text tracks all three badge states: the loop
        // is alive (重试中), it gave up (待重试), or the user switched this av
        // off (已停止重试). The stopped copy is static, which makes the
        // once-a-second rebuild harmless rather than something to special-case.
        if (real._pending) {
            var pav = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : '');
            var pbv = real.bvid || (pav ? avToBv(pav) : null);
            // Third, highest-priority state: the user pressed 停止重试. Read
            // live from the list (07a-noretry.js), same as the badge — the flap
            // loop's liveness is irrelevant once the av is switched off.
            var pStopped = pav ? isNoRetryUser(pav) : false;
            // Fourth state, and the one the copy below has to distinguish: the
            // loop gave up on this av and recorded an 'auto' 停止重试 (7 days).
            // Nothing is chasing it — resolveItems keeps it out of the walk AND
            // out of the loop's candidate set — so it must neither borrow a
            // running loop's 重试中 wording nor be told that reloading retries.
            var pPaused = !pStopped && pav ? isRetrySuppressed(pav) : false;
            var pActive = !pStopped && !pPaused && _flapBgRunning;
            var pHead = pStopped ? '已停止重试'
                      : (pActive ? '正在找回此视频快照…'
                      : (pPaused ? '暂未找回，自动重试已暂停' : '暂未找回，等待重试'));

            // Live status block: only while the loop is actually running AND its
            // progress belongs to THIS folder (the loop nulls _flapProgress on
            // exit / folder switch). Answers "why still 重试中 / what is it doing"
            // with the real loop state. showTip re-renders this once a second so
            // the countdown and elapsed time tick visibly (proof it isn't stuck).
            var liveHtml = '';
            var prog = _flapProgress;
            if (pActive && prog && prog.mediaId === detectMediaId()) {
                var stateLine;
                if (prog.phase === 'sleeping') {
                    var secs = Math.max(0, Math.ceil((prog.nextWalkAt - Date.now()) / 1000));
                    stateLine = '当前：等待下次采样（约 ' + secs + ' 秒后）';
                } else {
                    stateLine = '当前：正在重新采样（第 ' + (prog.page || 1) + ' 页）';
                }
                liveHtml = '<div style="margin-top:6px;padding:6px 8px;border-radius:6px;'
                         + 'background:rgba(255,255,255,.06);color:#cfcfd6;font-size:11px;line-height:1.7">'
                         + '已采样 ' + prog.walk + ' 轮 · 整夹还剩 ' + prog.remaining + ' 项待找回<br>'
                         + esc(stateLine) + '<br>'
                         + '已用时 ' + fmtElapsed(Date.now() - prog.startedAt)
                         + ' · 连续 ' + prog.dry + '/' + prog.maxDry + ' 轮无新增即停'
                         + '</div>';
            }

            var pBody = pStopped
                ? '此视频的自动重试已由你手动停止，脚本不会再为它请求任何接口。点封面上的「恢复重试」按钮，或在本卡片右上「···」菜单选同名项，即可恢复并立即重新抓取一轮。'
                : (pActive
                ? 'bilibili 的 android 收藏接口会随机漏掉一部分失效视频，脚本正在后台多次重新采样把它捞回来。找回后本卡片会自动更新封面与标题，无需手动操作。'
                : (pPaused
                // The give-up copy below promises that a reload re-tries. With
                // an auto record in place that is false: the next resolve skips
                // the page walk for this av entirely. Say what actually happens.
                ? '后台已多次重新采样仍未取回——可能视频确实已被删除，也可能是 bilibili 接口暂时不返回。为避免每次进入收藏夹都重跑一轮，脚本已暂停对它的自动重试，约一周后自动恢复；期间重新整理本页不会再为它请求接口。如需立刻再试一轮，可在本卡片右上「···」菜单点「立即重试」。'
                : '后台已多次重新采样仍未取回——可能视频确实已被删除，也可能是 bilibili 接口暂时不返回。重新整理本页会自动再试一轮；也可在本卡片右上「···」菜单点「立即重试」立刻再抓一轮。'));
            // When the stop was recorded. Only for the manual mode: an auto
            // record is not the user's decision and has no place in a tooltip
            // that tells them what they themselves switched off.
            var pStoppedAt = pStopped ? noRetryUserAt(pav) : null;
            var pStoppedAtHtml = pStoppedAt
                ? '<div style="margin-top:4px;color:#8a8a92;font-size:11px">已于 '
                  + esc(fmtTime(Math.floor(pStoppedAt / 1000))) + ' 停止</div>'
                : '';
            return '<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;'
                 + 'line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                 + esc(pHead) + '</div>'
                 + (pav ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">AV ' + codeTag('av' + pav) + '</div>' : '')
                 + (pbv ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">BV ' + codeTag(pbv) + '</div>' : '')
                 + liveHtml
                 + '<div style="margin-top:6px;color:#bdbdc2;font-size:11px;line-height:1.55">'
                 + esc(pBody) + '</div>'
                 + pStoppedAtHtml
                 + '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                 + 'fav-fix · ' + (pStopped ? '已停止重试'
                                : (pActive ? '重试中（后台自动）'
                                : (pPaused ? '待重试（自动重试已暂停）' : '待重试'))) + '</div>';
        }

        var parts = [];

        // Title — full width, bold, with source chip after the title text.
        parts.push('<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                   + esc(real.title || '（无标题）')
                   + srcTag(real._src_title)
                   + '</div>');

        // 封面 — dedicated row showing WHICH source supplied the patched
        // cover. The cover itself isn't shown in tooltip (it's on the
        // card img), so this row exists purely for source attribution.
        if (real.cover && real._src_cover) {
            parts.push(row('封面', '<span style="color:#888;font-size:11px">已恢复</span>', real._src_cover));
        }

        // UP 主
        if (real.upper && (real.upper.name || real.upper.face)) {
            var faceUrl = real.upper.face ? real.upper.face.replace(/^http:\/\//, 'https://') : '';
            // Only render the avatar img for absolute http(s) faces (esc still
            // guards attribute breakout; isHttpUrl rejects javascript:/data:).
            var avatar = isHttpUrl(faceUrl)
                ? '<img src="' + esc(faceUrl) + '" '
                  + 'style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:6px;background:#444" />'
                : '';
            var uid = real.upper.mid ? ' <span style="color:#888;font-size:11px">UID ' + esc(real.upper.mid) + '</span>' : '';
            parts.push(row('UP 主', avatar + esc(real.upper.name || '（未知）') + uid, real._src_upper));
        }

        // Stats — no emoji, Chinese labels separated by middle dot.
        var c = real.cnt_info || {};
        var stats = [];
        if (c.play     != null) stats.push('播放 '  + fmtCount(c.play));
        if (c.danmaku  != null) stats.push('弹幕 '  + fmtCount(c.danmaku));
        if (c.thumb_up != null) stats.push('点赞 '  + fmtCount(c.thumb_up));
        if (c.reply    != null) stats.push('评论 '  + fmtCount(c.reply));
        if (c.collect  != null) stats.push('收藏 '  + fmtCount(c.collect));
        if (stats.length) parts.push(row('数据', stats.join('  ·  '), real._src_cnt_info));

        // Duration
        var dur = real.playback_desc || fmtDuration(real.duration);
        if (dur) parts.push(row('时长', esc(dur), real._src_duration || real._src_playback_desc));

        // BV + AV — always show both; if response only carries one, derive the other.
        var av = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : null);
        var bv = real.bvid || (av ? avToBv(av) : null);
        if (av) parts.push(row('AV', codeTag('av' + av)));
        if (bv) parts.push(row('BV', codeTag(bv), real._src_bvid));

        // Dates — invalid-item snapshots may omit some date fields. Show
        // the row regardless so user knows what's missing vs unknown.
        var pubT = fmtTime(pickPubTs(real));
        var favT = fmtTime(real.fav_time);
        var dateBits = [];
        dateBits.push('投稿 ' + (pubT || '<span style="color:#777">快照未记录</span>'));
        dateBits.push('收藏 ' + (favT || '<span style="color:#777">快照未记录</span>'));
        // Use the source that gave us at least one of the two dates
        // (typically public).
        var dateSrc = pickPubSrc(real) || real._src_fav_time;
        parts.push(row('日期', dateBits.join('  ·  '), dateSrc));

        // Intro (truncated to 240).
        if (real.intro && real.intro.trim()) {
            var intro = real.intro.length > 240 ? real.intro.slice(0, 240) + '…' : real.intro;
            parts.push('<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);color:#bdbdc2;white-space:pre-wrap;word-break:break-word;font-size:12px">'
                       + esc(intro)
                       + srcTag(real._src_intro)
                       + '</div>');
        }

        // Footer — list of contributing sources + sources that queried but
        // returned nothing. Two fields drive this:
        //   _sources    = sources whose data ended up in some merged field
        //   _attempted  = every source that actually queried this av
        //                 (phase 1 paginated + phase 2 per-av). Tooltip
        //                 shows attempted-minus-contributing as "已查询但
        //                 无记录" so the user can see "android + public
        //                 + biliplus all came back empty, only jijidown
        //                 had it" instead of those sources silently
        //                 disappearing.
        //   _attempted_3rd = legacy field (3rd-party only). Read as a
        //                    fallback so pre-0.7.2 cached entries still
        //                    show whatever attempts they have.
        var srcChips = '';
        if (real._sources && real._sources.length) {
            srcChips = '<div style="margin-top:4px">数据来源：' + real._sources.map(srcTag).join('') + '</div>';
        }
        var attempted = real._attempted || real._attempted_3rd || [];
        var missAttempts = attempted.filter(function (s) {
            return !real._sources || real._sources.indexOf(s) === -1;
        });
        var missChips = '';
        if (missAttempts.length) {
            missChips = '<div style="margin-top:2px;color:#777">已查询但无记录：'
                      + missAttempts.map(srcTag).join('') + '</div>';
        }
        parts.push('<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                   + 'fav-fix · 数据来自收藏时的快照'
                   + srcChips
                   + missChips
                   + '</div>');
        return parts.join('');
    }

    function showTip(el, real, evt) {
        var tip = getTip();
        stopTipRefresh();
        tip.innerHTML = buildTipHtml(real);
        tip.style.display = 'block';
        // Position: prefer above the element, centered horizontally;
        // if it would clip off the top, place it below.
        var r = el.getBoundingClientRect();
        var vw = window.innerWidth, vh = window.innerHeight;
        // Make sure layout is computed before reading offsetWidth.
        tip.style.left = '0px'; tip.style.top = '0px';
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        var left = Math.max(8, Math.min(vw - tw - 8, r.left + r.width / 2 - tw / 2));
        var top  = r.top - th - 10;
        if (top < 8) top = Math.min(vh - th - 8, r.bottom + 10);
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
        // rAF so the opacity transition actually animates from 0 → 1.
        requestAnimationFrame(function () { tip.style.opacity = '1'; });

        // Pending card: keep the live status fresh while hovering. Re-read the
        // element's CURRENT real each tick (el.__favFixReal) so that if the flap
        // loop recovers this card mid-hover, the tooltip upgrades to the normal
        // rich layout and the refresh stops on its own. Position is left as set
        // (content height barely changes between ticks).
        if (real && real._pending) {
            _tipRefreshTimer = setInterval(function () {
                if (tip.style.display === 'none') { stopTipRefresh(); return; }
                var liveReal = (el && el.__favFixReal) || real;
                tip.innerHTML = buildTipHtml(liveReal);
                if (!liveReal._pending) stopTipRefresh();
            }, 1000);
        }
    }
    function hideTip() {
        var tip = getTip();
        stopTipRefresh();
        tip.style.opacity = '0';
        setTimeout(function () {
            if (tip.style.opacity === '0') tip.style.display = 'none';
        }, 150);
    }

    // ─── Per-card menu injection ────────────────────────────────────────
    //
    // bilibili's own three-dot dropdown on each card (the "更多操作" menu)
    // is the most natural place for per-item actions — copy AV/BV/full
    // info, open the cover in a new tab, jump to a mirror site, clear
    // this item's cache. cerenkov's approach (mouseenter on the trigger,
    // delay 500ms, find the dynamically-rendered popper, append) works
    // well; we port it to vanilla and add dedup via data-fav-fix-key
    // so each item is only injected once per session.

    function buildPlainInfo(real) {
        var av = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : null);
        var bv = real.bvid || (av ? avToBv(av) : null);
        // tag(field) → '[src]' or '' — inline source attribution.
        function tag(field) {
            var s = real['_src_' + field];
            return s ? ' [' + s + ']' : '';
        }
        var lines = [];
        lines.push('【fav-fix】数据来自收藏时的快照');
        lines.push('────────────');
        lines.push('标题：' + (real.title || '（无）') + tag('title'));
        if (real.cover)                lines.push('封面：（已恢复）' + tag('cover'));
        if (real.upper)                lines.push('UP 主：' + (real.upper.name || '（无）') + (real.upper.mid ? '  UID ' + real.upper.mid : '') + tag('upper'));
        if (av) lines.push('AV：av' + av);
        if (bv) lines.push('BV：' + bv + tag('bvid'));
        if (real.duration || real.playback_desc) lines.push('时长：' + (real.playback_desc || fmtDuration(real.duration)) + tag('duration'));
        if (real.cnt_info) {
            var c = real.cnt_info, bits = [];
            if (c.play     != null) bits.push('播放 ' + c.play);
            if (c.danmaku  != null) bits.push('弹幕 ' + c.danmaku);
            if (c.thumb_up != null) bits.push('点赞 ' + c.thumb_up);
            if (c.coin     != null) bits.push('投币 ' + c.coin);
            if (c.reply    != null) bits.push('评论 ' + c.reply);
            if (c.collect  != null) bits.push('收藏 ' + c.collect);
            if (bits.length) lines.push('数据：' + bits.join('  ·  ') + tag('cnt_info'));
        }
        if (real.tid != null)    lines.push('分区 TID：' + real.tid + tag('tid'));
        // Use the same fallback chain + source as the hover tooltip
        // (pickPubTs / pickPubSrc) so copied text matches what was shown.
        var _pubTs = pickPubTs(real);
        if (_pubTs) {
            var _pubSrc = pickPubSrc(real);
            lines.push('投稿：' + new Date(_pubTs * 1000).toLocaleString() + (_pubSrc ? ' [' + _pubSrc + ']' : ''));
        }
        if (real.fav_time)       lines.push('收藏：' + new Date(real.fav_time * 1000).toLocaleString() + tag('fav_time'));
        if (real.intro && real.intro.trim()) lines.push('简介：' + real.intro + tag('intro'));
        if (real.link)           lines.push('原 link：' + real.link);
        lines.push('────────────');
        if (real._sources) lines.push('数据来源：' + real._sources.join('、'));
        // Same split as buildTipHtml's footer: show "queried but empty"
        // sources so the user copying full info also sees the full chain.
        var pAttempted = real._attempted || real._attempted_3rd || [];
        var pMiss = pAttempted.filter(function (s) {
            return !real._sources || real._sources.indexOf(s) === -1;
        });
        if (pMiss.length) lines.push('已查询但无记录：' + pMiss.join('、'));
        return lines.join('\n');
    }

    function buildMenuItems(hit, real) {
        var av = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : null);
        // Re-read the freshest cache entry. The `real` captured when injectCardMenu
        // bound this card's dropdown can be STALE: a pending card may have since
        // recovered (or vice-versa), and the new-UI popper handler keeps the
        // original closure. av/bv identity is stable, but _pending / title /
        // sources may have changed — build from the live entry so a recovered
        // card never shows "立即重试" and a pending card never copies an empty
        // snapshot. (buildMenuItems runs fresh on each menu open, so this stays
        // current.)
        if (av) { var _lc = loadCache(av); if (_lc) real = _lc; }
        var bv = real.bvid || (av ? avToBv(av) : null);
        // Same live-read reasoning as the loadCache line above, for the same
        // reason: the user may have stopped or resumed this av since the
        // dropdown was bound, and the closure would show the stale action.
        var stopped = av ? isNoRetryUser(av) : false;
        var items = [];
        // Retry controls, mutually exclusive by card state (the existing
        // 立即重试 / 清缓存并重抓 split, now with the stop switch folded in):
        //   stopped                       → 恢复重试 only. Offering 立即重试 next
        //                                   to it would be two buttons for one
        //                                   decision the user already made.
        //   _pending                      → 立即重试 (re-arm now) + 停止重试.
        //   _cover_pending                → 停止重试 only. Those cards are
        //                                   already patched and carry NO badge
        //                                   (the cover is being chased quietly
        //                                   in the background), so the menu is
        //                                   the single entry point for them.
        if (av && stopped) items.push({
            key: 'retry', label: '恢复重试',
            onClick: function () { resumeRetryForAv(av); }
        });
        else if (av && real._pending) {
            items.push({
                key: 'retry', label: '立即重试',
                onClick: function () { kickManualRetry(av); }
            });
            items.push({
                key: 'stop-retry', label: '停止重试',
                onClick: function () { stopRetryForAv(av); }
            });
        }
        else if (av && real._cover_pending) items.push({
            key: 'stop-retry', label: '停止重试',
            onClick: function () { stopRetryForAv(av); }
        });
        if (av) items.push({
            key: 'cp-av', label: '复制 AV 号',
            successMsg: '已复制 av' + av + ' 至剪贴板',
            onClick: function () { GM_setClipboard('av' + av, 'text'); }
        });
        if (bv) items.push({
            key: 'cp-bv', label: '复制 BV 号',
            successMsg: '已复制 ' + bv + ' 至剪贴板',
            onClick: function () { GM_setClipboard(bv, 'text'); }
        });
        items.push({
            key: 'cp-info', label: '复制完整信息',
            successMsg: '完整信息已复制至剪贴板',
            onClick: function () { GM_setClipboard(buildPlainInfo(real), 'text'); }
        });
        // Cover URL may come from an untrusted 3rd-party source — only offer
        // "open cover" for an absolute http(s) URL (isHttpUrl rejects
        // javascript:/data: that GM_openInTab would otherwise navigate to).
        var coverUrl = real.cover ? String(real.cover).replace(/^http:\/\//, 'https://') : '';
        if (coverUrl && !COVER_PLACEHOLDER_RE.test(coverUrl) && isHttpUrl(coverUrl)) items.push({
            key: 'open-cover', label: '查看原始封面',
            onClick: function () {
                // Re-check at click time (defensive; coverUrl is captured above).
                if (!isHttpUrl(coverUrl)) { toast('封面链接异常，已拦截', 'warn'); return; }
                GM_openInTab(coverUrl, { active: true, insert: true, setParent: true });
            }
        });
        if (av) items.push({
            key: 'open-bp', label: '在 biliplus 查看',
            onClick: function () {
                GM_openInTab('https://www.biliplus.com/video/av' + av + '/',
                             { active: true, insert: true, setParent: true });
            }
        });
        // Hidden on _pending cards: they have no real cached snapshot to clear
        // (just a placeholder stub), so "清缓存并重抓" is a heavier, noisier
        // duplicate of "立即重试" (full-page foreground re-resolve + spinner
        // re-flash vs. a quiet android re-walk). The two retry-flavored actions
        // are mutually exclusive by card state: 立即重试 for pending, 清缓存并重抓
        // for recovered/terminal cards where nuking a possibly-wrong snapshot
        // actually means something. (real is the live loadCache re-read above,
        // so this self-corrects as the card transitions pending↔recovered.)
        // Also hidden while the av is user-stopped: "恢复重试" already IS a
        // clear-and-refetch (resumeRetryForAv drops the caches and re-runs
        // patchOnce), and a second button that clears the cache while every
        // network path stays suppressed would only downgrade a patched card to
        // a bare pending stub.
        if (av && !real._pending && !stopped) items.push({
            // Label kept short to avoid wrapping inside bilibili's
            // fixed-width card-menu popper. "清除本条缓存并重新抓取" (11
            // chars) wrapped to two lines and the second line overflowed
            // the popper bounds — see git log around this label change.
            key: 'clear-cache', label: '清缓存并重抓',
            successMsg: '缓存已清除，重新抓取中',
            onClick: function () {
                // An 'auto' 停止重试 record would silently gut this action:
                // the caches would be dropped and then resolveItems would skip
                // every network source, leaving the card worse off than before
                // the click. An explicit user action overrides what the loop
                // concluded, so drop that record too. (A 'user' record cannot be
                // present — this item is not offered for stopped cards.)
                clearNoRetry(av);
                // Cache nuke for this av (GM item + in-memory rows + page
                // promises). Shared with forceRefetch() via dropItemCaches so
                // both paths really re-fetch instead of re-merging stale rows.
                dropItemCaches(av);

                // The hit captured in this closure is from whenever
                // injectCardMenu was last called — possibly stale by now if
                // bilibili's SPA re-rendered the card. Operating on stale
                // refs paints overlays into detached subtrees that the user
                // never sees. Re-resolve to the LIVE element by hunting for
                // the card whose link mentions this av's avid or bvid.
                var bvid = null;
                try { bvid = avToBv(av); } catch (e) { /* invalid av */ }
                var sel = 'a[href*="/video/av' + av + '"]'
                        + (bvid ? ', a[href*="/video/' + bvid + '"]' : '');
                var liveContainer = null, liveImg = null;
                document.querySelectorAll(sel).forEach(function (a) {
                    if (liveContainer) return;
                    // Resolve to the WHOLE card (same scope findInvalidContainers
                    // now uses) so the title reset, mark-clearing, and the
                    // __favFixReal tooltip binding all act on the node markPatched
                    // actually touched — the cover-only sub-div never held the
                    // title leaf, which is why the reset used to miss it.
                    var card = a.closest(CARD_SELECTOR);
                    if (card) {
                        liveContainer = card;
                        liveImg = card.querySelector('img[src*="' + PLACEHOLDER_COVER_TOKEN + '"]')
                                  || card.querySelector('img');
                        return;
                    }
                    var n = a;
                    while (n && n !== document.body) {
                        var img = n.querySelector && n.querySelector('img');
                        if (img) { liveContainer = n; liveImg = img; return; }
                        n = n.parentElement;
                    }
                });
                // Fallback to closure hit if live lookup misses (defensive
                // — should not happen for a card the user just clicked).
                if (!liveContainer) liveContainer = hit && hit.container;
                if (!liveImg)       liveImg       = hit && hit.img;

                // Tear down any prior overlay on the LIVE img (rapid
                // double-click stacks spinners otherwise).
                if (liveImg) clearLoading({ img: liveImg, container: liveContainer });

                // Reset img: restore the placeholder src if we swapped it,
                // strip inline styles applied by markPatched / _no_source,
                // drop marker attrs so findInvalidContainers re-detects.
                if (liveImg) {
                    var orig = liveImg.getAttribute('data-fav-fix-original');
                    if (orig) {
                        liveImg.src = orig;
                        liveImg.removeAttribute('data-fav-fix-original');
                    }
                    liveImg.style.outline = '';
                    liveImg.style.outlineOffset = '';
                    liveImg.style.opacity = '';
                    liveImg.style.filter = '';
                    liveImg.removeAttribute('data-fav-fix-marked');
                    liveImg.removeAttribute('data-fav-fix-loading');
                }
                // Reset container: revert any title text we wrote
                // (recovered title or "（视频已删除）"), drop marker attrs.
                // Keep `data-fav-fix-tipbound` + bound listeners — they
                // read __favFixReal live, so the next markPatched picks up
                // the new payload automatically.
                if (liveContainer) {
                    var prevReal = liveContainer.__favFixReal;
                    var patchedTitles = ['（视频已删除）'];
                    if (prevReal && prevReal.title) patchedTitles.push(prevReal.title);
                    var walker = document.createTreeWalker(liveContainer, NodeFilter.SHOW_TEXT, null);
                    var node;
                    while ((node = walker.nextNode())) {
                        var t = node.nodeValue.trim();
                        if (patchedTitles.indexOf(t) !== -1) {
                            node.nodeValue = node.nodeValue.replace(t, INVALID_TITLE);
                        }
                    }
                    patchedTitles.forEach(function (pt) {
                        liveContainer.querySelectorAll('[title="' + pt + '"]').forEach(function (el) {
                            el.setAttribute('title', INVALID_TITLE);
                        });
                    });
                    liveContainer.removeAttribute('data-fav-fix-marked');
                    liveContainer.removeAttribute('data-fav-fix-loading');
                    liveContainer.__favFixReal = null;
                }

                // Paint spinner on the LIVE img immediately — user sees the
                // click took effect before any network round-trip.
                if (liveImg) markLoading({ img: liveImg, container: liveContainer });

                // Fire patchOnce immediately rather than going through
                // schedule()'s 400ms debounce — the user just told us they
                // want action now. patchOnce dedups via `data-fav-fix-loading`
                // so the spinner we just painted won't double-stack.
                patchOnce().catch(function (e) { warn('clear-cache patchOnce threw:', e); });
            }
        });
        return items;
    }

    function appendMenuItems(popper, items, opts) {
        // opts: { itemClass, itemTag }
        // Clear-then-append, NOT dedup-by-key. bilibili's new-UI dropdown reuses
        // / pools popper nodes across cards (observed: the same popper, or a
        // small pool, serves whichever card is hovered). The old dedup-by-key
        // kept the FIRST card's items when a different card reused the popper —
        // so a card could show a previous card's stale av bindings, or (once the
        // item set became state-specific) a recovered card showing 立即重试 / a
        // pending card showing 清缓存并重抓. Removing our prior items first
        // guarantees the popper reflects ONLY the current card. The handler
        // re-runs on every trigger mouseenter, so this stays fresh; it only ever
        // touches our own [data-fav-fix-key] nodes, never bilibili's.
        Array.from(popper.querySelectorAll('[data-fav-fix-key]')).forEach(function (el) { el.remove(); });
        items.forEach(function (it) {
            var el = document.createElement(opts.itemTag || 'div');
            el.className = opts.itemClass + ' bili-fav-fix-menu-item';
            el.setAttribute('data-fav-fix-key', it.key);
            el.textContent = it.label;
            el.style.cursor = 'pointer';
            // Hard cap on item width — bilibili's popper is fixed-width and
            // long labels otherwise wrap onto a 2nd line that bleeds past
            // the popper edge. nowrap + ellipsis truncates cleanly inside
            // the popper if someone ever adds a label past ~6 Chinese chars.
            el.style.whiteSpace   = 'nowrap';
            el.style.overflow     = 'hidden';
            el.style.textOverflow = 'ellipsis';
            el.addEventListener('click', function (e) {
                e.stopPropagation();
                try { it.onClick(); } catch (err) { warn('menu', it.key, 'threw', err); }
                // Confirmation goes to the toast (bottom-center), NOT back
                // into the menu cell. Previous in-place text replacement
                // (label = successMsg for 1.5s) caused the menu to bleed
                // out of bounds because the popper width is fixed and most
                // successMsgs were 10+ chars. Toast has its own width logic
                // (max-width + word-wrap) so it handles long strings.
                if (it.successMsg) toast(it.successMsg, 'ok');
            });
            popper.appendChild(el);
        });
    }

    function injectCardMenu(hit, real) {
        if (!hit.container) return;

        // New UI: trigger is .bili-card-dropdown inside the card; the
        // popper is rendered LATE (appended to body, not the card) and
        // gets class .visible only while it's open. Wait 500ms after
        // mouseenter to give the popper time to render before we look.
        var trigger = hit.container.querySelector('.bili-card-dropdown');
        if (trigger && !trigger.__favFixBound) {
            trigger.__favFixBound = true;
            trigger.addEventListener('mouseenter', function () {
                // Card mouseenter already fired our hover tooltip; close it
                // so it doesn't overlap with the B 站 native dropdown popper.
                // (mouseleave on the card never fires because the three-dot
                // is INSIDE the card.)
                hideTip();
                setTimeout(function () {
                    var popper = document.querySelector('.bili-card-dropdown-popper.visible');
                    if (!popper) { log('new-UI popper not visible at inject time'); return; }
                    hideTip();   // belt-and-suspenders: kill tooltip again when popper appears
                    appendMenuItems(popper, buildMenuItems(hit, real), {
                        itemClass: 'bili-card-dropdown-popper__item',
                        itemTag: 'div'
                    });
                }, 500);
            });
            return;
        }

        // Old UI: <ul class="be-dropdown-menu"> rendered inline inside
        // the card. We can append directly (no async wait). The trigger
        // is .be-dropdown-trigger; bind tooltip-hide on it too.
        var oldTrigger = hit.container.querySelector('.be-dropdown-trigger');
        if (oldTrigger && !oldTrigger.__favFixBound) {
            oldTrigger.__favFixBound = true;
            oldTrigger.addEventListener('mouseenter', hideTip);
        }
        var oldMenu = hit.container.querySelector('.be-dropdown-menu');
        if (oldMenu && !oldMenu.__favFixBound) {
            oldMenu.__favFixBound = true;
            appendMenuItems(oldMenu, buildMenuItems(hit, real), {
                itemClass: 'be-dropdown-item',
                itemTag: 'li'
            });
        }
    }

    // ─── Loading indicator ──────────────────────────────────────────────
    //   Painted the instant findInvalidContainers() returns a hit (BEFORE
    //   any API call). Visual = white semi-transparent overlay on the cover
    //   area with a centered gray rotating ring. The user picked this style
    //   over the previous orange-pulse-outline + corner-badge combo.
    //
    //   Lifecycle:
    //     - markLoading(hit) on detect (patchOnce, before resolveItems)
    //     - clearLoading(hit) on resolve failure (patchOnce catch)
    //     - clearLoading(hit) on _no_source / no-img path (markPatched call)
    //     - clearLoading(hit) on img.onload / onerror (success-with-cover
    //       path) so the overlay outlives the cover-src swap and the user
    //       doesn't see the gray placeholder flicker to the real cover
    //     - clearLoading(hit) safety-net timer (4s) for edge cases where
    //       neither onload nor onerror fires (browser-cached src etc.)
    //
    //   Idempotent via data-fav-fix-loading on img + container. Skips hits
    //   with no img (Strategy 2 / inline-SVG placeholders): they have no
    //   cover area to anchor an overlay to, so no visual feedback there —
    //   acceptable, those hits are rare.

    var _loadingStylesInjected = false;
    function ensureLoadingStyles() {
        if (_loadingStylesInjected) return;
        _loadingStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_loading_styles';
        st.textContent = [
            // Spinner: only rotate is animated; centering is via flexbox on
            // the overlay parent, so the transform doesn't fight the
            // centering math (a common spinner bug).
            '@keyframes __fav_fix_spin {',
            '  to { transform: rotate(360deg); }',
            '}',
            '.fav-fix-loading-overlay {',
            '  position: absolute; inset: 0;',
            '  background: rgba(255,255,255,.42);',
            '  z-index: 2147483645;',
            '  pointer-events: none;',
            '  display: flex; align-items: center; justify-content: center;',
            // Inherit cover rounded corners so the overlay doesn't bleed
            // past the card's curved edges. bilibili cover wraps use ~6px
            // border-radius; `inherit` picks that up automatically.
            '  border-radius: inherit;',
            '}',
            '.fav-fix-loading-spinner {',
            '  width: 32px; height: 32px;',
            // Ring effect: faint full circle + opaque top arc that rotates.
            '  border: 3px solid rgba(120,120,120,.22);',
            '  border-top-color: rgba(80,80,80,.85);',
            '  border-radius: 50%;',
            '  animation: __fav_fix_spin 0.9s linear infinite;',
            '}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    function markLoading(hit) {
        // Skip if no img — Strategy 2 (title-text fallback) hits have no
        // cover area to anchor an overlay to. Painting on the whole card
        // container would obscure the title/footer too aggressively.
        if (!hit || !hit.img) return;
        if (hit.img.getAttribute('data-fav-fix-loading')) return; // dedup
        if (hit.img.getAttribute('data-fav-fix-marked'))  return; // already done

        ensureLoadingStyles();
        var coverWrap = hit.img.parentElement;
        if (!coverWrap) return;
        // Defensive: if bilibili's cover wrap happens to be position:static
        // (shouldn't be — they have play-time badges etc. that need it),
        // promote to relative so the overlay anchors correctly. Won't
        // affect layout when already positioned.
        var pos = (coverWrap.ownerDocument.defaultView || window)
                    .getComputedStyle(coverWrap).position;
        if (pos === 'static') coverWrap.style.position = 'relative';

        var overlay = document.createElement('div');
        overlay.className = 'fav-fix-loading-overlay';
        overlay.setAttribute('data-fav-fix-overlay', '1');
        var spinner = document.createElement('div');
        spinner.className = 'fav-fix-loading-spinner';
        overlay.appendChild(spinner);
        coverWrap.appendChild(overlay);

        hit.img.setAttribute('data-fav-fix-loading', '1');
        // Mark container too so stats().cardsLoading reflects card count
        // (a card == one img). Container attr is the truth source for
        // counting; img attr is what the dedup check reads.
        if (hit.container) hit.container.setAttribute('data-fav-fix-loading', '1');
    }

    function clearLoading(hit) {
        if (!hit) return;
        if (hit.img) {
            hit.img.removeAttribute('data-fav-fix-loading');
            var coverWrap = hit.img.parentElement;
            if (coverWrap) {
                var overlay = coverWrap.querySelector('[data-fav-fix-overlay]');
                if (overlay) overlay.remove();
            }
        }
        if (hit.container) {
            hit.container.removeAttribute('data-fav-fix-loading');
            // Belt-and-braces: scan container for orphaned overlays in case
            // some bilibili DOM reshuffle moved the img between markLoading
            // and clearLoading (rare but observed on virtualized scrolls).
            var stray = hit.container.querySelectorAll('[data-fav-fix-overlay]');
            for (var i = 0; i < stray.length; i++) stray[i].remove();
        }
    }

    // ─── Retry indicator (background android flap recovery) ──────────────
    //   A small corner badge on the cover so the user can SEE that a deleted
    //   item is being re-fetched in the background (runFlapRecovery), instead
    //   of the card looking inert — and, since 0.13.0, the switch that turns
    //   that retrying off. Three states, passed as a string:
    //     'active'  → spinning dot + "重试中" (loop alive — owns the retry,
    //                 keeps sampling android on its backoff)
    //     'waiting' → pulsing gray + "待重试" (loop gave up; a fresh reload
    //                 re-kicks it, OR the card's "立即重试" menu item does so
    //                 on demand via kickManualRetry)
    //     'stopped' → static dark gray + "已停止重试" (the user pressed the
    //                 badge; the av is on the 停止重试 list and no automatic
    //                 path will request it again)
    //   Hovering swaps the label to the action the click performs (停止重试 /
    //   恢复重试). That swap is PURE CSS — two spans, one hidden by :hover —
    //   because MutationObserver re-runs the patch pass constantly and a JS
    //   textContent swap would fight the hover state on every tick.
    //   The badge is just the at-a-glance cue; the FULL explanation of what the
    //   three states mean lives in the card's hover tooltip (buildTipHtml's
    //   _pending branch), bound for pending cards via bindCardAffordances.
    //   Removed by clearPending() the moment the item recovers (real cover) or
    //   is written terminal. Distinct from markLoading's full-cover overlay so
    //   it reads as "still trying" rather than "page loading". No emoji.
    var _retryStylesInjected = false;
    function ensureRetryStyles() {
        if (_retryStylesInjected) return;
        _retryStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_retry_styles';
        st.textContent = [
            '@keyframes __fav_fix_retry_spin { to { transform: rotate(360deg); } }',
            '@keyframes __fav_fix_retry_pulse { 0%,100%{opacity:.95} 50%{opacity:.5} }',
            '.fav-fix-retry-badge {',
            '  position:absolute; left:6px; top:6px; z-index:2147483646;',
            '  display:flex; align-items:center; gap:5px;',
            '  padding:3px 7px; border-radius:10px;',
            '  font:600 11px/1 -apple-system,Segoe UI,sans-serif;',
            '  color:#fff; background:rgba(192,57,43,.82);',
            // Status only, never a click target. The action lives in the
            // centred button below, where the user can actually see it.
            '  pointer-events:none; user-select:none;',
            '}',
            '.fav-fix-retry-badge .fav-fix-retry-dot {',
            '  width:9px; height:9px; border-radius:50%;',
            '  border:2px solid rgba(255,255,255,.4); border-top-color:#fff;',
            '  animation:__fav_fix_retry_spin .8s linear infinite;',
            '}',
            '.fav-fix-retry-badge.waiting {',
            '  background:rgba(127,140,141,.8);',
            '  animation:__fav_fix_retry_pulse 1.8s ease-in-out infinite;',
            '}',
            '.fav-fix-retry-badge.waiting .fav-fix-retry-dot { animation:none; border-top-color:rgba(255,255,255,.55); }',
            // Stopped: no animation anywhere and no spinner dot. The card must
            // read as "nothing is happening here", which is the whole point.
            '.fav-fix-retry-badge.stopped {',
            '  background:rgba(60,64,67,.88);',
            '  animation:none;',
            '}',
            '.fav-fix-retry-badge.stopped .fav-fix-retry-dot { display:none; }',
            // THE action control: a real button, centred on the cover, visible
            // at rest. An earlier revision made the corner badge itself
            // clickable, and a status label reads as a status label no matter
            // what it does on hover. The affordance has to be its own object,
            // sitting where the eye already lands.
            //
            // Icon-only and circular: a labelled pill covers a third of the
            // cover art. The wording survives as title + aria-label, so the
            // meaning is one hover away and screen readers still get it.
            '.fav-fix-retry-action {',
            '  position:absolute; left:50%; top:50%;',
            '  transform:translate(-50%,-50%); z-index:2147483646;',
            '  width:52px; height:52px; border-radius:50%;',
            '  display:flex; align-items:center; justify-content:center;',
            '  border:1px solid rgba(255,255,255,.18);',
            '  color:#fff; background:rgba(28,28,30,.86);',
            '  cursor:pointer; pointer-events:auto; user-select:none;',
            '  box-shadow:0 2px 10px rgba(0,0,0,.35);',
            '  transition:background .15s, box-shadow .15s, transform .12s;',
            '}',
            '.fav-fix-retry-action svg { width:36px; height:36px; display:block; fill:currentColor; }',
            '.fav-fix-retry-action > * { pointer-events:none; }',
            // Every transform here MUST re-state translate(-50%,-50%): the
            // centring lives in the same property, so a bare scale() would
            // snap the button to the cover's bottom-right quadrant on hover.
            '.fav-fix-retry-action:hover {',
            '  background:rgba(192,57,43,.92); box-shadow:0 3px 14px rgba(0,0,0,.45);',
            '  transform:translate(-50%,-50%) scale(1.08);',
            '}',
            '.fav-fix-retry-action:active { transform:translate(-50%,-50%) scale(.94); }',
            '.fav-fix-retry-action.resume:hover { background:rgba(52,120,190,.92); }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // Badge label per state. Status wording only; it is not clickable.
    var RETRY_BADGE_TEXT = {
        active:  '重试中',
        waiting: '待重试',
        stopped: '已停止重试'
    };
    // Button wording per state. Names the ACTION, never the state. No longer
    // rendered as visible text — it is the button's title and accessible name.
    var RETRY_ACTION_TEXT = {
        active:  '停止重试',
        waiting: '停止重试',
        stopped: '恢复重试'
    };
    // Button glyph per state. A stop square and a refresh arrow, deliberately
    // NOT a pause/play pair: a play triangle centred on a video cover reads as
    // "play this video", which is exactly the wrong thing to suggest here.
    var RETRY_ACTION_ICON = {
        active:  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        waiting: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        stopped: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>'
    };

    // Write a state onto an existing badge. Early-returns when the state is
    // unchanged so the observer's repeated patch passes don't churn text nodes.
    function applyRetryBadgeState(badge, state) {
        if (!RETRY_BADGE_TEXT[state]) state = 'waiting';
        if (badge.getAttribute('data-fav-fix-retry-state') === state) return;
        badge.setAttribute('data-fav-fix-retry-state', state);
        badge.classList.toggle('waiting', state === 'waiting');
        badge.classList.toggle('stopped', state === 'stopped');
        var t = badge.querySelector('[data-fav-fix-retry-txt]');
        if (t) t.textContent = RETRY_BADGE_TEXT[state];
    }

    // Same for the action button. data-fav-fix-retry-state on the BUTTON is the
    // click handler's source of truth, so it is stamped here rather than read
    // off the badge: the two nodes are updated in the same pass, but the
    // handler must not depend on that ordering.
    function applyRetryActionState(btn, state) {
        if (!RETRY_ACTION_TEXT[state]) state = 'waiting';
        btn.classList.toggle('resume', state === 'stopped');
        if (btn.getAttribute('data-fav-fix-retry-state') === state) return;
        btn.setAttribute('data-fav-fix-retry-state', state);
        btn.innerHTML = RETRY_ACTION_ICON[state];
        btn.title = RETRY_ACTION_TEXT[state];
        btn.setAttribute('aria-label', RETRY_ACTION_TEXT[state]);
    }

    // The two user-facing transitions, defined once so the cover button, the
    // card menu (11-menu.js) and the debug surface (17-boot.js) cannot drift.
    function stopRetryForAv(av) {
        setNoRetryUser(av);
        toast('已停止重试，可再次点击恢复', 'ok');
        // Repaint so any other card of the same av (and the control, when the
        // caller did not update it in place) reflects the new state.
        schedule();
    }
    function resumeRetryForAv(av) {
        clearNoRetry(av);
        // Drop the _pending stub as well: with the suppression gone the whole
        // point is to ask the network again, and a live short-TTL stub would
        // have patchOnce serve the cached "still nothing" instead.
        dropItemCaches(av);
        toast('已恢复重试，正在重新抓取', 'ok');
        patchOnce().catch(function (e) { warn('resume-retry patchOnce threw:', e); });
    }

    // Bind the button's click ONCE per element. Idempotent via
    // __favFixActionBound because markPending re-runs on every observer tick
    // for the same node.
    function bindRetryAction(btn) {
        if (btn.__favFixActionBound) return;
        btn.__favFixActionBound = true;
        // The button sits inside the card, and the card is an <a>.
        // stopPropagation keeps the event away from the card's own handlers and
        // from bilibili's document-level delegates, but it does NOT stop the
        // anchor's default navigation, which needs preventDefault. Both are
        // applied to mousedown as well as click: bilibili has document-level
        // listeners that rewrite anchor behaviour (AGENTS.md gotcha 20, last
        // bullet: an <a> appended to the document had its blob: href hijacked
        // and navigated the whole tab), and some of that machinery acts before
        // a click event ever exists.
        var swallow = function (e) { e.preventDefault(); e.stopPropagation(); };
        btn.addEventListener('mousedown', swallow);
        btn.addEventListener('click', function (e) {
            swallow(e);
            // Read av + state from the DOM at click time, never from a closure:
            // this node is reused by later render passes (and by bilibili's
            // virtualized scroll), so a captured value goes stale the moment the
            // card's state, or the card itself, changes.
            var av = btn.getAttribute('data-fav-fix-retry-av');
            if (!av) return;
            if (btn.getAttribute('data-fav-fix-retry-state') === 'stopped') {
                // Flip out of 'stopped' HERE: nothing repaints this card until
                // applyPatch runs after the whole resolve (phase 2 alone is
                // budgeted at 10s), and a button still reading the resume label
                // stays clickable throughout. A second click would re-enter
                // resumeRetryForAv: another cache drop, another toast, and a
                // _patchDirty second full resolve pass.
                applyRetryActionState(btn, _flapBgRunning ? 'active' : 'waiting');
                resumeRetryForAv(av);
            } else {
                // Flip in place rather than waiting for the next render pass:
                // the flap loop may be mid-backoff and nothing else would touch
                // this card for up to two minutes.
                applyRetryActionState(btn, 'stopped');
                stopRetryForAv(av);
            }
        });
    }

    function markPending(hit, state, av) {
        if (!hit || !hit.img) return;          // need a cover area to anchor to
        var coverWrap = hit.img.parentElement;
        if (!coverWrap) return;
        ensureRetryStyles();
        var pos = (coverWrap.ownerDocument.defaultView || window)
                    .getComputedStyle(coverWrap).position;
        if (pos === 'static') coverWrap.style.position = 'relative';
        var badge = coverWrap.querySelector('[data-fav-fix-retry]');
        if (!badge) {
            badge = document.createElement('div');
            badge.setAttribute('data-fav-fix-retry', '1');
            badge.className = 'fav-fix-retry-badge';
            var dot = document.createElement('span');
            dot.className = 'fav-fix-retry-dot';
            var txt = document.createElement('span');
            txt.setAttribute('data-fav-fix-retry-txt', '1');
            badge.appendChild(dot);
            badge.appendChild(txt);
            coverWrap.appendChild(badge);
        }
        applyRetryBadgeState(badge, state);

        // The control itself, centred on the cover. Created alongside the badge
        // and torn down with it (clearPending removes both).
        var btn = coverWrap.querySelector('[data-fav-fix-retry-action]');
        if (!btn) {
            btn = document.createElement('div');
            btn.setAttribute('data-fav-fix-retry-action', '1');
            btn.setAttribute('role', 'button');
            btn.setAttribute('tabindex', '0');
            btn.className = 'fav-fix-retry-action';
            coverWrap.appendChild(btn);
        }
        // Re-stamped every pass: the same nodes can end up serving a different
        // card after a virtualized re-render.
        btn.setAttribute('data-fav-fix-retry-av', av == null ? '' : String(av));
        applyRetryActionState(btn, state);
        bindRetryAction(btn);
    }

    function clearPending(hit) {
        if (!hit) return;
        var scopes = [];
        if (hit.img && hit.img.parentElement) scopes.push(hit.img.parentElement);
        if (hit.container) scopes.push(hit.container);
        for (var s = 0; s < scopes.length; s++) {
            // Both nodes: the corner status badge and the centred action button.
            var b = scopes[s].querySelectorAll('[data-fav-fix-retry], [data-fav-fix-retry-action]');
            for (var i = 0; i < b.length; i++) b[i].remove();
        }
    }

    // ─── Mark a patched item ────────────────────────────────────────────
    //   - solid red outline (4px) on the cover img — uses CSS outline so
    //     it doesn't reflow layout; outline-offset:-4px tucks it inside
    //     the rounded-corner clip so it doesn't bleed past corners
    //   - rich hover tooltip showing title / UP / stats / dates / intro
    //   - data-fav-fix-marked guard avoids double-binding on observer re-runs

    // Bind the hover tooltip + inject our card-menu items onto a card, WITHOUT
    // touching its cover / outline / title. markPatched calls this for recovered
    // and terminal cards; applyPatch's pending branch calls it directly so a
    // card still being chased by the flap loop ALSO gets the rich tooltip (now a
    // 重试中/待重试 state explainer) and the "立即重试" menu item — previously
    // pending cards skipped markPatched entirely and were left with only a bare
    // badge. __favFixReal is read live by the tooltip handler, so a later
    // markPatched (on recovery) upgrades the tooltip in place without re-binding.
    function bindCardAffordances(hit, real) {
        var bindEl = hit.container || hit.img;
        if (!bindEl) return;
        bindEl.__favFixReal = real;
        if (!bindEl.getAttribute('data-fav-fix-tipbound')) {
            bindEl.setAttribute('data-fav-fix-tipbound', '1');
            bindEl.addEventListener('mouseenter', function (e) {
                if (bindEl.__favFixReal) showTip(bindEl, bindEl.__favFixReal, e);
            });
            bindEl.addEventListener('mouseleave', hideTip);
        }
        // Inject per-card menu items (复制 AV/BV、复制完整信息、查看封面、
        // 在 biliplus 打开、清缓存、以及 pending 卡的「立即重试」). Safe to call
        // repeatedly; dedup via data-fav-fix-key on the menu items themselves.
        try { injectCardMenu(hit, real); }
        catch (e) { warn('injectCardMenu threw:', e); }
    }

    function markPatched(hit, real) {
        // NOTE: clearLoading() is NOT called here. The caller (patchOnce
        // application loop) decides when to clear:
        //   - _no_source / Strategy-2 paths: clear immediately, no img-load
        //     to wait on.
        //   - success-with-cover path: wait for img.onload before clearing
        //     so the overlay covers the placeholder-to-real-cover swap.
        // Calling clearLoading here would defeat that "wait for onload"
        // behavior — the overlay would vanish the instant patchCover
        // assigns the new src, exposing the gray placeholder for the
        // ~150ms CDN download window.
        // Two visual styles:
        //   - recovered (any source returned data): solid red outline, the
        //     "we know what this used to be" cue.
        //   - unrecoverable (real._no_source): dashed gray outline, the
        //     "we tried every source and they all whiffed" cue. Lower
        //     visual weight so it doesn't shout when the situation is
        //     literally unfixable (true 404).
        var isUnrecoverable = real && real._no_source;
        var outlineCss = isUnrecoverable
            ? '3px dashed rgba(127,140,141,.85)'
            : '4px solid rgba(192,57,43,.85)';

        if (hit.img && !hit.img.getAttribute('data-fav-fix-marked')) {
            hit.img.setAttribute('data-fav-fix-marked', isUnrecoverable ? 'nodata' : '1');
            hit.img.style.outline = outlineCss;
            hit.img.style.outlineOffset = '-4px';
        }
        // Also mark the container so `stats().cardsMarked` reflects EVERY
        // patched card — not just ones whose placeholder was a real <img>.
        // Some bilibili layouts render the deleted-video placeholder as an
        // inline SVG inside the card with no <img> tag at all; those cards
        // hit findInvalidContainers via the title-text fallback and have
        // hit.img === null.
        if (hit.container && !hit.container.getAttribute('data-fav-fix-marked')) {
            hit.container.setAttribute('data-fav-fix-marked', isUnrecoverable ? 'nodata' : '1');
        }
        // Tooltip + card-menu binding, extracted so the pending branch
        // (applyPatch) can reuse it without the outline/title work above.
        bindCardAffordances(hit, real);
    }

    // ─── Missing-item recovery (task #15) ────────────────────────────────
    //
    // bilibili's `/x/v3/fav/resource/list` (web) and `/x/v3/fav/folder/
    // resources` (android) both silently drop a small number of items from
    // certain collections — observed example: a 222-item collection where
    // both endpoints return only 205 items across all pages. Those 17 items
    // therefore never get a DOM card on the web page, so the user can't
    // even see they're missing.
    //
    // The recovery path uses the lesser-known `/x/v3/fav/resource/ids`
    // endpoint, which returns the FULL av/bvid list with no metadata, no
    // pagination, and no filtering — bilibili-API-collect docs confirm
    // this is the "raw inventory" endpoint. Diff against what we've
    // actually collected; render a sticky banner listing the gap so the
    // user has at least the av/bvid + links to recover from elsewhere.
    //
    // Per-mediaId cache so we don't hammer the endpoint on every patchOnce.

    var _idsListCache = new Map();   // mediaId → Array<{id, bvid}>
    var _phase1AvsCache = new Map(); // mediaId → { avs:Set<avStr>, complete:bool }
    var _missingBannerShown = new Set();   // mediaId values we've already rendered for
    var _missingInFlight = new Map();      // mediaId → Promise (dedup concurrent scans)

    // Flush EVERY in-memory cache at once: paginated page promises, raw rows,
    // ids list, phase-1 avs, banner-shown set, and in-flight scan dedup.
    // Used by the SPA folder-switch handler and the "清除所有缓存" menu.
    // Persistent GM item cache is NOT touched here — callers that want it gone
    // (the menu) call clearAllItemCache() separately.
    function dropAllInMemory() {
        pageCache.clear();
        pageItems.clear();
        _idsListCache.clear();
        _phase1AvsCache.clear();
        _missingBannerShown.clear();
        _missingInFlight.clear();
        // Flap loop's give-up set is folder-scoped (08-resolver.js); drop it so
        // the new folder's "立即重试" can't re-arm the loop with the old folder's
        // avs. The loop itself bails on detectMediaId() mismatch, but clearing
        // here keeps kickManualRetry's leftover lookup honest.
        _flapLeftover.clear();
        _flapLeftoverCover.clear();
        _flapLeftoverMid = null;
        // Same reasoning for the credential-less restore path's negative memo
        // (14-orchestrate.js): it records "no local data for this av", which is
        // only meaningful for the folder currently on screen.
        _localOnlyMiss.clear();
    }

    async function fetchAllAvList(mediaId) {
        if (_idsListCache.has(mediaId)) return _idsListCache.get(mediaId);
        var url = 'https://api.bilibili.com/x/v3/fav/resource/ids?media_id='
                + mediaId + '&platform=web';
        var d = await gmGet(url);
        if (d.code !== 0) throw new Error('ids endpoint code=' + d.code + ' ' + (d.message || ''));
        var list = d.data || [];
        _idsListCache.set(mediaId, list);
        return list;
    }

    // Walk EVERY phase-1 page of the first enabled paginated source until
    // has_more=false — and for android, UNION independent walks until the
    // union stops growing, so the baseline isn't distorted by android's
    // large/variable per-walk flap. This is the "what did bilibili actually
    // return for the whole collection" set. CANNOT use pageItems for this —
    // patchOnce stops phase 1 the moment all current-page invalid hits are
    // covered, so pageItems is a partial subset biased toward invalid items.
    // Using it would massively over-count "missing" on collections where the
    // current DOM page has few or no invalid cards. (Was the 0.8.0 bug:
    // a 99-item clean collection reported "static 99 项" because pageItems
    // was empty.)
    //
    // Why union-to-convergence: a SINGLE android walk drops a large, variable
    // fraction of invalid items (observed 42/89 = 47% on one walk), so each
    // falsely lands in the diff as "silently dropped" and inflates the banner.
    // Unioning walks until MISSING_DRY_ROUNDS in a row add nothing new means an
    // item only counts dropped if EVERY walk missed it — the same multi-sample
    // convergence runFlapRecovery (08-resolver.js) uses to recover flappers. A
    // fixed walk count can't work: the flap rate varies, so it would under- or
    // over-walk.
    //
    // Cached per mediaId so a tab that lingers doesn't re-walk on every
    // observer tick. ensurePage adds its own request-level dedup.
    // Returns { avs:Set<avStr>, complete:bool }. `complete` is true ONLY when
    // walk 1 reached a natural has_more=false end (i.e. it saw the whole
    // collection). It is false when walk 1 stopped early — a page error or
    // the MAX_PAGE_WALK cap. Callers MUST NOT compute a "missing" diff against
    // an incomplete walk: the unwalked tail would be falsely flagged as
    // silently-dropped (the >600-item false-positive this `complete` flag
    // exists to prevent). The extra union walks never lower `complete`; they
    // only add flap-recovered avs to the set.
    async function fetchFullPhase1Avs(mediaId) {
        if (_phase1AvsCache.has(mediaId)) return _phase1AvsCache.get(mediaId);
        var collected = new Set();
        var srcOrder = Object.keys(SOURCES);
        var srcName = null;
        for (var s = 0; s < srcOrder.length; s++) {
            var def = SOURCES[srcOrder[s]];
            if (def.paginated && def.enabled()) { srcName = srcOrder[s]; break; }
        }
        if (!srcName) {
            log('fetchFullPhase1Avs: no enabled paginated source — abort');
            return { avs: collected, complete: false };
        }

        // android (eventually-consistent) → union INDEPENDENT walks until the
        // union STOPS GROWING; public (stable) → one walk. The `dry` counter is
        // the convergence signal: a walk that adds a new av resets it, a walk
        // that adds nothing bumps it, and MISSING_DRY_ROUNDS consecutive 0-new
        // walks means the union has saturated (we've seen everything android
        // will return for this folder). Capped at MISSING_MAX_WALKS.
        var isFlappy = (srcName === 'android');
        var complete = false;
        var walk = 0, dry = 0;
        while (walk < (isFlappy ? MISSING_MAX_WALKS : 1) && dry < MISSING_DRY_ROUNDS) {
            walk++;
            if (walk > 1) {
                // Gap so each walk is an INDEPENDENT server sample — back-to-back
                // requests can replay the same eventually-consistent snapshot;
                // the flap is observable on a ~seconds cadence. Reuse one short
                // FLAP_BACKOFF_MS step (NOT the indexed widening one — this is a
                // one-shot baseline, not the live retry's load-shaping).
                await new Promise(function (r) { setTimeout(r, FLAP_BACKOFF_MS[1]); });
                if (detectMediaId() !== mediaId) break;   // folder switched mid-union
            }
            var before = collected.size;
            var walkComplete = false;
            for (var pn = 1; pn <= MAX_PAGE_WALK; pn++) {
                if (detectMediaId() !== mediaId) break;
                var page;
                try {
                    // Walk 1 via ensurePage (reuses pages the live resolve
                    // already cached + its pageItems writes). Extra walks call
                    // fetchPage DIRECTLY so they bypass pageCache for a genuinely
                    // fresh android sample (ensurePage would just replay walk 1's
                    // cached pages — same reason runFlapRecovery bypasses it).
                    page = (walk === 1) ? await ensurePage(srcName, mediaId, pn)
                                        : await SOURCES[srcName].fetchPage({ mediaId: mediaId, pn: pn });
                } catch (e) {
                    warn('fetchFullPhase1Avs:', srcName, 'walk', walk, 'page', pn, 'failed:', e.message);
                    break;   // partial walk
                }
                (page.list || []).forEach(function (it) {
                    if (it.oid != null) collected.add(String(it.oid));
                });
                if (!page.has_more) { walkComplete = true; break; }
            }
            if (walk === 1) {
                // `complete` is decided by walk 1 alone — whether we saw the
                // WHOLE collection (reached has_more=false). If walk 1 was cut
                // short (cap / page error), we can't diff, so stop (no union).
                complete = walkComplete;
                if (!complete) break;
            } else {
                // Walk 1 always adds (from empty) so it never trips dry; only
                // count convergence from walk 2 on.
                if (collected.size === before) dry++; else dry = 0;
            }
        }
        var result = { avs: collected, complete: complete };
        _phase1AvsCache.set(mediaId, result);
        log('fetchFullPhase1Avs: ' + srcName + ' converged in ' + walk + ' walk(s) → '
            + collected.size + ' avs unioned (complete=' + complete + ', dry=' + dry + ')');
        return result;
    }

    function renderMissingBanner(mediaId, totalDeclared, missing) {
        var BANNER_ID = '__fav_fix_missing_banner';
        var existing = document.getElementById(BANNER_ID);
        if (existing) existing.remove();
        if (!missing.length) return;

        var banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.style.cssText = [
            'position:fixed', 'top:80px', 'right:16px', 'z-index:99998',
            'width:340px', 'max-height:70vh',
            'background:#fff', 'color:#222',
            'border:1px solid rgba(192,57,43,.5)',
            'border-radius:10px',
            'box-shadow:0 4px 18px rgba(0,0,0,.18)',
            'font:13px/1.4 -apple-system,Segoe UI,sans-serif',
            'display:flex', 'flex-direction:column',
            'overflow:hidden'
        ].join(';');

        // Header — clickable to collapse/expand. Three flex children laid
        // out left-to-right: title text (grows), toggle hint, close × .
        // Previously close was position:absolute overlaying header, which
        // ran over "点击展开" once the header text wrapped (340px banner
        // can't fit "本收藏夹声明 N 项，bilibili 静默丢弃 M 项" + toggle
        // text on one line). Inline layout means each child reserves its
        // own width — no overlap regardless of wrap.
        var header = document.createElement('div');
        header.style.cssText = [
            'padding:10px 12px', 'cursor:pointer',
            'background:rgba(192,57,43,.08)',
            'border-bottom:1px solid rgba(192,57,43,.18)',
            // align-items:center — when the title wraps to 2 lines (e.g.
            // narrow viewport), toggle "点击展开" and × stay vertically
            // centered against the wrapped title block. flex-start would
            // pin them to the first line of the title.
            'display:flex', 'align-items:center',
            'gap:8px', 'user-select:none'
        ].join(';');

        var titleSpan = document.createElement('span');
        titleSpan.style.cssText = 'flex:1 1 auto; min-width:0';
        titleSpan.innerHTML =
              '<strong style="color:#c0392b">fav-fix</strong> · '
            + '本收藏夹声明 <strong>' + totalDeclared + '</strong> 项，'
            + 'bilibili 静默丢弃 <strong>' + missing.length + '</strong> 项';

        var toggleSpan = document.createElement('span');
        toggleSpan.className = '__fav_fix_banner_toggle';
        toggleSpan.style.cssText = 'color:#888; font-size:11px; flex:0 0 auto; white-space:nowrap';
        toggleSpan.textContent = '点击展开';

        var closeBtn = document.createElement('span');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = [
            'flex:0 0 auto',
            'cursor:pointer', 'color:#999', 'font-size:18px',
            'line-height:1', 'padding:0 4px', 'margin-left:2px'
        ].join(';');
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            banner.remove();
        });

        header.appendChild(titleSpan);
        header.appendChild(toggleSpan);
        header.appendChild(closeBtn);

        // Body — list of missing items. Default-collapsed per user
        // preference: the count alone in the header is enough at-a-glance
        // info; clicking expands when the user actually wants the list.
        var body = document.createElement('div');
        body.style.cssText = [
            'display:none', 'flex:1 1 auto', 'overflow-y:auto',
            'padding:6px 0'
        ].join(';');
        body.innerHTML = missing.map(function (m) {
            // esc av/bvid before interpolating into HTML text and href. The
            // source is bilibili's ids endpoint (format-constrained), so this
            // is defense in depth rather than a known injection — but every
            // other innerHTML path in this file escapes; keep it uniform.
            var av = esc(String(m.id));
            var bv = esc(m.bvid || '');
            var videoUrl = bv ? 'https://www.bilibili.com/video/' + bv
                              : 'https://www.bilibili.com/video/av' + av;
            return ''
                + '<div style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;line-height:1.5">'
                +   '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between">'
                +     '<code style="font-family:Consolas,monospace;color:#444;font-size:11px">'
                +       'av' + av + (bv ? ' · ' + bv : '')
                +     '</code>'
                +   '</div>'
                +   '<div style="margin-top:4px;display:flex;gap:10px;font-size:11px">'
                +     '<a href="' + videoUrl + '" target="_blank" rel="noopener" style="color:#00aeec">原视频页</a>'
                +     '<a href="https://www.biliplus.com/video/av' + av + '/" target="_blank" rel="noopener" style="color:#00aeec">biliplus 快照</a>'
                +     (bv ? '<a href="https://xbeibeix.com/video/' + bv + '" target="_blank" rel="noopener" style="color:#00aeec">xbeibeix</a>' : '')
                +     '<a href="https://www.jijidown.com/video/av' + av + '" target="_blank" rel="noopener" style="color:#00aeec">jijidown</a>'
                +   '</div>'
                + '</div>';
        }).join('');

        var expanded = false;  // default-collapsed; matches body.display:none above
        header.addEventListener('click', function () {
            expanded = !expanded;
            body.style.display = expanded ? 'block' : 'none';
            var toggle = header.querySelector('.__fav_fix_banner_toggle');
            if (toggle) toggle.textContent = expanded ? '点击收起' : '点击展开';
        });

        banner.appendChild(header);
        banner.appendChild(body);

        // Pin to body so bilibili's SPA re-renders don't blow it away.
        if (document.body) document.body.appendChild(banner);
    }

    function detectMissingAndRender(mediaId) {
        // De-dupe up front. Observer ticks fire patchOnce repeatedly; we
        // only need one render per (mediaId, session). Manual re-scan via
        // menu deletes from this set first.
        if (_missingBannerShown.has(mediaId)) return Promise.resolve();
        // In-flight dedup. The old code set _missingBannerShown only AFTER
        // two awaits, so boot()'s 1500ms trigger and patchOnce's end-of-run
        // trigger routinely raced through the guard and BOTH fetched + both
        // rendered (TOCTOU). Share one Promise per mediaId instead: a second
        // concurrent call returns the same in-flight scan. On failure the
        // entry is dropped (finally) WITHOUT marking shown, so a later tick
        // can retry.
        if (_missingInFlight.has(mediaId)) return _missingInFlight.get(mediaId);
        var p = (async function () {
            try {
                // Parallel: ids endpoint + full phase-1 walk. ids is cheap
                // (single GET, no auth); phase-1 walk is N pages so it
                // dominates the wall time on first scan.
                var all, phase1;
                try {
                    var r = await Promise.all([
                        fetchAllAvList(mediaId),
                        fetchFullPhase1Avs(mediaId)
                    ]);
                    all = r[0];
                    phase1 = r[1];
                } catch (e) {
                    warn('detectMissing: parallel fetch failed:', e.message);
                    return;
                }
                if (!all.length) return;
                var phase1Avs = phase1.avs;
                if (phase1Avs.size === 0) {
                    // Either no enabled paginated source or every page failed.
                    // Without a phase-1 baseline we can't compute a meaningful
                    // gap (subtracting against empty = false-positive 100%
                    // missing, which is exactly the 0.8.0 bug). Skip silently.
                    log('detectMissing: phase-1 set empty, skip');
                    return;
                }
                if (!phase1.complete) {
                    // The walk did NOT reach a natural has_more=false end —
                    // it was cut short by the MAX_PAGE_WALK cap or a page
                    // error. The unwalked tail would be falsely reported as
                    // "silently dropped" (the >600-item false positive). Skip
                    // WITHOUT marking shown: the {avs,complete} result is
                    // cached, so repeat ticks return instantly and re-skip;
                    // a manual rescan (which clears the cache) can retry.
                    log('detectMissing: phase-1 walk incomplete (declared=' + all.length
                        + ' walked=' + phase1Avs.size + ', cap=' + MAX_PAGE_WALK
                        + ' pages) — skipping gap detection to avoid false positives');
                    return;
                }
                var missing = all.filter(function (x) {
                    return !phase1Avs.has(String(x.id));
                });
                log('missing detect: declared=' + all.length
                    + ' phase1=' + phase1Avs.size + ' missing=' + missing.length);
                _missingBannerShown.add(mediaId);
                if (missing.length === 0) return;
                // Guard against a folder switch mid-scan: if the user
                // navigated to a different favlist while we were walking,
                // detectMediaId() no longer matches and the new folder will
                // run its own scan. Rendering here would paint the previous
                // folder's gap over the current page.
                if (detectMediaId() !== mediaId) {
                    log('detectMissing: folder changed mid-scan, skip render for', mediaId);
                    return;
                }
                renderMissingBanner(mediaId, all.length, missing);
            } catch (e) {
                warn('detectMissing failed:', e.message);
            } finally {
                _missingInFlight.delete(mediaId);
            }
        })();
        _missingInFlight.set(mediaId, p);
        return p;
    }

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

    // ─── Toast ──────────────────────────────────────────────────────────

    function toast(msg, kind) {
        var color = kind === 'err' ? '#c0392b' : kind === 'warn' ? '#e67e22' : kind === 'ok' ? '#27ae60' : '#34495e';
        var el = document.createElement('div');
        el.textContent = 'fav-fix: ' + msg;
        el.style.cssText = [
            // Bottom-center: anchor at left:50% and use translateX(-50%)
            // for self-centering regardless of width. bottom:32px keeps
            // it above bilibili's own footer / floating buttons but still
            // visually clearly "in the bottom band".
            'position:fixed', 'left:50%', 'bottom:32px',
            'transform:translateX(-50%)',
            'z-index:2147483647',
            'padding:8px 14px', 'border-radius:8px',
            'font:600 13px/1.3 -apple-system,Segoe UI,sans-serif',
            'color:#fff', 'background:' + color,
            'box-shadow:0 4px 12px rgba(0,0,0,.25)', 'pointer-events:none',
            // max-width + word-wrap: caps the toast width at 360px so a
            // long error string ("授权响应异常：错误码 -3, bilibili 长描述…")
            // doesn't stretch the box past the viewport edge. Wraps onto
            // multiple lines instead. break-word handles long unspaced
            // CJK / URLs. text-align:center reads better for centered toast.
            'max-width:360px', 'white-space:normal', 'text-align:center',
            'overflow-wrap:break-word', 'word-break:break-word'
        ].join(';');
        if (document.body) document.body.appendChild(el);
        else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(el); }, { once: true });
        setTimeout(function () { try { el.remove(); } catch (e) {} }, 4500);
    }

    // ─── Manual backup to IndexedDB (pre-emptive snapshot) ──────────────
    //
    // Everything else in this script is AFTER-THE-FACT rescue: an item is
    // already invalid and we go begging android / public / biliplus /
    // jijidown for whatever snapshot they kept. This module is the opposite —
    // the user triggers it while the videos are still ALIVE and we copy the
    // whole folder (metadata AND the cover image BYTES) into IndexedDB. When
    // an item later dies, SOURCES.backup answers from local disk: no network,
    // no third party, no flap.
    //
    // Why IndexedDB and not GM storage: GM_setValue serializes to JSON, which
    // cannot hold a Blob. Cover bytes are the whole point (a metadata-only
    // backup still dies when bilibili's CDN purges the image), so the store
    // has to be one that persists structured-cloneable values.
    //
    // Cross-file invariants (see AGENTS.md):
    //   - The backup DB is NEVER touched by any cache-clearing path
    //     (clearAllItemCache / dropItemCaches / the "清除所有缓存" menu). Those
    //     clear DERIVED data that can be re-fetched; a backup cannot.
    //   - IndexedDB is origin-scoped. space.bilibili.com and www.bilibili.com
    //     therefore keep SEPARATE backup databases; a folder backed up on one
    //     origin does not restore on the other. Documented, not worked around.
    //   - Adding SOURCES.backup changes merge semantics, so CACHE_VERSION was
    //     bumped (07-cache.js) — otherwise entries cached before this feature
    //     would never consult the backup.
    //   - Writing an item is an UPSERT WITH CARRY-FORWARD, never a blind
    //     full-record replace. idbPut() replaces the whole record, so every
    //     field a re-run cannot re-derive (above all the cover Blob) must be
    //     read from the stored record and copied into the new one first. A
    //     backup is the user's only copy; a re-run that finds less than the
    //     last one must degrade to "kept what we had", never to data loss.

    var BACKUP_DB_NAME     = 'bili-fav-fix-backup';
    var BACKUP_DB_VERSION  = 1;
    var BACKUP_STORE_ITEMS = 'items';
    var BACKUP_STORE_META  = 'meta';

    // Walk limits. 500 pages x ps=20 = 10000 items: far above MAX_PAGE_WALK
    // (which bounds the *rescue* walks, where a long walk delays a DOM patch)
    // because a backup is an explicit, user-initiated, one-off operation and
    // truncating it silently loses data the user asked us to keep.
    var BACKUP_MAX_PAGES        = 500;
    var BACKUP_PAGE_DELAY_MS    = 300;   // politeness gap between folder pages
    var BACKUP_BLOB_CONCURRENCY = 3;     // parallel cover downloads
    var BACKUP_PROGRESS_EVERY   = 3;     // toast every N pages (page 1 always)

    // ─── IndexedDB plumbing ─────────────────────────────────────────────
    // Lazy single open, promise-wrapped. No third-party wrapper library: the
    // four operations below are all this feature needs, and the core ships as
    // one inlined IIFE where every extra KB is downloaded on each page load.

    var _backupDbPromise = null;

    function backupDb() {
        if (_backupDbPromise) return _backupDbPromise;
        _backupDbPromise = new Promise(function (resolve, reject) {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB unavailable in this context'));
                return;
            }
            var req = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(BACKUP_STORE_ITEMS)) {
                    // keyPath 'av' is a STRING everywhere (String(oid)), matching
                    // the GM cache key type so the two layers can be compared
                    // without coercion surprises.
                    var items = db.createObjectStore(BACKUP_STORE_ITEMS, { keyPath: 'av' });
                    items.createIndex('bvid', 'bvid', { unique: false });
                }
                if (!db.objectStoreNames.contains(BACKUP_STORE_META)) {
                    db.createObjectStore(BACKUP_STORE_META, { keyPath: 'media_id' });
                }
            };
            req.onsuccess  = function () { resolve(req.result); };
            req.onerror    = function () { reject(req.error || new Error('indexedDB.open failed')); };
            req.onblocked  = function () { reject(new Error('indexedDB.open blocked by another tab')); };
        });
        // Never cache a REJECTED open: a transient failure (private-mode quota,
        // a blocked upgrade from another tab) would otherwise disable the
        // backup for the rest of the page's life.
        _backupDbPromise.catch(function () { _backupDbPromise = null; });
        return _backupDbPromise;
    }

    function idbReq(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error || new Error('IndexedDB request failed')); };
        });
    }

    function idbGet(store, key) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key));
        });
    }

    function idbPut(store, value) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readwrite').objectStore(store).put(value));
        });
    }

    // Deletion lives in the storage layer next to get/put, but it is NEVER
    // called by any cache-clearing path (see the invariants at the top of this
    // file). Its only caller is the backup manager panel (15b), where the user
    // explicitly asks for a record to go away — and that caller must also drop
    // the two derived layers keyed off the same av, or the deleted snapshot
    // keeps restoring cards. See AGENTS.md gotcha 20.
    function idbDelete(store, key) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
        });
    }

    function idbCount(store) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readonly').objectStore(store).count());
        });
    }

    // Cursor walk — the only way to aggregate over the store without loading
    // every Blob-bearing record into memory at once.
    function idbCursorEach(store, fn) {
        return backupDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var req = db.transaction(store, 'readonly').objectStore(store).openCursor();
                req.onsuccess = function () {
                    var cur = req.result;
                    if (!cur) { resolve(); return; }
                    try { fn(cur.value); } catch (e) { reject(e); return; }
                    cur.continue();
                };
                req.onerror = function () { reject(req.error || new Error('cursor failed')); };
            });
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function backupSleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    // bilibili cover URLs carry an "@<w>w_<h>h.webp"-style transform suffix.
    // Strip it so the stored bytes are the ORIGINAL image (and so the
    // cover_url equality check that skips a re-download is stable across
    // layouts that request different thumbnail sizes).
    function stripCoverSuffix(url) {
        if (!url) return '';
        var m = String(url).match(/^([^@]*)@/);
        return (m ? m[1] : String(url)).replace(/^http:\/\//, 'https://');
    }

    function fmtBytes(n) {
        if (!n) return '0 B';
        var u = ['B', 'KB', 'MB', 'GB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }

    // First candidate whose value passes the SAME QUALITY predicate the merge
    // layer uses — so a placeholder cover or an "已失效视频" title never wins
    // just because its source came first. Candidates may be null (skipped).
    function backupPick(candidates, key) {
        var q = QUALITY[key] || QUALITY['default'];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (!c) continue;
            var v = c[key];
            if (q(v) > 0) return v;
        }
        return undefined;
    }

    var _persistAsked = false;
    function requestPersistentStorageOnce() {
        if (_persistAsked) return;
        _persistAsked = true;
        try {
            if (!navigator.storage || !navigator.storage.persist) return;
            // Fire-and-forget: without a persistence grant the browser may evict
            // the DB under storage pressure. Nothing to do if it is denied —
            // an evicted backup degrades to "no backup", not to a broken script.
            navigator.storage.persist().then(function (granted) {
                console.info('[fav-fix/backup] navigator.storage.persist() →', granted);
            }).catch(function (e) { warn('backup persist() rejected:', e && e.message); });
        } catch (e) { warn('backup persist() threw:', e && e.message); }
    }

    // ─── Backup walker ──────────────────────────────────────────────────

    var _backupRunning = false;

    // Build the record we would store for one live list item, or null if the
    // item must be skipped. Reads the existing record so an unchanged cover is
    // NOT re-downloaded (a re-run over a large folder is then metadata-only).
    async function buildBackupRecord(item, mediaId, stats) {
        var av = String(item.oid);
        var liveOk = QUALITY.title(item.title) > 0 && QUALITY.cover(item.cover) > 0;
        var primary = item, fallback = null, dataSource = 'live';
        if (!liveOk) {
            // Already invalid at backup time. Not necessarily a loss: if the
            // rescue path previously recovered this av, the merged snapshot in
            // GM storage is real data worth persisting (GM entries expire;
            // the backup does not). Anything else is a genuine blank.
            var cached = loadCache(av);
            if (!cached || !(cached._src_cover || cached._src_title)) {
                stats.skipped_invalid++;
                return null;
            }
            primary = cached; fallback = item; dataSource = 'merged';
        }

        // Title / cover URLs come from THIS run only. The stored record is
        // deliberately NOT a candidate here: re-picking the archived URL as if
        // it were fresh evidence would defeat the "has the cover changed?"
        // check below. It is still never DISCARDED — the bytes it already
        // holds are carried forward a few lines down.
        var title = backupPick([primary, fallback], 'title');
        var coverUrl = stripCoverSuffix(backupPick([primary, fallback], 'cover'));
        // Final placeholder gate. Everything above already applies QUALITY, but
        // this store is meant to be trustworthy FOREVER — one placeholder cover
        // or "已失效视频" title written here would be served back as gospel by
        // SOURCES.backup at the top of FIELD_PRIORITY, permanently outranking
        // the live sources. Cheap belt-and-braces.
        if (coverUrl && COVER_PLACEHOLDER_RE.test(coverUrl)) coverUrl = '';
        if (!title || String(title).trim() === INVALID_TITLE) {
            stats.skipped_invalid++;
            return null;
        }

        // The stored record has to be READ before it can be safely rewritten:
        // idbPut replaces the record wholesale, and the cover bytes in it have
        // no upstream to re-fetch from. If the read fails we do not know what
        // is already archived, so any write would be a blind overwrite — skip
        // the av entirely and let the next run try again (this also stops
        // media_ids from being truncated to the current folder).
        var existing = null;
        try { existing = await idbGet(BACKUP_STORE_ITEMS, av); }
        catch (e) {
            warn('backup: idbGet failed for av', av, e && e.message);
            stats.read_failed++;
            return null;
        }

        // Secondary fields fall back to the STORED record last: re-running a
        // backup after an item went invalid must never downgrade a field we
        // already captured while it was alive (the merged rescue snapshot
        // carries fewer fields than the live listing).
        var chain = [primary, fallback, existing];
        var upper = backupPick(chain, 'upper');
        var mediaIds = (existing && Array.isArray(existing.media_ids)) ? existing.media_ids.slice() : [];
        if (mediaIds.indexOf(Number(mediaId)) < 0) mediaIds.push(Number(mediaId));

        // Cover bytes are the one thing in this store with NO upstream to
        // re-fetch from, and idbPut replaces the whole record — so the new
        // record STARTS from whatever is already archived and is overwritten
        // only when this run actually holds replacement bytes (see
        // commitBackupRecord). Seeding these four fields with nulls instead
        // would delete a good image every time the item has since died (no
        // cover left to re-derive) or the CDN refuses today's download.
        // cover_url always travels WITH the bytes it describes: while an old
        // blob is being kept the stored URL stays the old one, so the next run
        // still sees url != coverUrl and re-queues the new image — the
        // self-healing retry survives.
        var keptBlob  = (existing && existing.cover_blob) || null;
        var storedUrl = keptBlob ? existing.cover_url
                                 : (coverUrl || (existing && existing.cover_url) || null);

        var rec = {
            av:        av,
            bvid:      backupPick(chain, 'bvid') || null,
            title:     title,
            intro:     backupPick(chain, 'intro') || '',
            upper:     upper ? { mid: upper.mid, name: upper.name, face: upper.face } : null,
            cnt_info:  backupPick(chain, 'cnt_info') || null,
            tid:       backupPick(chain, 'tid'),
            duration:  backupPick(chain, 'duration'),
            pubtime:   backupPick(chain, 'pubtime'),
            ctime:     backupPick(chain, 'ctime'),
            fav_time:  backupPick(chain, 'fav_time'),
            pages:     backupPick(chain, 'pages'),
            page:      backupPick(chain, 'page'),
            link:      backupPick(chain, 'link') || '',
            cover_url:  storedUrl,
            cover_blob: keptBlob,
            cover_type: keptBlob ? (existing.cover_type || null) : null,
            cover_size: keptBlob ? (existing.cover_size || 0) : 0,
            media_ids:  mediaIds,
            backed_at:  Date.now(),
            data_source: dataSource
        };

        // Re-download only when the bytes we hold no longer match the URL we
        // just saw (or we never got them). A missing blob is retried on every
        // subsequent run for free — that is the intended self-healing path for
        // a cover the CDN refused today.
        var reuse = !!(keptBlob && existing.cover_url === coverUrl);
        var fetchUrl = (!reuse && coverUrl) ? coverUrl : null;
        // Archived image kept without even attempting a replacement, i.e. this
        // run produced no usable cover URL at all (the item died since the last
        // backup). Counted separately so a run that quietly stopped refreshing
        // covers is not reported as a plain 更新.
        if (keptBlob && !reuse && !fetchUrl) stats.cover_kept++;
        // metaOnly = an entry that already existed and needs no download, i.e.
        // the "更新" bucket. A brand-new entry counts as "新增" even when it
        // carries no cover at all (title-only merged records).
        return { rec: rec, fetchUrl: fetchUrl, keptBlob: !!keptBlob,
                 metaOnly: !fetchUrl && !!existing };
    }

    async function commitBackupRecord(task, stats) {
        if (task.fetchUrl) {
            try {
                var blob = await gmGetBlob(task.fetchUrl);
                // URL and bytes are replaced as ONE unit — cover_url must always
                // describe the image actually stored, otherwise the reuse check
                // in buildBackupRecord would skip re-downloading a cover we
                // never obtained.
                task.rec.cover_url  = task.fetchUrl;
                task.rec.cover_blob = blob;
                task.rec.cover_type = blob.type || null;
                task.rec.cover_size = blob.size || 0;
            } catch (e) {
                // Leave the carried-forward fields alone. Deleting the only
                // copy of an already-archived cover because today's download
                // failed is unrecoverable; the record keeps the OLD url+bytes,
                // so the next run again sees url != coverUrl and re-queues the
                // new image. When nothing was archived yet, cover_blob simply
                // stays null and the URL is retried on the next run.
                stats.blob_failed++;
                if (task.keptBlob) stats.cover_kept++;
                warn('backup: cover fetch failed for av', task.rec.av, e && e.message);
            }
        }
        if (task.metaOnly) stats.updated++;
        else stats.backed++;
        try { await idbPut(BACKUP_STORE_ITEMS, task.rec); }
        catch (e) { warn('backup: idbPut failed for av', task.rec.av, e && e.message); }
    }

    async function backupPageItems(list, mediaId, stats) {
        var tasks = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item || item.oid == null) continue;
            stats.total_seen++;
            var t = await buildBackupRecord(item, mediaId, stats);
            if (t) tasks.push(t);
        }
        // Bounded parallelism for the cover downloads: serial is needlessly
        // slow on a 200-item folder, unbounded hammers the CDN.
        for (var j = 0; j < tasks.length; j += BACKUP_BLOB_CONCURRENCY) {
            var chunk = tasks.slice(j, j + BACKUP_BLOB_CONCURRENCY);
            await Promise.all(chunk.map(function (t) { return commitBackupRecord(t, stats); }));
        }
    }

    // Entry point for both the Tampermonkey menu command and
    // __biliFavFix.backup.run().
    async function backupCurrentFolder() {
        if (_backupRunning) { toast('备份正在进行中', 'warn'); return null; }
        if (typeof indexedDB === 'undefined') {
            toast('当前环境不支持 IndexedDB，无法备份', 'err');
            return null;
        }
        var mediaId = detectMediaId();
        if (!mediaId) { toast('无法识别当前收藏夹 ID', 'err'); return null; }

        _backupRunning = true;
        requestPersistentStorageOnce();
        var stats = {
            total_seen: 0, backed: 0, updated: 0, skipped_invalid: 0,
            blob_failed: 0, cover_kept: 0, read_failed: 0
        };
        var aborted = false;
        var folderTitle = null;
        try {
            toast('开始备份当前收藏夹');
            var pn = 1;
            while (pn <= BACKUP_MAX_PAGES) {
                // Walk `public` DIRECTLY, bypassing ensurePage/pageCache. Same
                // reasoning as the flap loop (AGENTS.md gotcha 16b): we want a
                // fresh server sample, and a long backup walk must not poison
                // the foreground resolver's page cache. `public` (not android)
                // because a backup runs while the items are still valid, and
                // public carries the fuller field set (pubtime / fav_time /
                // tid / pages) that the android endpoint omits.
                var page = null;
                for (var attempt = 0; attempt < 2 && !page; attempt++) {
                    try { page = await SOURCES['public'].fetchPage({ mediaId: mediaId, pn: pn }); }
                    catch (e) {
                        warn('backup: page ' + pn + ' attempt ' + (attempt + 1) + ' failed:', e.message);
                        if (attempt === 0) await backupSleep(1000);
                    }
                }
                if (!page) {
                    aborted = true;
                    toast('备份中止：第 ' + pn + ' 页抓取失败，已写入的数据保留', 'err');
                    break;
                }
                if (!folderTitle && page.folderTitle) folderTitle = page.folderTitle;
                await backupPageItems(page.list || [], mediaId, stats);
                // Every page would out-run the toast's own 4.5s lifetime and
                // stack overlapping banners; every 3rd page keeps the feedback
                // continuous without piling up.
                if (pn % BACKUP_PROGRESS_EVERY === 0) {
                    toast('备份中：第 ' + pn + ' 页，已处理 ' + stats.total_seen + ' 项');
                }
                if (!page.has_more) break;
                pn++;
                await backupSleep(BACKUP_PAGE_DELAY_MS);
            }
            if (!aborted) {
                var summary = '备份完成：新增 ' + stats.backed + ' · 更新 ' + stats.updated
                            + ' · 跳过失效 ' + stats.skipped_invalid
                            + ' · 封面失败 ' + stats.blob_failed;
                // Appended only when non-zero: both mean "this run did not
                // refresh everything it looked at", which the plain 更新 count
                // would otherwise hide.
                if (stats.cover_kept)  summary += ' · 沿用旧封面 ' + stats.cover_kept;
                if (stats.read_failed) summary += ' · 读取失败 ' + stats.read_failed;
                toast(summary, 'ok');
            }
            return stats;
        } finally {
            _backupRunning = false;
            // A run just turned "no local data for this av" into "there is
            // now", so the credential-less restore path must re-check
            // (14-orchestrate.js); nothing else invalidates that memo without
            // a page load.
            _localOnlyMiss.clear();
            await writeBackupMeta(mediaId, stats, aborted, pn, folderTitle);
        }
    }

    // The meta record is the ONLY per-folder answer to "when was this folder
    // last backed up in full"; the manager panel's footer reads it. An aborted walk must
    // therefore not overwrite a previous COMPLETE run's figures with its own
    // truncated ones — that would report a 40-of-300 failure as a fresh 40-item
    // backup and hide the fact that the folder still needs a full pass. Keep
    // the last complete run intact and record the failed attempt beside it.
    async function writeBackupMeta(mediaId, stats, aborted, lastPage, folderTitle) {
        var key = String(mediaId);
        var prev = null;
        try { prev = await idbGet(BACKUP_STORE_META, key); }
        catch (e) { warn('backup: meta read failed', e && e.message); }
        var rec;
        if (aborted && prev) {
            rec = {};
            for (var k in prev) rec[k] = prev[k];
        } else {
            // A completed walk, or an abort with no earlier run to preserve
            // (recording the partial figures beats recording nothing — the
            // partial flag below keeps the readout honest either way).
            rec = {
                media_id:        key,
                last_run:        Date.now(),
                total_seen:      stats.total_seen,
                backed:          stats.backed,
                updated:         stats.updated,
                skipped_invalid: stats.skipped_invalid,
                blob_failed:     stats.blob_failed,
                cover_kept:      stats.cover_kept,
                read_failed:     stats.read_failed
            };
        }
        rec.media_id             = key;
        // Folder display name for the manager panel's dropdown. Any run that
        // learned it (even an aborted one — page 1 usually succeeded) records
        // it; otherwise whatever a previous run stored is kept via the prev
        // copy above.
        rec.title                = folderTitle || rec.title || null;
        rec.last_attempt         = Date.now();
        rec.last_attempt_partial = !!aborted;
        rec.last_attempt_page    = aborted ? (lastPage || 0) : 0;
        try { await idbPut(BACKUP_STORE_META, rec); }
        catch (e) { warn('backup: meta write failed', e && e.message); }
    }

    // ─── Status ─────────────────────────────────────────────────────────

    async function backupStatus() {
        var out = {
            items: 0, coverBytes: 0, withCover: 0,
            quotaUsed: null, quota: null, folder: null
        };
        out.items = await idbCount(BACKUP_STORE_ITEMS);
        await idbCursorEach(BACKUP_STORE_ITEMS, function (rec) {
            if (rec && rec.cover_size) { out.coverBytes += rec.cover_size; out.withCover++; }
        });
        try {
            if (navigator.storage && navigator.storage.estimate) {
                var est = await navigator.storage.estimate();
                out.quotaUsed = est.usage;
                out.quota = est.quota;
            }
        } catch (e) { warn('backup: storage.estimate failed', e && e.message); }
        var mid = detectMediaId();
        if (mid) {
            try { out.folder = (await idbGet(BACKUP_STORE_META, String(mid))) || null; }
            catch (e) { warn('backup: meta read failed', e && e.message); }
        }
        return out;
    }

    // (The old 查看备份状态 menu toast was folded into the manager panel:
    // global totals + browser quota live in the panel header, per-folder
    // last-run info in its footer. backupStatus() stays for the debug
    // surface — __biliFavFix.backup.status().)

    // ─── Cover fallback for the DOM layer ───────────────────────────────
    // Used by patchCover (09-dom.js) when the recovered cover URL 404s: the
    // metadata outlived the image on bilibili's CDN, but our own copy of the
    // bytes did not. Resolves to null when we have nothing.
    function backupCoverObjectUrl(av) {
        if (typeof indexedDB === 'undefined') return Promise.resolve(null);
        return idbGet(BACKUP_STORE_ITEMS, String(av)).then(function (rec) {
            if (!rec || !rec.cover_blob) return null;
            // Not revoked: the number of live objectURLs is bounded by the
            // number of dead-cover cards on one page, and revoking early would
            // blank the <img> the moment bilibili's virtual scroller re-renders.
            return URL.createObjectURL(rec.cover_blob);
        });
    }

    // ─── Source registration ────────────────────────────────────────────
    // Registered at load time (this module runs after 05-sources.js, so
    // `SOURCES` is already initialized — see AGENTS.md on MANIFEST ordering).
    // Queried by the resolver in PHASE 0, before any network source, and
    // ranked first in FIELD_PRIORITY for every field it supplies: a backup was
    // captured while the video was alive, so it is strictly better evidence
    // than any post-mortem snapshot.
    SOURCES.backup = {
        name: 'backup',
        paginated: false,
        enabled: function () { return typeof indexedDB !== 'undefined'; },
        fetchAvs: async function (avs) {
            var out = new Map();
            if (!avs || !avs.length) return out;
            for (var i = 0; i < avs.length; i++) {
                var av = String(avs[i]);
                var rec;
                try { rec = await idbGet(BACKUP_STORE_ITEMS, av); }
                catch (e) {
                    // A dead DB fails identically for every remaining av —
                    // stop rather than repeat the same error N times.
                    warn('backup: lookup aborted at av', av, e && e.message);
                    break;
                }
                if (!rec) continue;
                // Deliberately NOT returned: `attr` and `link`. Those describe
                // the item's CURRENT state / navigation target, which the live
                // sources own; a stale backed-up `attr` would tell the UI a
                // dead video is still valid.
                out.set(av, {
                    oid:      Number(av),
                    bvid:     rec.bvid || undefined,
                    title:    rec.title,
                    cover:    rec.cover_url || undefined,
                    intro:    rec.intro || undefined,
                    duration: rec.duration,
                    upper:    rec.upper || undefined,
                    cnt_info: rec.cnt_info || undefined,
                    tid:      rec.tid,
                    pubtime:  rec.pubtime,
                    ctime:    rec.ctime,
                    fav_time: rec.fav_time,
                    pages:    rec.pages,
                    page:     rec.page
                });
            }
            if (out.size) console.info('[fav-fix/backup] restored', out.size, 'of', avs.length, 'av(s) from local backup');
            return out;
        }
    };
    // ─── Backup manager panel ───────────────────────────────────────────
    //
    // The IndexedDB backup (15a-backup.js) is the only USER-AUTHORED data this
    // script keeps, and until this panel existed the only way to inspect or
    // prune it was DevTools. This module is that missing surface: a single
    // in-page overlay that lists every archived item with its cover thumbnail,
    // provides the delete paths (one item, or the whole current filter) and
    // hands the current filter to the ZIP export (15c-backup-export.js).
    //
    // Cross-file invariants (see AGENTS.md gotcha 20):
    //   - Deleting one av is a THREE-LAYER operation, not just an IDB delete.
    //     The GM merge cache (07-cache.js) may hold a merge whose fields came
    //     FROM the backup and would keep restoring that card for up to 30
    //     days, and the in-memory row `backup|<av>` (pageItems, 08-resolver.js)
    //     would do the same for the rest of this page's life. deleteBackupAv()
    //     drops all three; the caller drops pageCache once per batch.
    //   - The `meta` store is deliberately left alone. It records "when was
    //     this folder last walked in full", which stays true after individual
    //     items are pruned — and the panel header / backupStatus() read live
    //     counts from the items store anyway, so nothing here is a stale counter.
    //   - Cover Blobs in Chromium are file-backed lazy handles: a cursor walk
    //     does NOT pull the bytes into memory, but a reference held in a JS
    //     index would pin them. The in-memory index below therefore copies
    //     PRIMITIVES ONLY. Thumbnails are read per visible page and their
    //     objectURLs revoked on every re-render and on close.
    //   - Panel nodes are prefixed `fav-fix-mgr-` and match none of
    //     CARD_SELECTOR, so the MutationObserver's card scan (14-orchestrate.js)
    //     never mistakes a row for a bilibili video card.

    var MGR_PAGE_SIZE          = 20;
    var MGR_SEARCH_DEBOUNCE_MS = 300;

    var _mgrHost    = null;   // overlay root; non-null means the panel is open
    var _mgrState   = null;   // see openBackupManager() for the shape
    var _mgrOpening = false;  // guards the await between click and first paint
    var _mgrStylesInjected = false;

    function ensureBackupManagerStyles() {
        if (_mgrStylesInjected) return;
        _mgrStylesInjected = true;
        // Design language mirrors the host page (bilibili web): white panel,
        // #fb7299 as THE accent for the single primary action, neutral grays
        // for everything else, 6px control radii. Hierarchy over decoration:
        //   header  = identity + global stats + primary action (备份) + close
        //   toolbar = filters only (search, labeled 收藏夹/排序 selects)
        //   footer  = bulk actions bottom-left (neutral export first, then the
        //             destructive bulk delete quarantined beside it),
        //             page info center, pager bottom-right
        var st = document.createElement('style');
        st.id = '__fav_fix_mgr_styles';
        st.textContent = [
            // Font stack deliberately matches bilibili's own so the panel
            // reads as part of the host page, not an extension bolt-on.
            '.fav-fix-mgr-overlay {',
            '  position: fixed; inset: 0; z-index: 2147483646;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: rgba(24,25,28,.5);',
            '  font: 13px/1.5 -apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;',
            '  color: #18191c;',
            '}',
            '.fav-fix-mgr-panel {',
            '  width: 720px; max-width: 92vw; max-height: 80vh;',
            '  display: flex; flex-direction: column;',
            '  background: #fff; border-radius: 12px; overflow: hidden;',
            '  box-shadow: 0 12px 40px rgba(0,0,0,.28);',
            '}',
            '.fav-fix-mgr-head {',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 14px 18px 12px; border-bottom: 1px solid #e3e5e7;',
            '}',
            '.fav-fix-mgr-headmain { flex: 1; min-width: 0; }',
            '.fav-fix-mgr-title { font-size: 15px; font-weight: 600; line-height: 20px; }',
            '.fav-fix-mgr-stat {',
            '  margin-top: 2px; font-size: 12px; color: #9499a0;',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}',
            '.fav-fix-mgr-tools {',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 10px 18px; border-bottom: 1px solid #f1f2f3;',
            '}',
            '.fav-fix-mgr-input {',
            '  flex: 1; min-width: 140px; height: 32px; padding: 0 10px;',
            '  border: 1px solid #e3e5e7; border-radius: 6px;',
            '  font-size: 12px; outline: none; background: #fff;',
            '  transition: border-color .15s;',
            '}',
            '.fav-fix-mgr-input:focus { border-color: #fb7299; }',
            // Labeled select = prefix chip + borderless native select in one
            // bordered capsule, so 收藏夹/排序 read as named controls instead
            // of two anonymous button-looking boxes. Caret is drawn by the
            // wrapper (::after) since appearance:none strips the native one.
            '.fav-fix-mgr-field {',
            '  position: relative; display: inline-flex; align-items: stretch;',
            '  height: 32px; border: 1px solid #e3e5e7; border-radius: 6px;',
            '  background: #fff; overflow: hidden; transition: border-color .15s;',
            '}',
            '.fav-fix-mgr-field:focus-within { border-color: #fb7299; }',
            '.fav-fix-mgr-field > span {',
            '  display: flex; align-items: center; padding: 0 8px;',
            '  background: #f6f7f8; border-right: 1px solid #e3e5e7;',
            '  font-size: 12px; color: #61666d; white-space: nowrap;',
            '}',
            '.fav-fix-mgr-field > select {',
            '  appearance: none; -webkit-appearance: none;',
            '  border: 0; outline: none; background: transparent;',
            '  max-width: 190px; padding: 0 24px 0 8px;',
            '  font-size: 12px; color: #18191c; cursor: pointer;',
            '}',
            '.fav-fix-mgr-field::after {',
            '  content: ""; position: absolute; right: 9px; top: 50%;',
            '  transform: translateY(-50%); pointer-events: none;',
            '  border-left: 4px solid transparent; border-right: 4px solid transparent;',
            '  border-top: 5px solid #9499a0;',
            '}',
            '.fav-fix-mgr-btn {',
            '  height: 32px; border: 1px solid #e3e5e7; background: #fff;',
            '  color: #18191c; padding: 0 14px; border-radius: 6px;',
            '  cursor: pointer; font-size: 12px; white-space: nowrap;',
            '  transition: background .15s, border-color .15s, color .15s;',
            '}',
            '.fav-fix-mgr-btn:hover { background: #f6f7f8; }',
            '.fav-fix-mgr-btn[disabled] { opacity: .45; cursor: default; }',
            // THE primary action — the only filled-pink element in the panel.
            '.fav-fix-mgr-btn-primary {',
            '  border-color: #fb7299; background: #fb7299; color: #fff; font-weight: 500;',
            '}',
            '.fav-fix-mgr-btn-primary:hover { background: #e8618a; border-color: #e8618a; }',
            '.fav-fix-mgr-btn-primary[disabled] { opacity: .55; }',
            // Destructive: quiet outline until hovered — never louder than
            // the primary action.
            '.fav-fix-mgr-btn-danger {',
            '  border-color: rgba(225,60,83,.4); background: #fff; color: #e13c53;',
            '}',
            '.fav-fix-mgr-btn-danger:hover { background: rgba(225,60,83,.06); border-color: #e13c53; }',
            '.fav-fix-mgr-body { flex: 1; min-height: 120px; overflow-y: auto; }',
            '.fav-fix-mgr-note {',
            '  padding: 48px 20px; text-align: center; color: #9499a0;',
            '}',
            '.fav-fix-mgr-row {',
            '  display: flex; align-items: center; gap: 12px;',
            '  padding: 8px 18px; border-bottom: 1px solid #f4f5f6;',
            '  transition: background .1s;',
            '}',
            '.fav-fix-mgr-row:hover { background: #f8f9fb; }',
            // Fixed 96x60 box for both the real thumbnail and the placeholder,
            // so rows keep the same height whether or not a cover was archived.
            '.fav-fix-mgr-thumb, .fav-fix-mgr-noimg {',
            '  width: 96px; height: 60px; flex: 0 0 96px;',
            '  border-radius: 4px; background: #f1f2f3;',
            '}',
            '.fav-fix-mgr-thumb { object-fit: cover; }',
            '.fav-fix-mgr-noimg {',
            '  display: flex; align-items: center; justify-content: center;',
            '  color: #c9ccd0; font-size: 11px;',
            '}',
            '.fav-fix-mgr-info { flex: 1; min-width: 0; }',
            '.fav-fix-mgr-name, .fav-fix-mgr-sub {',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}',
            '.fav-fix-mgr-name { font-size: 13px; font-weight: 500; }',
            '.fav-fix-mgr-sub { margin-top: 3px; font-size: 11px; color: #9499a0; }',
            '.fav-fix-mgr-tag {',
            '  display: inline-block; margin-left: 6px; padding: 0 5px;',
            '  border-radius: 3px; background: #8e44ad; color: #fff;',
            '  font-size: 10px; line-height: 15px; vertical-align: 1px;',
            '}',
            '.fav-fix-mgr-tag-merged { background: #909399; }',
            '.fav-fix-mgr-foot {',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 10px 18px; border-top: 1px solid #e3e5e7;',
            '}',
            '.fav-fix-mgr-pageinfo {',
            '  flex: 1; text-align: right; font-size: 12px; color: #9499a0;',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // backed_at is a millisecond timestamp, unlike fmtTime (10-tooltip.js)
    // which takes unix SECONDS — hence a separate formatter rather than a
    // conversion at every call site.
    function mgrDate(ms) {
        if (!ms) return '未知';
        var d = new Date(Number(ms));
        if (isNaN(d.getTime())) return '未知';
        var pad = function (x) { return x < 10 ? '0' + x : String(x); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    // Light index of the whole items store. PRIMITIVES ONLY — see the header
    // note on Blob handles. One cursor walk over ~1000 records is well under a
    // second, and it is what every count, filter and page slice reads from
    // afterwards, so nothing below re-opens a transaction just to count.
    function buildBackupIndex() {
        var out = [];
        return idbCursorEach(BACKUP_STORE_ITEMS, function (rec) {
            if (!rec || rec.av == null) return;
            out.push({
                av:          String(rec.av),
                bvid:        rec.bvid || '',
                title:       rec.title || '',
                upperName:   (rec.upper && rec.upper.name) || '',
                media_ids:   Array.isArray(rec.media_ids) ? rec.media_ids.slice() : [],
                backed_at:   rec.backed_at || 0,
                fav_time:    rec.fav_time || 0,   // unix SECONDS (backed_at is ms)
                cover_size:  rec.cover_size || 0,
                data_source: rec.data_source || '',
                hasCover:    !!rec.cover_blob
            });
        }).then(function () {
            // No sort here: ordering is a VIEW concern (mgrApplyFilter), driven
            // by the sort dropdown. Note backed_at is NOT the folder's natural
            // order — a first full walk writes page 1 (newest favorites) first,
            // so "newest backed_at" lists the OLDEST favorites on top.
            return out;
        });
    }

    // Folder display names for the dropdown, merged from two layers: the meta
    // store (persisted by the backup walker via normalizePublicResp's
    // folderTitle since 0.11.1) wins; the sidebar DOM fills in folders backed
    // up before names were stored (its items carry the fid as the element id
    // and "<name> <count>" as text — the default folder's item has NO id, so
    // it stays covered only by the meta layer). Anything in neither layer
    // falls back to '收藏夹 <id>' at render time.
    function mgrBuildFolderNames() {
        var names = new Map();
        var metas = new Map();   // media_id → full meta record, for the footer's last-run readout
        try {
            var items = document.querySelectorAll('div.fav-sidebar-item[id]');
            for (var i = 0; i < items.length; i++) {
                var id = items[i].getAttribute('id');
                if (!/^\d+$/.test(id)) continue;
                var t = items[i].textContent.replace(/\s+/g, ' ').trim().replace(/\s*\d+$/, '');
                if (t) names.set(id, t);
            }
        } catch (e) { /* sidebar layout changed — raw ids still render */ }
        return idbCursorEach(BACKUP_STORE_META, function (rec) {
            if (!rec || !rec.media_id) return;
            metas.set(String(rec.media_id), rec);
            if (rec.title) names.set(String(rec.media_id), rec.title);
        }).then(function () { return { names: names, metas: metas }; },
                function () { return { names: names, metas: metas }; });
    }

    // Per-folder last-run readout, shown in the footer while that folder is
    // selected (absorbed from the old 查看备份状态 menu toast). last_run is the
    // last COMPLETE pass; an aborted attempt is flagged beside it so a
    // 40-of-300 failure never reads as an up-to-date folder.
    function mgrFolderMetaText() {
        var s = _mgrState;
        if (s.folder === '*') return '';
        var m = s.metas.get(String(s.folder));
        if (!m || !m.last_run) return ' · 未完整备份过';
        var days = Math.floor((Date.now() - m.last_run) / 86400000);
        var txt = ' · 上次备份：' + (days <= 0 ? '今天' : days + ' 天前')
                + '（' + (m.total_seen || 0) + ' 项）';
        if (m.last_attempt_partial) txt += ' · 上次尝试中止于第 ' + (m.last_attempt_page || 0) + ' 页';
        return txt;
    }

    // Three-layer delete (see the header invariants). pageCache is NOT cleared
    // here: it is keyed by page, not by av, so the caller drops it once after a
    // whole batch instead of once per item.
    function deleteBackupAv(av) {
        av = String(av);
        return idbDelete(BACKUP_STORE_ITEMS, av).then(function () {
            try { clearItemCache(av); }
            catch (e) { warn('mgr: clearItemCache failed for av', av, e && e.message); }
            pageItems.delete('backup|' + av);
        });
    }

    // ─── Panel internals ────────────────────────────────────────────────

    function mgrRevokeThumbs() {
        if (!_mgrState) return;
        for (var i = 0; i < _mgrState.urls.length; i++) {
            try { URL.revokeObjectURL(_mgrState.urls[i]); } catch (e) {}
        }
        _mgrState.urls = [];
    }

    function mgrTotals(rows) {
        var t = { items: rows.length, covers: 0, bytes: 0 };
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].cover_size) { t.covers++; t.bytes += rows[i].cover_size; }
        }
        return t;
    }

    function mgrApplyFilter() {
        var s = _mgrState;
        var q = s.query.trim().toLowerCase();
        var fid = s.folder;
        s.filtered = s.index.filter(function (r) {
            if (fid !== '*' && r.media_ids.indexOf(Number(fid)) < 0) return false;
            if (!q) return true;
            return r.title.toLowerCase().indexOf(q) >= 0
                || r.bvid.toLowerCase().indexOf(q) >= 0
                || r.upperName.toLowerCase().indexOf(q) >= 0;
        });
        // Sort the view. Default fav_desc mirrors the favlist page's own
        // 最近收藏 order; records missing the key (0) sink to the end in desc.
        var byBacked = s.sort.indexOf('backed') === 0;
        var asc = s.sort.slice(-3) === 'asc';
        s.filtered.sort(function (a, b) {
            var av2 = byBacked ? a.backed_at : a.fav_time;
            var bv2 = byBacked ? b.backed_at : b.fav_time;
            return asc ? av2 - bv2 : bv2 - av2;
        });
        s.page = 1;
    }

    function mgrRenderHead() {
        var s = _mgrState;
        var t = mgrTotals(s.index);
        s.els.stat.textContent = '共 ' + t.items + ' 项 · 封面 ' + t.covers
                               + ' 张 / ' + fmtBytes(t.bytes)
                               + (s.quotaText ? ' · 浏览器存储 ' + s.quotaText : '');
    }

    // Browser-quota readout for the header (absorbed from the old status
    // toast). Refreshed on open and after an in-panel backup; a delete's
    // effect on usage is small and picked up on the next open.
    function mgrLoadQuota() {
        var s = _mgrState;
        if (!s || !navigator.storage || !navigator.storage.estimate) return Promise.resolve();
        return navigator.storage.estimate().then(function (est) {
            if (_mgrState !== s || !est) return;
            s.quotaText = fmtBytes(est.usage || 0) + ' / ' + fmtBytes(est.quota || 0);
            mgrRenderHead();
        }).catch(function () { /* header simply omits the quota */ });
    }

    // Options are the UNION of media_ids across the index, each with its own
    // count. Rebuilt on open and after any delete, because both the labels and
    // the per-folder counts are derived from the index. It still does NOT
    // follow SPA folder switches: that snapshot keeps the filter stable while
    // the user works through the list.
    function mgrRenderFolders() {
        var s = _mgrState;
        var counts = new Map();
        for (var i = 0; i < s.index.length; i++) {
            var ids = s.index[i].media_ids;
            for (var j = 0; j < ids.length; j++) {
                var k = String(ids[j]);
                counts.set(k, (counts.get(k) || 0) + 1);
            }
        }
        var keys = Array.from(counts.keys());
        keys.sort(function (a, b) { return counts.get(b) - counts.get(a) || Number(a) - Number(b); });
        // A folder whose last item was just deleted has no option left, so the
        // assignment at the end of this function would silently leave the
        // select blank while s.folder kept filtering on the vanished id. Fall
        // back to 全部收藏夹 so the control and the filter still agree.
        if (s.folder !== '*' && !counts.has(s.folder)) s.folder = '*';
        // The field's own prefix chip already says 收藏夹 — option labels
        // carry just the name and count.
        var html = '<option value="*">全部（' + s.index.length + '）</option>';
        for (var m = 0; m < keys.length; m++) {
            var label = (s.names.get(keys[m]) || ('收藏夹 ' + keys[m]))
                      + (s.currentMid && keys[m] === String(s.currentMid) ? ' · 当前收藏夹' : '')
                      + '（' + counts.get(keys[m]) + '）';
            html += '<option value="' + esc(keys[m]) + '">' + esc(label) + '</option>';
        }
        s.els.folder.innerHTML = html;
        s.els.folder.value = s.folder;
    }

    // Thumbnails for the CURRENT page only. Each read is guarded by the render
    // token so a slow idbGet from a page the user already left neither paints
    // into a recycled row nor leaks an objectURL past the revoke.
    function mgrLoadThumbs(entries) {
        var s = _mgrState;
        var token = s.renderToken;
        entries.forEach(function (entry) {
            idbGet(BACKUP_STORE_ITEMS, entry.av).then(function (rec) {
                if (_mgrState !== s || s.renderToken !== token) return;
                if (!rec || !rec.cover_blob) return;
                var url = URL.createObjectURL(rec.cover_blob);
                s.urls.push(url);
                entry.img.src = url;
            }).catch(function (e) {
                warn('mgr: thumbnail read failed for av', entry.av, e && e.message);
            });
        });
    }

    function mgrRenderList() {
        var s = _mgrState;
        // Every re-render invalidates the previous page's thumbnails: bump the
        // token BEFORE revoking so in-flight reads bail out instead of pushing
        // a fresh objectURL into the list we just emptied.
        s.renderToken++;
        mgrRevokeThumbs();
        var body = s.els.body;
        body.innerHTML = '';

        var total = s.filtered.length;
        var pages = Math.max(1, Math.ceil(total / MGR_PAGE_SIZE));
        if (s.page > pages) s.page = pages;
        var start = (s.page - 1) * MGR_PAGE_SIZE;
        var slice = s.filtered.slice(start, start + MGR_PAGE_SIZE);

        if (!s.index.length) {
            body.innerHTML = '<div class="fav-fix-mgr-note">暂无备份数据<br>'
                           + '可在 Tampermonkey 菜单中选择「fav-fix：备份当前收藏夹」开始备份</div>';
        } else if (!total) {
            body.innerHTML = '<div class="fav-fix-mgr-note">没有符合条件的备份条目</div>';
        }

        var pending = [];
        for (var i = 0; i < slice.length; i++) {
            var r = slice[i];
            var row = document.createElement('div');
            row.className = 'fav-fix-mgr-row';
            var tagCls = r.data_source === 'merged' ? ' fav-fix-mgr-tag-merged' : '';
            var tagTxt = r.data_source === 'merged' ? '取自还原缓存' : '备份时有效';
            // The visible date follows the active sort key, labeled so a list
            // sorted by 收藏时间 does not show seemingly shuffled backup dates.
            var dateStr = s.sort.indexOf('backed') === 0
                ? '备份于 ' + mgrDate(r.backed_at)
                : '收藏于 ' + (r.fav_time ? mgrDate(r.fav_time * 1000) : '未知');
            var sub = [
                r.upperName || '未知 UP 主',
                dateStr,
                r.cover_size ? fmtBytes(r.cover_size) : '无封面',
                r.bvid || ('av' + r.av)
            ].join(' · ');
            row.innerHTML =
                (r.hasCover
                    ? '<img class="fav-fix-mgr-thumb" alt="">'
                    : '<div class="fav-fix-mgr-noimg">无封面</div>')
                + '<div class="fav-fix-mgr-info">'
                +   '<div class="fav-fix-mgr-name" title="' + esc(r.title) + '">' + esc(r.title) + '</div>'
                +   '<div class="fav-fix-mgr-sub">' + esc(sub)
                +     '<span class="fav-fix-mgr-tag' + tagCls + '">' + esc(tagTxt) + '</span>'
                +   '</div>'
                + '</div>'
                + '<button class="fav-fix-mgr-btn fav-fix-mgr-del">删除</button>';
            body.appendChild(row);

            var img = row.querySelector('.fav-fix-mgr-thumb');
            if (img) pending.push({ av: r.av, img: img });
            /* jshint loopfunc:true */
            (function (rec) {
                row.querySelector('.fav-fix-mgr-del')
                   .addEventListener('click', function () { mgrDeleteOne(rec); });
            })(r);
        }
        if (pending.length) mgrLoadThumbs(pending);

        s.els.pageInfo.textContent = '第 ' + (total ? s.page : 0) + ' / ' + (total ? pages : 0)
                                   + ' 页 · 共 ' + total + ' 项' + mgrFolderMetaText();
        s.els.prev.disabled = s.busy || s.page <= 1;
        s.els.next.disabled = s.busy || s.page >= pages;
        // The three long operations (delete, in-panel backup, export) mutually
        // exclude each other; browsing stays free during all of them. The
        // export term is `s.exportBusy || _exportRunning`, not s.exportBusy
        // alone: an export survives the panel it was started from, so a panel
        // opened while one is still walking has exportBusy false and must
        // nonetheless present the matrix as locked (15c-backup-export.js).
        s.els.bulk.disabled = s.busy || s.backupBusy || s.exportBusy || _exportRunning || !total;
        s.els.bulk.textContent = '删除当前筛选结果（' + total + ' 项）';
        // The export button lives in the footer, so a re-render never rebuilds
        // it — but its disabled state is derived from the same counters as the
        // rows and has to be recomputed here all the same. Its LABEL is left
        // alone: it carries no count (unlike the bulk delete), and during a run
        // it holds the progress text that mgrExportFiltered owns.
        s.els.exportBtn.disabled = s.busy || s.backupBusy || s.exportBusy || _exportRunning || !total;
        if (s.backupBusy || s.exportBusy || _exportRunning) {
            var dels = s.els.body.querySelectorAll('.fav-fix-mgr-del');
            for (var d = 0; d < dels.length; d++) dels[d].disabled = true;
        }
    }

    // Re-entrancy guard for both delete paths: an in-flight delete must not be
    // raced by a second click, a page flip or a filter change mid-batch.
    function mgrSetBusy(on) {
        var s = _mgrState;
        // Defence in depth: every caller already checks the panel is still the
        // one it started with, but a release arriving after close must never
        // throw out of a promise callback.
        if (!s) return;
        s.busy = on;
        // Recompute rather than blanket-enable on release: a delete that ends
        // without a re-render (the failure path) must not leave 下一页 clickable
        // on the last page.
        var pages = Math.max(1, Math.ceil(s.filtered.length / MGR_PAGE_SIZE));
        s.els.prev.disabled = on || s.page <= 1;
        s.els.next.disabled = on || s.page >= pages;
        s.els.bulk.disabled = on || s.backupBusy || s.exportBusy || _exportRunning || !s.filtered.length;
        // Same computation as in mgrRenderList: a delete that ends without a
        // re-render must not hand the export button back while another long
        // operation still owns the panel.
        s.els.exportBtn.disabled = on || s.backupBusy || s.exportBusy || _exportRunning || !s.filtered.length;
        var dels = s.els.body.querySelectorAll('.fav-fix-mgr-del');
        for (var i = 0; i < dels.length; i++) {
            dels[i].disabled = on || s.backupBusy || s.exportBusy || _exportRunning;
        }
    }

    // Called by exportBackupRows (15c-backup-export.js) once a run releases
    // _exportRunning. Only the panel that STARTED an export repaints itself
    // when it ends; a panel opened after that one was closed mid-run derives
    // its locked controls from the module flag and would otherwise stay locked
    // until some unrelated interaction happened to re-render it.
    function mgrExportReleased() {
        var s = _mgrState;
        if (!s || s.exportBusy) return;   // no panel, or the owner repaints itself
        mgrRenderList();
    }

    // The search box stays editable during a delete on purpose: disabling an
    // input mid IME composition (Chinese input is the expected case) drops the
    // composition and steals focus. The debounced handler therefore discards
    // whatever was typed while busy, and no further input event is guaranteed
    // to arrive — so the box is re-read once the batch releases, otherwise the
    // panel keeps showing typed text over a list filtered by the old query.
    // Returns true when the query moved, so callers can restart at page 1.
    function mgrResyncSearch() {
        var s = _mgrState;
        if (!s || s.els.search.value === s.query) return false;
        s.query = s.els.search.value;
        return true;
    }

    // Settles the panel after a delete attempt. Also runs on the failure path,
    // where `removed` is empty but the search box may still have moved.
    function mgrAfterDelete(removed) {
        var s = _mgrState;
        if (!s) return;
        var requery = mgrResyncSearch();
        if (!removed.size && !requery) return;
        s.index = s.index.filter(function (r) { return !removed.has(r.av); });
        var page = s.page;
        var folder = s.folder;
        // Every surface derived from the index goes stale on a delete, the
        // folder dropdown included: its option labels carry per-folder counts,
        // and the rebuild is also what drops a folder that just lost its last
        // item (resetting s.folder to '*' when that folder was selected).
        mgrRenderFolders();
        mgrApplyFilter();
        // Keep the reader where they were — unless the filter itself changed,
        // in which case the old page number means nothing and page 1 (set by
        // mgrApplyFilter) is the honest landing spot.
        if (!requery && s.folder === folder) s.page = page;
        mgrRenderHead();
        mgrRenderList();
    }

    // Full refresh after an in-panel backup: the index, the folder-name map
    // and every surface derived from them are stale. Search text typed during
    // the run is honoured (mgrResyncSearch), the folder selection survives
    // unless its folder vanished (mgrRenderFolders resets it), and deletes are
    // blocked for the whole backup, so this can never repaint rows out from
    // under an in-flight delete batch.
    function mgrRefreshIndex() {
        var s = _mgrState;
        if (!s) return Promise.resolve();
        return Promise.all([buildBackupIndex(), mgrBuildFolderNames()]).then(function (res) {
            if (_mgrState !== s) return;
            s.index = res[0];
            s.names = res[1].names;
            s.metas = res[1].metas;
            mgrLoadQuota();
            mgrResyncSearch();
            mgrRenderHead();
            mgrRenderFolders();
            mgrApplyFilter();
            mgrRenderList();
        }).catch(function (e) {
            warn('mgr: refresh failed', e && e.message);
        });
    }

    function mgrDeleteOne(rec) {
        var s = _mgrState;
        if (s.busy || s.backupBusy || s.exportBusy || _exportRunning) return;
        if (!confirm('确定删除该条目的备份？\n\n' + rec.title + '\n\n删除后无法恢复。')) return;
        mgrSetBusy(true);
        deleteBackupAv(rec.av).then(function () {
            // The record left IDB whether or not the panel survived the await,
            // so the page-keyed promise cache — which would otherwise replay
            // pre-delete rows for the rest of this page's life — is dropped
            // unconditionally; only the UI work below belongs to a live panel.
            pageCache.clear();
            if (_mgrState !== s) return;   // panel closed mid-delete
            mgrSetBusy(false);
            mgrAfterDelete(new Set([rec.av]));
            toast('已删除 1 项备份', 'ok');
        }).catch(function (e) {
            if (_mgrState !== s) {         // panel closed mid-delete
                warn('mgr: delete failed after close', e && e.message);
                return;
            }
            mgrSetBusy(false);
            mgrAfterDelete(new Set());
            toast('删除失败：' + (e && e.message), 'err');
        });
    }

    async function mgrDeleteFiltered() {
        var s = _mgrState;
        if (s.busy || s.backupBusy || s.exportBusy || _exportRunning) return;
        var targets = s.filtered.slice();
        if (!targets.length) return;
        var whole = (s.folder === '*' && !s.query.trim());
        var msg = whole
            ? '将清空全部备份，共 ' + targets.length + ' 项。\n\n删除后无法恢复，确定继续？'
            : '将删除当前筛选结果，共 ' + targets.length + ' 项。\n\n删除后无法恢复，确定继续？';
        if (!confirm(msg)) return;

        mgrSetBusy(true);
        var removed = new Set();
        var failed = 0;
        // Serial, not Promise.all: each delete is its own transaction and the
        // whole set is a few hundred records at worst (measured in seconds),
        // while a few hundred parallel transactions is how the connection gets
        // starved. A mid-way failure keeps everything already removed.
        for (var i = 0; i < targets.length; i++) {
            try {
                await deleteBackupAv(targets[i].av);
                removed.add(targets[i].av);
            } catch (e) {
                failed++;
                warn('mgr: delete failed for av', targets[i].av, e && e.message);
            }
        }
        // Dropped once per batch, and before the state guard: the records left
        // IDB regardless of whether the panel is still open.
        if (removed.size) pageCache.clear();
        if (_mgrState !== s) return;   // panel closed mid-batch
        mgrSetBusy(false);
        mgrAfterDelete(removed);
        toast('已删除 ' + removed.size + ' 项备份'
              + (failed ? ' · 失败 ' + failed + ' 项' : ''), failed ? 'warn' : 'ok');
    }

    // Packs the current filter into a ZIP (15c-backup-export.js). Read-only,
    // so unlike the delete paths it asks for no confirmation.
    //
    // The row list is SNAPSHOT at click time: the export then owns its own
    // copy and the user may keep searching, paging and switching folders while
    // it runs. Closing the panel mid-run does not cancel it either — the file
    // was asked for and a read-only job has nothing to roll back — so every UI
    // touch below is gated on the panel still being the one this run started
    // with, while the completion toast (which does not belong to the panel)
    // fires from exportBackupRows regardless.
    //
    // renderToken is deliberately NOT involved: that mechanism exists for
    // thumbnail objectURL lifetime and means nothing here.
    function mgrExportFiltered() {
        var s = _mgrState;
        if (s.busy || s.backupBusy || s.exportBusy) return;
        var rows = s.filtered.slice();
        if (!rows.length) return;

        s.exportBusy = true;
        s.els.exportBtn.disabled = true;
        s.els.exportBtn.textContent = '导出中 0%';
        mgrRenderList();

        // Percent, not "N / M": the row count is already in the page info line,
        // and repainting the label on every one of several hundred rows is
        // wasted layout work — only a whole-number change is written back.
        var lastPct = -1;
        exportBackupRows(rows, {
            scope: {
                folder:      s.folder,
                folderTitle: s.folder === '*' ? null : (s.names.get(String(s.folder)) || null),
                query:       s.query,
                sort:        s.sort
            },
            metas: s.metas,
            onProgress: function (done, total) {
                if (_mgrState !== s) return;
                var pct = total ? Math.floor(done * 100 / total) : 100;
                if (pct === lastPct) return;
                lastPct = pct;
                s.els.exportBtn.textContent = '导出中 ' + pct + '%';
            }
        }).catch(function (e) {
            warn('mgr: export threw', e);
            toast('导出失败：' + (e && e.message), 'err');
        }).then(function () {
            if (_mgrState !== s) return;   // panel closed mid-export
            s.exportBusy = false;
            s.els.exportBtn.disabled = false;
            s.els.exportBtn.textContent = '导出筛选结果';
            // Nothing in the store changed, so the index stands; the re-render
            // is purely to hand the rows and the bulk button back.
            mgrRenderList();
        });
    }

    function closeBackupManager() {
        if (!_mgrHost) return;
        if (_mgrState) {
            // Invalidate before revoking so a thumbnail read still in flight
            // cannot resurrect an objectURL after the panel is gone.
            _mgrState.renderToken++;
            mgrRevokeThumbs();
        }
        if (_mgrState && _mgrState.onKeydown) {
            document.removeEventListener('keydown', _mgrState.onKeydown, true);
        }
        try { _mgrHost.remove(); } catch (e) {}
        _mgrHost = null;
        _mgrState = null;
    }

    // ─── Entry point ────────────────────────────────────────────────────
    // Driven by the Tampermonkey menu command and __biliFavFix.backup.manage().
    async function openBackupManager() {
        if (_mgrHost) {
            // Single instance: a second invocation focuses the open panel
            // rather than stacking a second overlay on top of it.
            var open = _mgrHost.querySelector('.fav-fix-mgr-input');
            if (open) open.focus();
            return;
        }
        if (_mgrOpening) return;
        if (typeof indexedDB === 'undefined') {
            toast('当前环境不支持 IndexedDB，无法管理备份', 'err');
            return;
        }
        _mgrOpening = true;
        try {
            // Probe the DB BEFORE painting anything: a panel that renders and
            // then has to apologise is worse than never opening. idbCount also
            // performs the lazy open, so a failure here is the open failing.
            try { await idbCount(BACKUP_STORE_ITEMS); }
            catch (e) {
                toast('无法打开备份数据库：' + (e && e.message), 'err');
                return;
            }

            ensureBackupManagerStyles();
            var host = document.createElement('div');
            host.className = 'fav-fix-mgr-overlay';
            host.innerHTML = ''
                + '<div class="fav-fix-mgr-panel">'
                +   '<div class="fav-fix-mgr-head">'
                +     '<div class="fav-fix-mgr-headmain">'
                +       '<div class="fav-fix-mgr-title">备份管理</div>'
                +       '<div class="fav-fix-mgr-stat">正在读取备份…</div>'
                +     '</div>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-btn-primary fav-fix-mgr-backup">备份当前收藏夹</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-close">关闭</button>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-tools">'
                +     '<input class="fav-fix-mgr-input" type="text" placeholder="搜索标题 / BV 号 / UP 主">'
                +     '<label class="fav-fix-mgr-field"><span>收藏夹</span>'
                +       '<select class="fav-fix-mgr-select"><option value="*">全部</option></select>'
                +     '</label>'
                +     '<label class="fav-fix-mgr-field"><span>排序</span>'
                +       '<select class="fav-fix-mgr-select fav-fix-mgr-sort">'
                +         '<option value="fav_desc">最新收藏在前</option>'
                +         '<option value="fav_asc">最早收藏在前</option>'
                +         '<option value="backed_desc">最新备份在前</option>'
                +         '<option value="backed_asc">最早备份在前</option>'
                +       '</select>'
                +     '</label>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-body">'
                +     '<div class="fav-fix-mgr-note">正在读取备份…</div>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-foot">'
                // Neutral outline, no count: the red framing and the item
                // count on the bulk delete are a confirmation affordance for a
                // destructive act, and an export needs neither.
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-export" disabled>导出筛选结果</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-btn-danger fav-fix-mgr-bulk" disabled>删除当前筛选结果</button>'
                +     '<div class="fav-fix-mgr-pageinfo"></div>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-prev" disabled>上一页</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-next" disabled>下一页</button>'
                +   '</div>'
                + '</div>';
            document.body.appendChild(host);
            _mgrHost = host;

            _mgrState = {
                index: [], filtered: [], page: 1, query: '', folder: '*',
                sort: 'fav_desc',
                names: new Map(), metas: new Map(), quotaText: null,
                currentMid: detectMediaId(),
                urls: [], renderToken: 0,
                // One flag per long operation rather than a single lock: they
                // exclude each other but disable different controls, and the
                // release paths are independent.
                busy: false, backupBusy: false, exportBusy: false,
                searchTimer: null,
                onKeydown: null,
                els: {
                    stat:     host.querySelector('.fav-fix-mgr-stat'),
                    body:     host.querySelector('.fav-fix-mgr-body'),
                    search:   host.querySelector('.fav-fix-mgr-input'),
                    folder:   host.querySelector('.fav-fix-mgr-select'),
                    sort:     host.querySelector('.fav-fix-mgr-sort'),
                    backup:   host.querySelector('.fav-fix-mgr-backup'),
                    // Not `els.export`: a bare `export` identifier is reserved,
                    // and a property that cannot be destructured or aliased
                    // without care is not worth the two saved characters.
                    exportBtn: host.querySelector('.fav-fix-mgr-export'),
                    bulk:     host.querySelector('.fav-fix-mgr-bulk'),
                    prev:     host.querySelector('.fav-fix-mgr-prev'),
                    next:     host.querySelector('.fav-fix-mgr-next'),
                    pageInfo: host.querySelector('.fav-fix-mgr-pageinfo')
                }
            };
            var s = _mgrState;

            host.querySelector('.fav-fix-mgr-close')
                .addEventListener('click', closeBackupManager);
            // Backdrop click only — a click that started inside the panel and
            // ended on the overlay must not close it.
            host.addEventListener('click', function (e) {
                if (e.target === host) closeBackupManager();
            });
            // Capture phase: bilibili's own key handlers sit on document too,
            // and Esc should reach us regardless of what has focus.
            s.onKeydown = function (e) {
                if (e.key === 'Escape') { e.stopPropagation(); closeBackupManager(); }
            };
            document.addEventListener('keydown', s.onKeydown, true);

            s.els.search.addEventListener('input', function () {
                if (s.searchTimer) clearTimeout(s.searchTimer);
                s.searchTimer = setTimeout(function () {
                    // A re-render mid-batch would repaint the rows with their
                    // delete buttons enabled again, so filtering/paging stays
                    // frozen for the duration of a delete. What was typed is
                    // not lost: mgrResyncSearch re-reads the box on release.
                    if (_mgrState !== s || s.busy) return;
                    s.query = s.els.search.value;
                    mgrApplyFilter();
                    mgrRenderList();
                }, MGR_SEARCH_DEBOUNCE_MS);
            });
            s.els.folder.addEventListener('change', function () {
                if (s.busy) { s.els.folder.value = s.folder; return; }
                s.folder = s.els.folder.value;
                mgrApplyFilter();
                mgrRenderList();
            });
            s.els.sort.addEventListener('change', function () {
                if (s.busy) { s.els.sort.value = s.sort; return; }
                s.sort = s.els.sort.value;
                mgrApplyFilter();
                mgrRenderList();
            });
            s.els.exportBtn.addEventListener('click', mgrExportFiltered);
            s.els.bulk.addEventListener('click', function () {
                mgrDeleteFiltered().catch(function (e) {
                    warn('mgr: bulk delete threw', e);
                    toast('批量删除失败：' + (e && e.message), 'err');
                });
            });
            // In-panel backup: backupCurrentFolder() re-detects the folder at
            // run time, so the flow for a folder the dropdown does not list
            // yet is: switch the page to it, click this, and the refresh below
            // adds it as a filter option. Deletes are blocked for the duration
            // (see mgrRenderList); browsing stays free.
            s.els.backup.addEventListener('click', function () {
                if (s.busy || s.backupBusy || s.exportBusy || _exportRunning) return;
                s.backupBusy = true;
                s.els.backup.disabled = true;
                s.els.backup.textContent = '备份中…';
                mgrRenderList();
                backupCurrentFolder().catch(function (e) {
                    warn('mgr: in-panel backup threw', e);
                    toast('备份失败：' + (e && e.message), 'err');
                    return null;
                }).then(function () {
                    if (_mgrState !== s) return;
                    s.backupBusy = false;
                    s.els.backup.disabled = false;
                    s.els.backup.textContent = '备份当前收藏夹';
                    // The run may have been for a different folder than the
                    // one the panel opened on — re-detect so the 当前收藏夹
                    // marker follows what was actually just backed up.
                    s.currentMid = detectMediaId();
                    return mgrRefreshIndex();
                });
            });
            s.els.prev.addEventListener('click', function () {
                if (s.page > 1) { s.page--; mgrRenderList(); }
            });
            s.els.next.addEventListener('click', function () {
                s.page++; mgrRenderList();
            });

            var index, layers;
            try {
                index = await buildBackupIndex();
                layers = await mgrBuildFolderNames();
            }
            catch (e) {
                warn('mgr: index build failed', e);
                closeBackupManager();
                toast('读取备份列表失败：' + (e && e.message), 'err');
                return;
            }
            if (_mgrState !== s) return;   // closed while the cursor was walking
            s.index = index;
            s.names = layers.names;
            s.metas = layers.metas;
            mgrRenderHead();
            mgrRenderFolders();
            mgrApplyFilter();
            mgrRenderList();
            mgrLoadQuota();
            s.els.search.focus();
        } finally {
            _mgrOpening = false;
        }
    }
    // ─── Backup export (ZIP) ────────────────────────────────────────────
    //
    // The IndexedDB backup is origin-scoped, invisible outside DevTools and
    // evictable under storage pressure (navigator.storage.persist() is a
    // request, not a guarantee). This module is the way out of the browser: it
    // packs a panel selection into ONE .zip the user can keep anywhere —
    // items.json for the metadata, covers/<av>.<ext> for the image bytes,
    // manifest.json so the container describes itself.
    //
    // Constraints that shaped the implementation:
    //   - The core is a self-contained IIFE loaded by eval, so NO third-party
    //     library may be pulled in and the ZIP writer below is hand-written.
    //     STORE (method 0, no compression) is deliberate: covers are already
    //     JPEG/WebP and would not shrink, and a DEFLATE implementation would
    //     cost more core bytes on every page load than it ever saves.
    //   - The bootstrap's @grant list is frozen (adding one re-prompts every
    //     user), so GM_download is unavailable — the file leaves through an
    //     objectURL on a synthetic <a download>.
    //   - MEMORY IS THE HARD PART. Chromium keeps IDB Blobs as file-backed
    //     lazy handles, so a 228 MB backup only stays out of the heap if the
    //     bytes are never materialised. The output Blob is therefore assembled
    //     from PARTS — headers as Uint8Array, cover payloads as the Blob
    //     HANDLES themselves — never by concatenating arrayBuffers. The one
    //     place bytes must be read is the CRC-32, and that reads one cover at
    //     a time and drops the buffer immediately.
    //   - Read-only by definition: this module writes no store and drops no
    //     cache, so none of the three-layer delete / carry-forward invariants
    //     in 15a/15b apply to it.

    // Bumped only when the on-disk layout changes in a way an importer would
    // have to branch on. Written into manifest.json so a future import path
    // can refuse a container it does not understand instead of guessing.
    var EXPORT_FORMAT_VERSION = 1;

    // The writer below emits no ZIP64 records, so the 32-bit header fields cap
    // an archive at 4 GiB and 65535 entries. Refuse well short of both: an
    // over-cap archive is not an error at write time, it is a file that only
    // some extractors can open.
    var EXPORT_MAX_BYTES   = 3.5 * 1024 * 1024 * 1024;
    var EXPORT_MAX_ENTRIES = 65000;
    // Per-item cost of the two JSON members, used ONLY by the pre-flight size
    // check. Their real size is known far too late to refuse politely.
    var EXPORT_JSON_BYTES_PER_ITEM = 800;

    // ─── CRC-32 ─────────────────────────────────────────────────────────
    // Table-driven, polynomial 0xEDB88320 (the reflected form ZIP uses).
    // Streaming (init / update / final) rather than one-shot so a payload can
    // be fed in pieces without ever holding it twice, and so every entry gets
    // its own independent accumulator.
    // Every step ends with `>>> 0`: JS bitwise operators produce SIGNED 32-bit
    // integers, and a negative CRC written into a header is a corrupt archive
    // that only shows up when the user tries to extract it.

    var _crcTable = null;

    function crc32Table() {
        if (_crcTable) return _crcTable;
        var t = new Uint32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c >>> 0;
        }
        _crcTable = t;
        return t;
    }

    function crc32Init() { return 0xFFFFFFFF; }

    function crc32Update(crc, bytes) {
        var t = crc32Table();
        for (var i = 0; i < bytes.length; i++) {
            crc = (t[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
        }
        return crc >>> 0;
    }

    function crc32Final(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

    function crc32Bytes(bytes) { return crc32Final(crc32Update(crc32Init(), bytes)); }

    // ─── ZIP container (STORE) ──────────────────────────────────────────
    // Every multi-byte field is little-endian, hence DataView with the
    // explicit `true`: a hand-rolled byte-assignment loop would have to spell
    // out the order at each of the two dozen fields below.

    var _zipEncoder = null;
    function zipEncoder() {
        if (!_zipEncoder) _zipEncoder = new TextEncoder();
        return _zipEncoder;
    }

    // Bit 11. Entry names are pure ASCII by construction (manifest.json,
    // items.json, covers/<av>.<ext>) — the flag is set anyway because it costs
    // nothing and states outright that the name bytes are UTF-8, which is what
    // every modern extractor wants to be told.
    var ZIP_FLAG_UTF8 = 0x0800;

    // The DOS time field has two-second resolution (seconds >> 1) and the date
    // field counts years from 1980; both are inherited from the original PKZIP
    // format and cannot be widened without a ZIP64/extended-timestamp field.
    function zipDosTime(d) {
        return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    }
    function zipDosDate(d) {
        return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    }

    // `data` is either a Uint8Array (the JSON members) or an IDB Blob handle
    // (a cover). Both are valid Blob parts, which is exactly why the payload
    // never has to be read to be written.
    function zipEntry(name, crc, size, data) {
        return { name: zipEncoder().encode(name), crc: crc, size: size, data: data };
    }

    function zipLocalHeader(entry, dosTime, dosDate) {
        var out = new Uint8Array(30 + entry.name.length);
        var dv = new DataView(out.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);                  // version needed to extract
        dv.setUint16(6, ZIP_FLAG_UTF8, true);
        dv.setUint16(8, 0, true);                   // method 0 = STORE
        dv.setUint16(10, dosTime, true);
        dv.setUint16(12, dosDate, true);
        dv.setUint32(14, entry.crc, true);
        dv.setUint32(18, entry.size, true);         // compressed size ...
        dv.setUint32(22, entry.size, true);         // ... equals uncompressed under STORE
        dv.setUint16(26, entry.name.length, true);
        dv.setUint16(28, 0, true);                  // no extra field
        out.set(entry.name, 30);
        return out;
    }

    function zipCentralEntry(entry, dosTime, dosDate, offset) {
        var out = new Uint8Array(46 + entry.name.length);
        var dv = new DataView(out.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);                  // version made by
        dv.setUint16(6, 20, true);                  // version needed to extract
        dv.setUint16(8, ZIP_FLAG_UTF8, true);
        dv.setUint16(10, 0, true);                  // method 0 = STORE
        dv.setUint16(12, dosTime, true);
        dv.setUint16(14, dosDate, true);
        dv.setUint32(16, entry.crc, true);
        dv.setUint32(20, entry.size, true);
        dv.setUint32(24, entry.size, true);
        dv.setUint16(28, entry.name.length, true);
        dv.setUint16(30, 0, true);                  // extra field length
        dv.setUint16(32, 0, true);                  // file comment length
        dv.setUint16(34, 0, true);                  // disk number start
        dv.setUint16(36, 0, true);                  // internal attributes
        dv.setUint32(38, 0, true);                  // external attributes
        dv.setUint32(42, offset, true);             // offset of the local header
        out.set(entry.name, 46);
        return out;
    }

    function zipEocd(count, cdSize, cdOffset) {
        var out = new Uint8Array(22);
        var dv = new DataView(out.buffer);
        dv.setUint32(0, 0x06054b50, true);
        dv.setUint16(4, 0, true);                   // this disk
        dv.setUint16(6, 0, true);                   // disk holding the central directory
        dv.setUint16(8, count, true);
        dv.setUint16(10, count, true);
        dv.setUint32(12, cdSize, true);
        dv.setUint32(16, cdOffset, true);
        dv.setUint16(20, 0, true);                  // no archive comment
        return out;
    }

    // Offsets are accumulated here rather than tracked during the walk: a
    // central-directory record must point at its local header, and that offset
    // is only knowable once the entry ORDER is final (manifest.json and
    // items.json are prepended after every cover is known).
    function zipAssemble(entries, when) {
        var dosTime = zipDosTime(when);
        var dosDate = zipDosDate(when);
        var parts = [], central = [], offset = 0, cdSize = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var local = zipLocalHeader(e, dosTime, dosDate);
            parts.push(local);
            if (e.size) parts.push(e.data);
            var ce = zipCentralEntry(e, dosTime, dosDate, offset);
            central.push(ce);
            cdSize += ce.length;
            offset += local.length + e.size;
        }
        for (var j = 0; j < central.length; j++) parts.push(central[j]);
        parts.push(zipEocd(entries.length, cdSize, offset));
        // Parts, not a byte concatenation: a cover part is the IDB Blob handle
        // itself, so the whole archive is described without a single cover
        // being pulled into the heap.
        return new Blob(parts, { type: 'application/zip' });
    }

    // ─── Export helpers ─────────────────────────────────────────────────

    var EXPORT_COVER_EXT = {
        'image/jpeg': 'jpg',
        'image/jpg':  'jpg',
        'image/png':  'png',
        'image/webp': 'webp',
        'image/gif':  'gif'
    };

    // An unknown or absent MIME keeps the bytes under `.bin` rather than
    // guessing an extension: the stored cover_type travels in items.json
    // regardless, so nothing is lost and nothing is misrepresented.
    function exportCoverExt(type) {
        var t = String(type || '').toLowerCase().split(';')[0].trim();
        return EXPORT_COVER_EXT[t] || 'bin';
    }

    function exportStamp(d) {
        var p = function (x) { return x < 10 ? '0' + x : String(x); };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
             + '-' + p(d.getHours()) + p(d.getMinutes());
    }

    // Names the archive after what is inside it, so a folder-at-a-time export
    // does not produce a directory of indistinguishable files. Folder titles
    // come from bilibili and are free-form, hence the sanitising pass over the
    // characters Windows and macOS reject in a filename.
    function exportScopeLabel(scope) {
        var label = '全部';
        if (scope.folder && scope.folder !== '*') {
            label = scope.folderTitle || ('收藏夹' + scope.folder);
        }
        label = String(label).replace(/[\\/:*?"<>|]/g, '_');
        if (scope.query && scope.query.trim()) label += '_筛选';
        return label;
    }

    // undefined is not representable in JSON — the key would simply vanish
    // from the output — so every optional field is normalised to null and the
    // record shape in items.json stays fixed across all entries.
    function exportOrNull(v) { return v === undefined ? null : v; }

    // The metadata half of a stored record, i.e. everything EXCEPT cover_blob.
    // Spelled out field by field instead of cloning-and-deleting: the export
    // file is a contract with whatever reads it later, so a future schema
    // change in the store must not silently alter it — and an accidental Blob
    // reference here would be held for the entire run, pinning bytes the whole
    // parts-based design exists to avoid.
    function exportItemMeta(rec) {
        return {
            av:          String(rec.av),
            bvid:        rec.bvid || null,
            title:       rec.title || '',
            intro:       rec.intro || '',
            upper:       rec.upper || null,
            cnt_info:    rec.cnt_info || null,
            tid:         exportOrNull(rec.tid),
            duration:    exportOrNull(rec.duration),
            pubtime:     exportOrNull(rec.pubtime),
            ctime:       exportOrNull(rec.ctime),
            fav_time:    exportOrNull(rec.fav_time),
            pages:       exportOrNull(rec.pages),
            page:        exportOrNull(rec.page),
            link:        rec.link || '',
            media_ids:   Array.isArray(rec.media_ids) ? rec.media_ids.slice() : [],
            backed_at:   rec.backed_at || 0,
            data_source: rec.data_source || '',
            cover_url:   rec.cover_url || null,
            cover_type:  rec.cover_type || null,
            cover_size:  rec.cover_size || 0,
            // Filled in only once the bytes are actually in the archive; an
            // unreadable or absent cover leaves it null so a reader never
            // follows a path that is not there.
            cover_file:  null
        };
    }

    // Summary of every folder the exported items belong to, taken from the
    // meta store. It is what tells a reader when each folder was last walked
    // in full — a detail items.json cannot carry, since it lives per folder
    // rather than per item.
    function exportFolders(ids, metas) {
        var keys = Array.from(ids);
        keys.sort(function (a, b) { return Number(a) - Number(b); });
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var m = metas.get(keys[i]) || null;
            out.push({
                media_id:             keys[i],
                title:                (m && m.title) || null,
                last_run:             (m && m.last_run) || null,
                total_seen:           (m && m.total_seen) || 0,
                last_attempt_partial: !!(m && m.last_attempt_partial)
            });
        }
        return out;
    }

    function exportTriggerDownload(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        // DETACHED on purpose — never append this anchor to the document.
        // bilibili delegates a click handler at the document level that
        // hijacks anchor navigation (rewrites the href, strips the blob:
        // scheme, appends spm tracking and NAVIGATES the tab — observed live:
        // the page left for space.bilibili.comhttps//… instead of
        // downloading). A click dispatched on a detached node has no
        // propagation path into the document tree, so their handler never
        // sees it, while Chromium starts the download regardless of
        // attachment.
        a.click();
        // NEVER revoked. Chromium captures the blob when the download STARTS,
        // not when the click returns — and with Chrome's "ask where to save
        // each file" setting the start is deferred until the user answers the
        // Save As dialog, which can sit open indefinitely. An anchor download
        // gives the page ZERO feedback (no start/complete/cancel event), so
        // there is no safe moment to revoke and any timer is a guess that
        // corrupts the download when it guesses wrong. The URL dies with the
        // document instead; what it pins until then is only the zip's part
        // LIST (IDB blob handles, not bytes) — a few entries per session.
    }

    // ─── Orchestration ──────────────────────────────────────────────────
    //
    // Owns the whole operation: the refusal paths, the walk, the assembly, the
    // download and the closing toast. Callers supply the rows and (optionally)
    // progress feedback, so the panel button and the console entry point
    // (__biliFavFix.backup.exportAll) behave identically.
    //
    // `rows` are index entries (buildBackupIndex shape — primitives only); the
    // caller passes a SNAPSHOT, so whatever the panel filter does afterwards
    // cannot change what this run writes. Resolves to a stats object, or null
    // when the export was refused before touching the store.
    //
    // opts:
    //   scope      { folder, folderTitle, query, sort } — recorded in the
    //              manifest and used to name the file
    //   metas      Map<media_id, meta record>; read from the store when absent
    //   onProgress function (done, total) — called per row, never after the
    //              last one

    // Export-vs-export exclusion, at module scope for the same reason
    // _backupRunning (15a-backup.js) is: the panel's s.exportBusy dies with the
    // panel state, yet closing the panel does NOT cancel a run — a read-only
    // job the user asked for walks to the end and still downloads. A panel
    // reopened during that run would otherwise be built with exportBusy false
    // and hand back an enabled export button, and __biliFavFix.backup.exportAll
    // bypasses the panel entirely. One flag covers all three combinations.
    var _exportRunning = false;

    // Guard wrapper only; everything else is in exportBackupRowsInner. The
    // release lives in a finally because the inner function has several refusal
    // paths and may throw: a flag left set would kill every later export for
    // the lifetime of the page.
    async function exportBackupRows(rows, opts) {
        if (_exportRunning) { toast('导出进行中，请稍后再试', 'warn'); return null; }
        _exportRunning = true;
        try {
            return await exportBackupRowsInner(rows, opts);
        } finally {
            _exportRunning = false;
            // A panel opened mid-run derives its export button from this flag
            // and has nothing else that would repaint it once the run ends.
            mgrExportReleased();
        }
    }

    async function exportBackupRowsInner(rows, opts) {
        opts = opts || {};
        var scope = opts.scope || { folder: '*', folderTitle: null, query: '', sort: 'none' };
        if (!rows || !rows.length) { toast('没有可导出的备份条目', 'warn'); return null; }
        // A backup walk rewrites the very records about to be read, so an
        // export overlapping one would ship a mixed-generation snapshot: some
        // rows from before the walk, some from after. Refuse instead of
        // explaining. The reverse order — a walk started after this export
        // began — is left alone as a known benign race; guarding it would mean
        // a global lock for no practical gain.
        if (_backupRunning) { toast('备份进行中，请稍后导出', 'warn'); return null; }

        // Pre-flight, before a single record is read: with no ZIP64 records an
        // over-cap archive is not a write error but a file that silently fails
        // to open elsewhere. The instruction is actionable — the panel's folder
        // filter is exactly the tool for splitting the job.
        if (rows.length + 2 >= EXPORT_MAX_ENTRIES) {
            toast('条目过多（' + rows.length + ' 项），请按收藏夹分批导出', 'warn');
            return null;
        }
        var estimate = rows.length * EXPORT_JSON_BYTES_PER_ITEM;
        for (var p = 0; p < rows.length; p++) estimate += rows[p].cover_size || 0;
        if (estimate > EXPORT_MAX_BYTES) {
            toast('预计体积约 ' + fmtBytes(estimate) + '，超出单个 ZIP 上限，请按收藏夹分批导出', 'warn');
            return null;
        }

        var metas = opts.metas;
        if (!metas) {
            // No panel to borrow the map from (console entry point). A failure
            // here only costs the folders section its titles, so it degrades
            // rather than aborting the export.
            metas = new Map();
            try {
                await idbCursorEach(BACKUP_STORE_META, function (rec) {
                    if (rec && rec.media_id != null) metas.set(String(rec.media_id), rec);
                });
            } catch (e) { warn('export: meta read failed', e && e.message); }
        }

        var items = [], coverEntries = [], folderIds = new Set();
        var missing = 0, coverFailed = 0, coverBytes = 0;
        var total = rows.length;
        for (var i = 0; i < total; i++) {
            if (opts.onProgress) opts.onProgress(i, total);
            var av = String(rows[i].av);
            var rec = null;
            try { rec = await idbGet(BACKUP_STORE_ITEMS, av); }
            catch (e) { warn('export: record read failed for av', av, e && e.message); }
            // The index was built by an earlier cursor walk, so a record
            // deleted (or unreadable) since then is counted and skipped. A
            // partial archive with an honest count beats no archive at all.
            if (!rec) { missing++; continue; }

            var meta = exportItemMeta(rec);
            for (var m = 0; m < meta.media_ids.length; m++) folderIds.add(String(meta.media_ids[m]));
            if (rec.cover_blob) {
                var name = 'covers/' + av + '.' + exportCoverExt(rec.cover_type);
                try {
                    // The ONE point where cover bytes enter the heap, and only
                    // because CRC-32 cannot be computed without reading them.
                    // One cover at a time (~300 KB), released as soon as the
                    // checksum is in; the entry keeps the Blob HANDLE, which
                    // the assembly step consumes without reading it again.
                    var bytes = new Uint8Array(await rec.cover_blob.arrayBuffer());
                    coverEntries.push(zipEntry(name, crc32Bytes(bytes), bytes.length, rec.cover_blob));
                    coverBytes += bytes.length;
                    meta.cover_file = name;
                } catch (e) {
                    // A file-backed handle whose underlying file the browser
                    // reclaimed. The metadata is still perfectly good, so the
                    // item ships with cover_file null instead of failing the
                    // whole export over one image.
                    coverFailed++;
                    warn('export: cover read failed for av', av, e && e.message);
                }
            }
            items.push(meta);
        }
        if (opts.onProgress) opts.onProgress(total, total);

        var when = new Date();
        var enc = zipEncoder();
        // Indented on purpose: both members are meant to be opened and read by
        // a human, and at 1–3 MB the whole string is cheap to hold once.
        var itemsJson = enc.encode(JSON.stringify(items, null, 2));
        var manifest = {
            format:         'bili-fav-fix-backup',
            format_version: EXPORT_FORMAT_VERSION,
            exported_at:    when.toISOString(),
            // Recorded because the backup DB is origin-scoped: a container
            // exported on space.bilibili.com describes a different database
            // than one exported on www.bilibili.com.
            origin:         location.origin,
            core_version:   CORE_VERSION,
            scope: {
                folder:       scope.folder || '*',
                folder_title: scope.folderTitle || null,
                query:        scope.query || '',
                sort:         scope.sort || 'none'
            },
            counts: {
                items:        items.length,
                covers:       coverEntries.length,
                cover_bytes:  coverBytes,
                missing:      missing,
                cover_failed: coverFailed
            },
            folders: exportFolders(folderIds, metas)
        };
        var manifestJson = enc.encode(JSON.stringify(manifest, null, 2));

        // manifest.json and items.json lead the archive: a reader opening the
        // container streamwise meets the self-description before the payload.
        var entries = [
            zipEntry('manifest.json', crc32Bytes(manifestJson), manifestJson.length, manifestJson),
            zipEntry('items.json', crc32Bytes(itemsJson), itemsJson.length, itemsJson)
        ].concat(coverEntries);

        var blob = zipAssemble(entries, when);
        var filename = 'bili-fav-backup_' + exportScopeLabel(scope)
                     + '_' + exportStamp(when) + '.zip';
        exportTriggerDownload(blob, filename);

        // Appended only when non-zero, and the whole toast drops to warn: both
        // counts mean the archive is thinner than the list the user selected,
        // which a plain success line would hide.
        var msg = '已导出 ' + items.length + ' 项（' + fmtBytes(blob.size) + '）';
        if (missing) msg += ' · 记录缺失 ' + missing;
        if (coverFailed) msg += ' · 封面读取失败 ' + coverFailed;
        toast(msg, (missing || coverFailed) ? 'warn' : 'ok');

        return {
            items: items.length, covers: coverEntries.length, coverBytes: coverBytes,
            missing: missing, coverFailed: coverFailed,
            bytes: blob.size, filename: filename
        };
    }
    // ─── Menu commands ──────────────────────────────────────────────────
    //
    // Every command is a NAMED function here, and both surfaces call the same
    // one: the Tampermonkey menu registered at the bottom of this file, and
    // the in-page FAB menu (16a-fab.js). The two must never drift — a command
    // reachable from one and not the other is the bug this shape prevents.

    function cmdLogout() {
        clearAuth();
        toast('登录凭据已清除', 'ok');
    }

    function cmdToggleDebug() {
        DEBUG = !DEBUG; GM_setValue('debug', DEBUG);
        toast('调试日志：' + (DEBUG ? '已开启' : '已关闭'), 'ok');
    }

    function cmdRescan() {
        pageCache.clear(); pageItems.clear(); schedule();
    }

    function cmdScanMissing() {
        var mid = detectMediaId();
        if (!mid) { toast('无法识别当前收藏夹 ID', 'err'); return; }
        // Reset all three caches so a manual re-scan re-fetches both
        // ids endpoint AND walks phase 1 again (fresh state).
        _idsListCache.delete(mid);
        _phase1AvsCache.delete(mid);
        _missingBannerShown.delete(mid);
        detectMissingAndRender(mid);
    }

    function cmdClearAllCache() {
        var n = clearAllItemCache();
        if (n < 0) { toast('GM_listValues 权限缺失，无法批量清除', 'err'); return; }
        // Persistent GM items gone; now flush every in-memory layer too,
        // otherwise the page keeps serving cached rows until reload. The
        // on-screen cards are already patched (they no longer match the
        // invalid signature), so an in-place re-scan can't refresh them —
        // a reload is the clean, correct way to surface fresh data.
        dropAllInMemory();
        toast('已清除 ' + n + ' 项缓存，正在刷新…', 'ok');
        setTimeout(function () { location.reload(); }, 600);
    }

    function cmdClearAllNoRetry() {
        var c = clearAllNoRetry();
        var n = c.user + c.auto;
        if (!n) { toast('当前没有「停止重试」标记', 'ok'); return; }
        toast('已清除 ' + n + ' 项停止重试标记（手动 ' + c.user + ' · 自动 ' + c.auto + '）', 'ok');
        // Deliberately no reload: clearing the list changes no card's cached
        // snapshot, only which badge the next render pass paints. A repaint
        // is enough, and a reload would throw away a live flap loop.
        schedule();
    }

    // Every av on THIS page whose retry is still live — the payload of the
    // bulk stop below, and the source of its menu hint.
    //
    // Two sources, unioned, because neither alone is the whole page:
    //   - the rendered pending cards, which is what the user is looking at;
    //   - _flapLeftover, the set the loop gave up on in THIS folder. Those
    //     cards are pending too, but an av can sit in the leftover set while
    //     its card is momentarily absent from the DOM (mid re-render).
    // Avs the user already stopped are excluded so the count reads as "what
    // this click will actually change", not "how many pending cards exist".
    function pendingAvsOnPage() {
        var set = new Set();
        var nodes = document.querySelectorAll('[data-fav-fix-retry-action][data-fav-fix-retry-av]');
        for (var i = 0; i < nodes.length; i++) {
            var av = nodes[i].getAttribute('data-fav-fix-retry-av');
            if (av && !isNoRetryUser(av)) set.add(av);
        }
        var mid = detectMediaId();
        if (mid && _flapLeftoverMid === mid) {
            _flapLeftover.forEach(function (av) { if (!isNoRetryUser(av)) set.add(av); });
        }
        return Array.from(set);
    }

    function cmdStopRetryThisPage() {
        var avs = pendingAvsOnPage();
        if (!avs.length) { toast('本页没有仍在重试的条目', 'ok'); return; }
        avs.forEach(function (av) { setNoRetryUser(av); });
        toast('已停止本页 ' + avs.length + ' 项的重试', 'ok');
        // Repaint so every affected cover flips to 已停止重试 at once. The
        // running loop is left alone on purpose: it re-reads the stop list per
        // walk (isRetrySuppressed), so it drops these avs by itself.
        schedule();
    }

    function cmdBackupFolder() {
        // Async and long-running; nothing awaits it, so swallow rejections
        // here or an unexpected throw surfaces only as an unhandled
        // rejection in the console.
        backupCurrentFolder().catch(function (e) {
            warn('backup run threw', e);
            toast('备份失败：' + (e && e.message), 'err');
        });
    }

    function cmdManageBackup() {
        // Same swallow-the-rejection reasoning as the backup run above:
        // the panel opens asynchronously (IndexedDB probe + index walk)
        // and nothing awaits it here.
        openBackupManager().catch(function (e) {
            warn('backup manager threw', e);
            toast('打开备份管理失败：' + (e && e.message), 'err');
        });
    }

    function cmdAuthStatus() {
        var a = getAuth();
        var age = a.ts ? Math.floor((Date.now() - a.ts) / 86400000) : null;
        var msg = '登录模式：' + (a.mode || '未登录')
                + '　凭据：' + (a.access_key ? '已保存' : '未保存')
                + '　已保存：' + (age == null ? '未知' : age + ' 天前');
        toast(msg);
    }

    try {
        GM_registerMenuCommand('fav-fix：登录（TV 端二维码）', tvLogin);
        GM_registerMenuCommand('fav-fix：登录（手动输入凭据）', manualLogin);
        GM_registerMenuCommand('fav-fix：注销（清除登录凭据）', cmdLogout);
        GM_registerMenuCommand('fav-fix：开关调试日志', cmdToggleDebug);
        GM_registerMenuCommand('fav-fix：立即重新扫描并修复', cmdRescan);
        GM_registerMenuCommand('fav-fix：扫描静默丢弃的条目', cmdScanMissing);
        GM_registerMenuCommand('fav-fix：清除所有缓存并刷新页面', cmdClearAllCache);
        GM_registerMenuCommand('fav-fix：本页全部停止重试', cmdStopRetryThisPage);
        GM_registerMenuCommand('fav-fix：清除所有「停止重试」标记', cmdClearAllNoRetry);
        GM_registerMenuCommand('fav-fix：备份当前收藏夹（封面+信息 → IndexedDB）', cmdBackupFolder);
        GM_registerMenuCommand('fav-fix：管理备份', cmdManageBackup);
        GM_registerMenuCommand('fav-fix：查看登录状态', cmdAuthStatus);
    } catch (e) { warn('menu register failed', e); }

    // ─── Floating action button + two-level menu ────────────────────────
    //
    // A draggable circular button pinned to the viewport, opening a two-level
    // menu over every command this script has. It exists because the
    // Tampermonkey menu (16-menu-commands.js) is a flat list of twelve
    // same-looking rows buried behind the extension's toolbar popup: three
    // clicks away, no grouping, no live state, and invisible to anyone who
    // does not already know the script is installed.
    //
    // Both surfaces call the SAME cmd* functions — see 16-menu-commands.js.
    // This module owns presentation only; it must never implement a command.
    //
    // ── Interaction contract ──
    //   press + move  → drag the button (position persisted, GM 'fab:pos')
    //   press + release without moving → toggle the menu
    //   menu level 0  → categories; level 1 → that category's commands,
    //                   with 返回 as the first row (the user's stated shape)
    //
    // ── Geometry constraint (learned the hard way elsewhere) ──
    // The menu MUST be position:absolute, anchored on the button. If it sat
    // in flow, the host's box would be menu-sized (~238×400) and the drag
    // clamp — which keeps the HOST inside the viewport — would strand the
    // 48px button somewhere mid-screen, unable to reach any edge. With the
    // menu absolute the host box IS the button, so the clamp is exact.

    var FAB_POS_KEY     = 'fab:pos';   // GM key → { left, top } viewport px
    var FAB_SIZE        = 48;          // keep in sync with .fav-fix-fab-btn
    var FAB_EDGE_GAP    = 8;           // min distance from any viewport edge
    var FAB_DRAG_TAP_PX = 4;           // below this a press is a click, not a drag

    var _fabHost = null, _fabBtn = null, _fabMenu = null, _fabBody = null;
    var _fabOpen = false;
    var _fabCat  = null;    // null = level 0, else the open category's id
    var _fabDragging = false;
    // Set when a drag ends, consumed by the click handler. Without it every
    // release fires the click that follows a mouseup and the menu pops open
    // at the end of each drag.
    var _fabSuppressClick = false;
    var _fabStylesInjected = false;

    // Live right-hand hints. Computed at render time, never cached: the whole
    // point is that the menu reports the state as it is when it opens.
    function fabDebugHint()   { return DEBUG ? '已开启' : '已关闭'; }
    function fabAuthHint()    { var a = getAuth(); return a.access_key ? (a.mode || '已登录') : '未登录'; }
    function fabNoRetryHint() { var c = noRetryCounts(); var n = c.user + c.auto; return n ? n + ' 项' : '无'; }
    function fabPageHint()    { var n = pendingAvsOnPage().length; return n ? n + ' 项' : '无'; }

    // The menu tree. Data, not code: one place to read what the script can do.
    // `danger: true` paints the row red — reserved for the two commands that
    // destroy state the user cannot get back by clicking again.
    var FAB_MENU = [
        { id: 'account', label: '账号与登录', hint: fabAuthHint, items: [
            { label: '登录（TV 端二维码）',   run: function () { tvLogin(); } },
            { label: '登录（手动输入凭据）',  run: function () { manualLogin(); } },
            { label: '查看登录状态',          run: cmdAuthStatus, hint: fabAuthHint },
            { label: '注销（清除登录凭据）',  run: cmdLogout, danger: true }
        ] },
        { id: 'scan', label: '扫描与修复', items: [
            { label: '立即重新扫描并修复',    run: cmdRescan },
            { label: '扫描静默丢弃的条目',    run: cmdScanMissing }
        ] },
        { id: 'retry', label: '重试控制', hint: fabPageHint, items: [
            { label: '本页全部停止重试',      run: cmdStopRetryThisPage, hint: fabPageHint },
            { label: '清除所有「停止重试」标记', run: cmdClearAllNoRetry, hint: fabNoRetryHint }
        ] },
        { id: 'backup', label: '备份', items: [
            { label: '备份当前收藏夹',        run: cmdBackupFolder },
            { label: '管理备份',              run: cmdManageBackup }
        ] },
        { id: 'maint', label: '维护与调试', items: [
            { label: '开关调试日志',          run: cmdToggleDebug, hint: fabDebugHint },
            { label: '清除所有缓存并刷新页面', run: cmdClearAllCache, danger: true }
        ] }
    ];

    var FAB_ICON_IDLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';
    var FAB_ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

    function ensureFabStyles() {
        if (_fabStylesInjected) return;
        _fabStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_fab_styles';
        st.textContent = [
            '@keyframes __fav_fix_fab_in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }',
            // Host: the button's box and nothing more (see the geometry note
            // at the top of this file). Default anchor is bottom-right, clear
            // of bilibili's own back-to-top control.
            '.fav-fix-fab {',
            '  position:fixed; right:24px; bottom:172px; z-index:2147483645;',
            '  width:' + FAB_SIZE + 'px; height:' + FAB_SIZE + 'px;',
            '  font:13px/1.5 -apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;',
            '}',
            '.fav-fix-fab-btn {',
            '  width:100%; height:100%; border-radius:50%;',
            '  display:flex; align-items:center; justify-content:center;',
            '  background:#fb7299; color:#fff; cursor:pointer; user-select:none;',
            '  box-shadow:0 4px 14px rgba(251,114,153,.45);',
            '  transition:background .15s, box-shadow .15s, transform .12s;',
            '}',
            '.fav-fix-fab-btn:hover { background:#e8618a; box-shadow:0 6px 18px rgba(251,114,153,.55); }',
            '.fav-fix-fab-btn:active { transform:scale(.94); }',
            '.fav-fix-fab-btn svg { width:24px; height:24px; display:block; fill:currentColor; }',
            // Children never receive pointer events: the drag handler needs
            // mousedown on the button itself, and an inner <svg> target would
            // make the geometry read from the wrong element.
            '.fav-fix-fab-btn * { pointer-events:none; }',
            '.fav-fix-fab.open .fav-fix-fab-btn { background:#18191c; box-shadow:0 4px 14px rgba(0,0,0,.35); }',
            '.fav-fix-fab.open .fav-fix-fab-btn:hover { background:#2f3238; }',
            '.fav-fix-fab.dragging .fav-fix-fab-btn {',
            '  cursor:grabbing; transform:scale(1.06);',
            '  box-shadow:0 0 0 4px rgba(251,114,153,.28), 0 8px 20px rgba(0,0,0,.28);',
            '}',

            '.fav-fix-fab-menu {',
            '  position:absolute; width:244px; display:none;',
            '  background:#fff; border:1px solid #e3e5e7; border-radius:10px;',
            '  box-shadow:0 10px 30px rgba(0,0,0,.16); overflow:hidden;',
            '}',
            '.fav-fix-fab.open .fav-fix-fab-menu { display:block; animation:__fav_fix_fab_in .14s ease-out; }',
            // Four anchor combinations, chosen per open() from where the
            // button currently sits, so the menu never opens off-screen.
            '.fav-fix-fab.up   .fav-fix-fab-menu { bottom:' + (FAB_SIZE + 12) + 'px; top:auto; }',
            '.fav-fix-fab.down .fav-fix-fab-menu { top:' + (FAB_SIZE + 12) + 'px; bottom:auto; }',
            '.fav-fix-fab.ra   .fav-fix-fab-menu { right:0; left:auto; }',
            '.fav-fix-fab.la   .fav-fix-fab-menu { left:0; right:auto; }',

            '.fav-fix-fab-head {',
            '  display:flex; align-items:baseline; gap:6px;',
            '  padding:10px 12px; border-bottom:1px solid #f1f2f3; background:#fafbfc;',
            '}',
            '.fav-fix-fab-head .t { font-size:13px; font-weight:600; color:#18191c; }',
            '.fav-fix-fab-head .v { font-size:11px; color:#9499a0; }',
            '.fav-fix-fab-list { max-height:min(62vh,440px); overflow-y:auto; padding:4px 0; }',
            '.fav-fix-fab-row {',
            '  display:flex; align-items:center; gap:8px;',
            '  padding:9px 12px; cursor:pointer; color:#18191c;',
            '  font-size:13px; transition:background .12s;',
            '}',
            '.fav-fix-fab-row:hover { background:#f6f7f8; }',
            '.fav-fix-fab-row .lb { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
            '.fav-fix-fab-row .hint { flex:none; font-size:11px; color:#9499a0; }',
            '.fav-fix-fab-row .chev { flex:none; font-size:15px; line-height:1; color:#c9ccd0; }',
            '.fav-fix-fab-row.danger { color:#e13c53; }',
            '.fav-fix-fab-row.danger:hover { background:rgba(225,60,83,.06); }',
            '.fav-fix-fab-row.danger .hint { color:rgba(225,60,83,.7); }',
            // The back row is the first thing in a level-1 list, per the
            // stated design: one fixed place to go up, always at the top.
            '.fav-fix-fab-back {',
            '  display:flex; align-items:center; gap:6px;',
            '  padding:9px 12px; cursor:pointer; background:#fafbfc;',
            '  border-bottom:1px solid #f1f2f3; transition:background .12s;',
            '}',
            '.fav-fix-fab-back:hover { background:#f1f2f3; }',
            '.fav-fix-fab-back .arw { font-size:15px; line-height:1; color:#61666d; }',
            '.fav-fix-fab-back .bk  { font-size:12px; color:#61666d; }',
            '.fav-fix-fab-back .cat { margin-left:auto; font-size:12px; font-weight:600; color:#18191c; }',
            '.fav-fix-fab-tip { padding:8px 12px 10px; font-size:11px; color:#9499a0; border-top:1px solid #f1f2f3; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // ── Position ────────────────────────────────────────────────────────

    function fabClamp(left, top) {
        var w = _fabHost.offsetWidth  || FAB_SIZE;
        var h = _fabHost.offsetHeight || FAB_SIZE;
        var maxL = Math.max(FAB_EDGE_GAP, window.innerWidth  - w - FAB_EDGE_GAP);
        var maxT = Math.max(FAB_EDGE_GAP, window.innerHeight - h - FAB_EDGE_GAP);
        return {
            left: Math.min(Math.max(FAB_EDGE_GAP, left), maxL),
            top:  Math.min(Math.max(FAB_EDGE_GAP, top),  maxT)
        };
    }

    // Applying an inline left/top MUST clear the CSS default anchor, or the
    // surviving `right`/`bottom` fights the new coordinates and the button
    // drifts a little further every reload.
    function fabApplyPos(left, top) {
        var p = fabClamp(left, top);
        _fabHost.style.left   = p.left + 'px';
        _fabHost.style.top    = p.top  + 'px';
        _fabHost.style.right  = 'auto';
        _fabHost.style.bottom = 'auto';
        return p;
    }

    function fabLoadPos() {
        var raw = GM_getValue(FAB_POS_KEY, null);
        if (!raw) return;
        try {
            var p = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (p && isFinite(p.left) && isFinite(p.top)) fabApplyPos(p.left, p.top);
        } catch (e) { warn('fab: bad saved position', e); }
    }

    function fabSavePos(p) {
        try { GM_setValue(FAB_POS_KEY, { left: p.left, top: p.top }); }
        catch (e) { warn('fab: cannot persist position', e); }
    }

    // Clear the persisted position and fall back to the CSS anchor. A button
    // dragged somewhere awkward otherwise has no way home: the coordinates
    // live in GM storage, which the page console cannot reach.
    function fabResetPosition() {
        try { GM_deleteValue(FAB_POS_KEY); } catch (e) { warn('fab: cannot clear position', e); }
        if (_fabHost) {
            _fabHost.style.left = '';
            _fabHost.style.top = '';
            _fabHost.style.right = '';
            _fabHost.style.bottom = '';
        }
        return 'fab position reset';
    }

    // ── Menu rendering ──────────────────────────────────────────────────

    function fabRow(cls, label, hint, chev) {
        var row = document.createElement('div');
        row.className = cls;
        var lb = document.createElement('span');
        lb.className = 'lb';
        lb.textContent = label;
        row.appendChild(lb);
        if (hint) {
            var h = document.createElement('span');
            h.className = 'hint';
            h.textContent = hint;
            row.appendChild(h);
        }
        if (chev) {
            var c = document.createElement('span');
            c.className = 'chev';
            c.textContent = chev;
            row.appendChild(c);
        }
        return row;
    }

    // Read a hint callback without letting a broken one blank the whole menu.
    function fabHint(fn) {
        if (typeof fn !== 'function') return '';
        try { return fn() || ''; } catch (e) { warn('fab: hint threw', e); return ''; }
    }

    function fabRenderMenu() {
        _fabBody.textContent = '';
        var i;
        if (!_fabCat) {
            var head = document.createElement('div');
            head.className = 'fav-fix-fab-head';
            var t = document.createElement('span'); t.className = 't'; t.textContent = 'fav-fix';
            var v = document.createElement('span'); v.className = 'v'; v.textContent = CORE_VERSION;
            head.appendChild(t); head.appendChild(v);
            _fabBody.appendChild(head);

            var list = document.createElement('div');
            list.className = 'fav-fix-fab-list';
            for (i = 0; i < FAB_MENU.length; i++) {
                (function (cat) {
                    var row = fabRow('fav-fix-fab-row', cat.label, fabHint(cat.hint), '›');
                    row.addEventListener('click', function (e) {
                        e.preventDefault(); e.stopPropagation();
                        _fabCat = cat.id;
                        fabRenderMenu();
                    });
                    list.appendChild(row);
                })(FAB_MENU[i]);
            }
            _fabBody.appendChild(list);

            var tip = document.createElement('div');
            tip.className = 'fav-fix-fab-tip';
            tip.textContent = '按住此按钮可拖动位置';
            _fabBody.appendChild(tip);
            return;
        }

        var cat = null;
        for (i = 0; i < FAB_MENU.length; i++) if (FAB_MENU[i].id === _fabCat) cat = FAB_MENU[i];
        // The open category vanished (only reachable if FAB_MENU changed under
        // us). Fall back to the top level rather than rendering an empty menu.
        if (!cat) { _fabCat = null; fabRenderMenu(); return; }

        var back = document.createElement('div');
        back.className = 'fav-fix-fab-back';
        var arw = document.createElement('span'); arw.className = 'arw'; arw.textContent = '‹';
        var bk  = document.createElement('span'); bk.className  = 'bk';  bk.textContent  = '返回';
        var nm  = document.createElement('span'); nm.className  = 'cat'; nm.textContent  = cat.label;
        back.appendChild(arw); back.appendChild(bk); back.appendChild(nm);
        back.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            _fabCat = null;
            fabRenderMenu();
        });
        _fabBody.appendChild(back);

        var ilist = document.createElement('div');
        ilist.className = 'fav-fix-fab-list';
        for (i = 0; i < cat.items.length; i++) {
            (function (item) {
                var cls = 'fav-fix-fab-row' + (item.danger ? ' danger' : '');
                var row = fabRow(cls, item.label, fabHint(item.hint), '');
                row.addEventListener('click', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    // Close FIRST: several commands open a modal of their own
                    // (login, backup manager) and the menu would sit on top of
                    // it. A throwing command must not leave the menu open
                    // either, hence the try/catch around the call only.
                    fabClose();
                    try { item.run(); }
                    catch (err) { warn('fab: command threw', err); toast('操作失败：' + (err && err.message), 'err'); }
                });
                ilist.appendChild(row);
            })(cat.items[i]);
        }
        _fabBody.appendChild(ilist);
    }

    // ── Open / close ────────────────────────────────────────────────────

    // Anchor the menu on the side with room for it. Decided per open, from the
    // button's live rect, because the button can be anywhere by then.
    function fabPlaceMenu() {
        var r = _fabHost.getBoundingClientRect();
        var openUp = (r.top + r.height / 2) > window.innerHeight / 2;
        var alignRight = (r.left + r.width / 2) > window.innerWidth / 2;
        _fabHost.classList.toggle('up',   openUp);
        _fabHost.classList.toggle('down', !openUp);
        _fabHost.classList.toggle('ra',   alignRight);
        _fabHost.classList.toggle('la',   !alignRight);
    }

    function fabOpen() {
        if (_fabOpen) return;
        _fabOpen = true;
        _fabCat = null;              // always land on the categories
        fabRenderMenu();
        fabPlaceMenu();
        _fabHost.classList.add('open');
        _fabBtn.innerHTML = FAB_ICON_OPEN;
        _fabBtn.title = '关闭菜单';
    }

    function fabClose() {
        if (!_fabOpen) return;
        _fabOpen = false;
        _fabCat = null;
        _fabHost.classList.remove('open');
        _fabBtn.innerHTML = FAB_ICON_IDLE;
        _fabBtn.title = 'fav-fix 菜单（按住可拖动）';
    }

    // ── Drag ────────────────────────────────────────────────────────────

    function fabBindDrag() {
        _fabBtn.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            var r = _fabHost.getBoundingClientRect();
            var dx = e.clientX - r.left, dy = e.clientY - r.top;
            var startX = e.clientX, startY = e.clientY;
            var moved = false;
            var last = { left: r.left, top: r.top };

            function onMove(ev) {
                if (!moved) {
                    if (Math.abs(ev.clientX - startX) < FAB_DRAG_TAP_PX &&
                        Math.abs(ev.clientY - startY) < FAB_DRAG_TAP_PX) return;
                    moved = true;
                    _fabDragging = true;
                    _fabHost.classList.add('dragging');
                    // A menu left open would travel with the button and fight
                    // the anchor classes recomputed on the next open.
                    fabClose();
                }
                last = fabApplyPos(ev.clientX - dx, ev.clientY - dy);
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('mouseup', onUp, true);
                if (!moved) return;
                _fabDragging = false;
                _fabHost.classList.remove('dragging');
                // Swallow the click that follows this mouseup, or every drag
                // ends by popping the menu open.
                _fabSuppressClick = true;
                fabSavePos(last);
            }
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        });
    }

    // ── Install ─────────────────────────────────────────────────────────

    function installFab() {
        if (_fabHost) return;
        ensureFabStyles();

        _fabHost = document.createElement('div');
        _fabHost.className = 'fav-fix-fab';
        _fabHost.setAttribute('data-fav-fix-fab', '1');

        _fabBtn = document.createElement('div');
        _fabBtn.className = 'fav-fix-fab-btn';
        _fabBtn.setAttribute('role', 'button');
        _fabBtn.setAttribute('tabindex', '0');
        _fabBtn.title = 'fav-fix 菜单（按住可拖动）';
        _fabBtn.innerHTML = FAB_ICON_IDLE;

        _fabMenu = document.createElement('div');
        _fabMenu.className = 'fav-fix-fab-menu';
        _fabBody = _fabMenu;

        _fabHost.appendChild(_fabBtn);
        _fabHost.appendChild(_fabMenu);
        document.body.appendChild(_fabHost);

        // Position is applied only after the host is in the document: a
        // detached (or display:none) node measures 0×0 and the clamp would
        // compute its bounds against the whole viewport.
        fabLoadPos();
        fabBindDrag();

        _fabBtn.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (_fabSuppressClick) { _fabSuppressClick = false; return; }
            if (_fabOpen) fabClose(); else fabOpen();
        });
        _fabMenu.addEventListener('click', function (e) { e.stopPropagation(); });

        document.addEventListener('click', function (e) {
            if (!_fabOpen) return;
            if (_fabHost.contains(e.target)) return;
            fabClose();
        }, true);
        document.addEventListener('keydown', function (e) {
            if (!_fabOpen) return;
            // Esc backs out one level, matching the on-screen 返回 row, and
            // closes only from the top level.
            if (e.key !== 'Escape') return;
            if (_fabCat) { _fabCat = null; fabRenderMenu(); } else { fabClose(); }
        });
        window.addEventListener('resize', function () {
            var r = _fabHost.getBoundingClientRect();
            // Only re-clamp a dragged button. One left at the CSS default has
            // no inline left/top, and writing one here would freeze it away
            // from its anchor.
            if (_fabHost.style.left) fabApplyPos(r.left, r.top);
            if (_fabOpen) fabPlaceMenu();
        });
    }

    // ─── Boot ───────────────────────────────────────────────────────────

    function boot() {
        if (!isFavPage()) { log('not a fav page, idle'); return; }
        log('booting on', location.href);
        // Build the 停止重试 index before the first patch pass, so the very
        // first render already knows which cards are switched off. Every
        // accessor re-checks the guard anyway, so this is an optimization of
        // ordering, not a correctness dependency.
        loadNoRetryIndex();
        // The in-page command surface. Installed before the first patch
        // pass so the button is reachable even if a scan stalls.
        try { installFab(); } catch (e) { warn('fab install failed', e); }
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
        //
        // exportAll() is the panel's 导出筛选结果 without the panel: it indexes
        // the WHOLE store and hands every row to the same exportBackupRows
        // (15c-backup-export.js), so the archive can be regression-tested (open
        // it, verify the CRCs, count the entries) with no UI in the loop. The
        // scope sort is 'none' because a cursor walk has no view ordering to
        // record — the panel supplies its own dropdown value instead.
        backup: {
            run: backupCurrentFolder,
            status: backupStatus,
            manage: openBackupManager,
            exportAll: function () {
                return buildBackupIndex().then(function (rows) {
                    return exportBackupRows(rows, {
                        scope: { folder: '*', folderTitle: null, query: '', sort: 'none' }
                    });
                });
            }
        },
        // The 停止重试 list (07a-noretry.js). stop()/resume() go through the
        // SAME helpers the cover badge and the card menu use, so a console
        // session cannot produce a state the UI could not have produced.
        // clearAll() repaints (schedule) instead of reloading — no card's
        // cached snapshot changed, only which badge belongs on it.
        fab: {
            resetPosition: fabResetPosition,
            open:  function () { fabOpen();  return 'fab menu opened'; },
            close: function () { fabClose(); return 'fab menu closed'; }
        },
        noRetry: {
            list: noRetryList,
            counts: noRetryCounts,
            stop: function (avOrBv) {
                var av = String(avOrBv);
                if (/^BV/i.test(av)) av = bvToAv(av);
                stopRetryForAv(av);
                return noRetryCounts();
            },
            resume: function (avOrBv) {
                var av = String(avOrBv);
                if (/^BV/i.test(av)) av = bvToAv(av);
                resumeRetryForAv(av);
                return noRetryCounts();
            },
            clearAll: function () { var c = clearAllNoRetry(); schedule(); return c; }
        },

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
                '__biliFavFix.backup.exportAll()   download the whole backup as one .zip',
                '__biliFavFix.noRetry              stop-retry list: list()/counts()/stop(av)/resume(av)/clearAll()',
                '__biliFavFix.fab.resetPosition()  move the floating button back to its default corner',
                '__biliFavFix.clearAllItemCache()  nuke all per-item GM storage (backup DB untouched)',
                '__biliFavFix.clearAuth()          drop access_key',
                '__biliFavFix.bvToAv(bv) / avToBv(av)'
            ].join('\n'));
        }
    };

    console.info('[fav-fix] core ' + CORE_VERSION + ' ready · type __biliFavFix.help() for commands');
})();
