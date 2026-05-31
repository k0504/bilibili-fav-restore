// ==UserScript==
// @name         Bilibili 收藏夹失效视频信息还原
// @name:zh-TW   Bilibili 收藏夾失效影片資訊還原
// @name:en      Bilibili Fav Restore
// @namespace    https://github.com/k0504/bilibili-fav-restore
// @version      0.9.0
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
// @connect      xbeibeix.com
// @license      MIT
// ==/UserScript==

/*
 * AUTO-GENERATED — do not edit by hand.
 * Source: src/*.js assembled by bundle.py (CORE_VERSION = 0.9.0)
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
    var CORE_VERSION = '0.9.0';

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
                    if (opts.raw) {
                        // Raw mode: caller wants the response body verbatim
                        // (HTML scraping / non-JSON sources like xbeibeix).
                        // Also surface the final URL so callers can detect
                        // server-side redirects (e.g. xbeibeix bouncing back
                        // to its landing page when an av isn't archived).
                        resolve({ status: resp.status, body: text, finalUrl: resp.finalUrl || url });
                        return;
                    }
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
        // off-site calls. Both sites rate-limit aggressively, so we
        // retry-once on -503 and otherwise just skip the missing av.
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
                // All 3rd-party archives (biliplus / xbeibeix / jijidown)
                // are best-effort fallbacks; never let a slow archive hold
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
        xbeibeix: {
            name: 'xbeibeix',
            paginated: false,
            enabled: function () { return sourceFailureGate.isOpen('xbeibeix'); },
            // xbeibeix is BV-keyed HTML scraping (no JSON API), so:
            //   - we avToBv each av before request
            //   - parse the response with DOMParser
            //   - title from `.fw-bold`, cover from `img.img-thumbnail`,
            //     author from the first `<input>` value
            // It also gates behind a CAPTCHA on heavy traffic; detected by
            // the `<meta name="robots">` tag (cerenkov's check). When that
            // happens we skip the av silently — the user can verify human
            // manually by visiting any xbeibeix.com/video/BVx URL once.
            fetchAvs: async function (avs) {
                var out = new Map();
                if (!avs.length) return out;
                console.info('[fav-fix/xbeibeix] querying', avs.length, 'av(s) (sequential, HTML):',
                             avs.slice(0, 5).join(',') + (avs.length > 5 ? ',…' : ''));
                var REQ_TIMEOUT = 5000;
                var sawAnyResponse = false;     // any HTTP-level success (incl. redirect / robots)
                for (var i = 0; i < avs.length; i++) {
                    var av = avs[i];
                    var bv = avToBv(av);
                    if (!bv) {
                        console.info('[fav-fix/xbeibeix] av', av, 'avToBv failed, skip');
                        continue;
                    }
                    var url = 'https://xbeibeix.com/video/' + bv;
                    var r;
                    try { r = await gmGet(url, { raw: true, timeout: REQ_TIMEOUT }); }
                    catch (e) {
                        console.warn('[fav-fix/xbeibeix] av', av, 'network error:', e.message);
                        continue;
                    }
                    if (!r || !r.body) continue;
                    sawAnyResponse = true;
                    // Server-side redirect to landing means the av isn't there.
                    if (r.finalUrl && !/\/video\//.test(r.finalUrl)) {
                        console.info('[fav-fix/xbeibeix] av', av, 'redirected (no record)');
                        continue;
                    }
                    var doc;
                    try { doc = new DOMParser().parseFromString(r.body, 'text/html'); }
                    catch (e) { continue; }
                    if (doc.querySelector('meta[name="robots"]')) {
                        console.warn('[fav-fix/xbeibeix] av', av, 'CAPTCHA — visit https://xbeibeix.com/video/' + bv + ' once to clear');
                        continue;
                    }
                    var titleEl = doc.querySelector('.fw-bold');
                    var imgEl   = doc.querySelector('img.img-thumbnail');
                    var authorEl = doc.querySelector('input');
                    var title = titleEl && titleEl.textContent && titleEl.textContent.trim();
                    var cover = imgEl && imgEl.getAttribute('src');
                    var author = authorEl && authorEl.getAttribute('value');
                    if (!title && !cover) continue;
                    // cerenkov: covers not under /bfs/archive/ are likely stale.
                    // We still keep them (better than placeholder) but mark
                    // quality lower implicitly via QUALITY.cover.
                    out.set(String(av), {
                        oid:   Number(av),
                        title: title || undefined,
                        cover: cover || undefined,
                        upper: author ? { name: author } : undefined
                    });
                }
                // Backoff: any HTTP-level response means the site is up
                // even if the av wasn't archived. Only flag failure if
                // every single request errored.
                if (sawAnyResponse) sourceFailureGate.onOk('xbeibeix');
                else sourceFailureGate.onFail('xbeibeix', 'all requests errored');
                console.info('[fav-fix/xbeibeix] total:', out.size, '/', avs.length);
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
                var sawAnyResponse = false;
                for (var i = 0; i < avs.length; i++) {
                    var av = avs[i];
                    var url = 'https://www.jijidown.com/api/v1/video/get_info?id=' + av;
                    var r;
                    try { r = await gmGet(url, { timeout: REQ_TIMEOUT }); }
                    catch (e) {
                        console.warn('[fav-fix/jijidown] av', av, 'network error:', e.message);
                        continue;
                    }
                    if (!r) continue;
                    sawAnyResponse = true;
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
        return { list: list, has_more: !!d.has_more, total: d.info && d.info.media_count };
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
    // 3rd-party archives (biliplus / xbeibeix / jijidown) carry only
    // title/cover/upper.name — they're the last-resort fallback for items
    // even the Android-app snapshot couldn't save.
    var FIELD_PRIORITY = {
        // Android endpoint preserves invalid-item snapshots for these.
        // xbeibeix is ordered last among 3rd-party because its cover URLs
        // are often the same hdslb CDN ones already gone — cerenkov notes
        // "极大概率是失效的旧图片链接" when not in /bfs/archive/ path.
        cover:    ['android', 'public', 'biliplus', 'jijidown', 'xbeibeix'],
        title:    ['android', 'public', 'biliplus', 'jijidown', 'xbeibeix'],
        upper:    ['android', 'public', 'biliplus', 'jijidown', 'xbeibeix'],
        intro:    ['android', 'public'],
        duration: ['android', 'public'],
        playback_desc: ['android', 'public'],
        attr:     ['android', 'public'],
        link:     ['android', 'public'],
        bvid:     ['public', 'android'],
        // Public endpoint has these; Android omits them for invalid items:
        cnt_info: ['public',  'android'],
        pubtime:  ['public'],
        ctime:    ['public',  'android'],
        fav_time: ['public'],
        tid:      ['public'],
        pages:    ['public'],
        page:     ['public',  'android']
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
    var CACHE_VERSION = 5;   // bumped: +_degenerate flag (short TTL on no-cover-no-title merges)
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
        //   _degenerate — some source returned only placeholders, or
        //   _pending    — android may still flap the real snapshot back in
        //                 (see runFlapRecovery in 08-resolver.js).
        // Locking these for 30 days would turn a transient android walk-to-walk
        // drop into a permanent "deleted" (observed: a war-footage folder where
        // android returned 58/89 on one walk and the dropped items all fell to
        // _no_source). Only a confidently-recovered merge gets the long TTL.
        var ttl = (v._degenerate || v._pending) ? CACHE_TTL_DEGENERATE_MS : CACHE_TTL_MS;
        if (v._cached_at && (Date.now() - v._cached_at > ttl)) return null;
        return v;
    }
    function saveCache(av, merged) {
        merged._cache_version = CACHE_VERSION;
        merged._cached_at = Date.now();
        try { GM_setValue(CACHE_PREFIX + av, merged); }
        catch (e) { warn('saveCache failed for av', av, e); }
    }
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
                // No source returned this av this pass.
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
        if (androidUp) {
            var bgCandidates = todoAvs.filter(function (av) {
                var m = result.get(av);
                return m && m._pending;
            });
            if (bgCandidates.length) {
                runFlapRecovery(mediaId, bgCandidates)
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
    // Adaptive backoff (FLAP_BACKOFF_MS / FLAP_MAX_DRY in 01-constants.js): the
    // `dry` counter drives BOTH cadence and termination. A walk that recovers
    // something resets dry → next walk fires after the short burst gap; a walk
    // that recovers nothing bumps dry → the gap widens and, at FLAP_MAX_DRY,
    // the loop concludes the leftovers are genuinely filtered and stops. So a
    // still-flapping folder is sampled fast and converges; a truly-deleted set
    // is abandoned after ~7 cheap samples (~4 min) instead of being hammered.
    //
    // Re-patch strategy: when a walk recovers an av we saveCache() the upgraded
    // merge and call schedule(). The still-pending cards remain detectable by
    // findInvalidContainers Strategy 2 (their title is still "已失效视频"), and
    // loadCache now returns the good merge, so patchOnce's fast path swaps
    // cover+title in place — no stored DOM hits to go stale across bilibili's
    // virtualized scroll, no spinner re-flash (recovered avs hit the cache fast
    // path, not the resolver). Cards still pending while the loop is alive show
    // a "重试中" badge (markPending reads _flapBgRunning); they flip to "待重试"
    // only once the loop terminates (the finally's schedule()).
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
    // Avs the loop GAVE UP on (still pending after it stopped), kept so a card's
    // "立即重试" menu item (kickManualRetry) can re-arm the loop with the WHOLE
    // leftover set in one walk instead of chasing a single av. Scoped to one
    // folder via _flapLeftoverMid; cleared on folder switch (dropAllInMemory).
    var _flapLeftover = new Set();
    var _flapLeftoverMid = null;
    async function runFlapRecovery(mediaId, candidates) {
        if (_flapBgRunning) return;
        if (!candidates || !candidates.length) return;
        if (!SOURCES.android.enabled()) return;
        _flapBgRunning = true;
        // Flip any on-screen pending badges to "重试中" right away: the loop may
        // sleep on its first backoff before any recovery-driven schedule(), and
        // a MANUAL re-arm has nothing else to repaint the cards.
        schedule();
        var pending = new Set(candidates.map(String));
        var deadline = Date.now() + FLAP_TIME_BUDGET_MS;
        var walk = 0, dry = 0;
        try {
            log('flap-bg: start', pending.size, 'candidate(s):',
                Array.from(pending).slice(0, 5).join(',') + (pending.size > 5 ? ',…' : ''));
            while (pending.size && dry < FLAP_MAX_DRY) {
                if (detectMediaId() !== mediaId) { log('flap-bg: folder changed, abort'); break; }
                if (Date.now() > deadline)       { log('flap-bg: 30-min budget exhausted'); break; }
                walk++;

                // One fresh android walk straight into pageItems.
                var pn = 1;
                while (pn <= MAX_PAGE_WALK) {
                    if (detectMediaId() !== mediaId || Date.now() > deadline) break;
                    var allFound = true;
                    pending.forEach(function (av) { if (!pageItems.has('android|' + av)) allFound = false; });
                    if (allFound) break;
                    var page;
                    try { page = await SOURCES.android.fetchPage({ mediaId: mediaId, pn: pn }); }
                    catch (e) { warn('flap-bg walk ' + walk + ' pn ' + pn + ' failed:', e.message); break; }
                    (page.list || []).forEach(function (it) {
                        if (it && it.oid != null) pageItems.set('android|' + it.oid, it);
                    });
                    if (!page.has_more) break;
                    pn++;
                }

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
                    if (merged._degenerate) return;   // still no good cover/title — keep trying
                    saveCache(av, merged);
                    pending.delete(av);
                    recovered.push(av);
                });

                if (recovered.length) {
                    dry = 0;   // progress → reset cadence to the burst gap and keep sampling fast
                    log('flap-bg walk ' + walk + ': recovered', recovered.length,
                        '→ re-patch;', pending.size, 'left');
                    // Upgrade on-screen cards via the normal fast path.
                    schedule();
                } else {
                    dry++;     // no progress → widen the gap, step toward giving up
                    log('flap-bg walk ' + walk + ': 0 new (dry ' + dry + '/' + FLAP_MAX_DRY + ')');
                }

                if (!pending.size || dry >= FLAP_MAX_DRY) break;

                // Adaptive backoff before the next walk: gap widens with `dry`.
                // Sleep in ~1s slices so a folder switch / budget expiry breaks
                // out within a second (frees _flapBgRunning for the next folder).
                var gap = FLAP_BACKOFF_MS[Math.min(dry, FLAP_BACKOFF_MS.length - 1)];
                var until = Date.now() + gap;
                while (Date.now() < until) {
                    if (detectMediaId() !== mediaId || Date.now() > deadline) break;
                    await new Promise(function (r) { setTimeout(r, Math.min(1000, until - Date.now())); });
                }
            }
            log('flap-bg: done after', walk, 'walk(s);', pending.size,
                'still unrecovered (stays 待重试 until a fresh reload re-attempts)');
        } finally {
            _flapBgRunning = false;
            // Remember the avs we gave up on so a card's "立即重试" can re-arm
            // the loop over the WHOLE leftover set (not just the clicked card).
            // If the loop recovered everything, pending is empty → no leftover →
            // the retry menu item won't render (cards are no longer _pending).
            _flapLeftover = new Set(pending);
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
        var cands = (_flapLeftoverMid === mid) ? Array.from(_flapLeftover) : [];
        if (!cands.length && clickedAv) cands = [String(clickedAv)];
        if (!cands.length) { toast('没有待重试的视频', 'ok'); return; }
        toast('正在重新抓取 ' + cands.length + ' 项待重试视频', 'ok');
        runFlapRecovery(mid, cands).catch(function (e) { warn('manual retry threw:', e); });
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

    function patchCover(img, realCoverUrl) {
        if (!img || !realCoverUrl) return;
        // bilibili web is https — Android-app responses are sometimes http.
        var u = realCoverUrl.replace(/^http:\/\//, 'https://');
        if (img.getAttribute('data-fav-fix-original')) return; // already patched
        img.setAttribute('data-fav-fix-original', img.src || '');
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

    // Third-party archives (xbeibeix HTML scrape, biliplus, jijidown) are an
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
        android:   '#5b8def',
        'public':  '#67c23a',
        biliplus:  '#e6a23c',
        xbeibeix:  '#9b59b6',
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
        // with empty fields). _flapBgRunning is read LIVE here — showTip rebuilds
        // innerHTML on every hover — so the text tracks whether the loop is
        // currently alive (重试中) or has stopped (待重试), matching the badge.
        if (real._pending) {
            var pav = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : '');
            var pbv = real.bvid || (pav ? avToBv(pav) : null);
            var pActive = _flapBgRunning;
            var pHead = pActive ? '正在找回此视频快照…' : '暂未找回，等待重试';
            var pBody = pActive
                ? 'bilibili 的 android 收藏接口会随机漏掉一部分失效视频，脚本正在后台多次重新采样把它捞回来。找回后本卡片会自动更新封面与标题，无需手动操作。'
                : '后台已多次重新采样仍未取回——可能视频确实已被删除，也可能是 bilibili 接口暂时不返回。重新整理本页会自动再试一轮；也可在本卡片右上「···」菜单点「立即重试」立刻再抓一轮。';
            return '<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;'
                 + 'line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                 + esc(pHead) + '</div>'
                 + (pav ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">AV ' + codeTag('av' + pav) + '</div>' : '')
                 + (pbv ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">BV ' + codeTag(pbv) + '</div>' : '')
                 + '<div style="margin-top:6px;color:#bdbdc2;font-size:11px;line-height:1.55">'
                 + esc(pBody) + '</div>'
                 + '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                 + 'fav-fix · ' + (pActive ? '重试中（后台自动）' : '待重试') + '</div>';
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
    }
    function hideTip() {
        var tip = getTip();
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
        var items = [];
        // Primary action for a still-pending card: re-arm THE flap loop now
        // instead of waiting for the next page reload. Only shown while _pending.
        if (av && real._pending) items.push({
            key: 'retry', label: '立即重试',
            onClick: function () { kickManualRetry(av); }
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
        if (av && !real._pending) items.push({
            // Label kept short to avoid wrapping inside bilibili's
            // fixed-width card-menu popper. "清除本条缓存并重新抓取" (11
            // chars) wrapped to two lines and the second line overflowed
            // the popper bounds — see git log around this label change.
            key: 'clear-cache', label: '清缓存并重抓',
            successMsg: '缓存已清除，重新抓取中',
            onClick: function () {
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
    //   of the card looking inert. Two states:
    //     active=true  → spinning dot + "重试中" (loop alive — owns the retry,
    //                    keeps sampling android on its backoff)
    //     active=false → static gray + "待重试" (loop gave up; a fresh reload
    //                    re-kicks it, OR the card's "立即重试" menu item does so
    //                    on demand via kickManualRetry)
    //   The badge is just the at-a-glance cue; the FULL explanation of what
    //   重试中/待重试 mean lives in the card's hover tooltip (buildTipHtml's
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
            '.fav-fix-retry-badge.waiting .fav-fix-retry-dot { animation:none; border-top-color:rgba(255,255,255,.55); }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    function markPending(hit, active) {
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
        badge.classList.toggle('waiting', !active);
        var t = badge.querySelector('[data-fav-fix-retry-txt]');
        if (t) t.textContent = active ? '重试中' : '待重试';
    }

    function clearPending(hit) {
        if (!hit) return;
        var scopes = [];
        if (hit.img && hit.img.parentElement) scopes.push(hit.img.parentElement);
        if (hit.container) scopes.push(hit.container);
        for (var s = 0; s < scopes.length; s++) {
            var b = scopes[s].querySelectorAll('[data-fav-fix-retry]');
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
        _flapLeftoverMid = null;
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
            // it). Clear the first-pass loading overlay so the two don't stack.
            clearLoading(hit);
            markPending(hit, _flapBgRunning);
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
                patchCover(img, real.cover);
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
            log(hits.length, 'invalid items on page, but no access_key — skip');
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

    // ─── Menu commands ──────────────────────────────────────────────────

    try {
        GM_registerMenuCommand('fav-fix：登录（TV 端二维码）', tvLogin);
        GM_registerMenuCommand('fav-fix：登录（手动输入凭据）', manualLogin);
        GM_registerMenuCommand('fav-fix：注销（清除登录凭据）', function () { clearAuth(); toast('登录凭据已清除', 'ok'); });
        GM_registerMenuCommand('fav-fix：开关调试日志', function () {
            DEBUG = !DEBUG; GM_setValue('debug', DEBUG);
            toast('调试日志：' + (DEBUG ? '已开启' : '已关闭'), 'ok');
        });
        GM_registerMenuCommand('fav-fix：立即重新扫描并修复', function () { pageCache.clear(); pageItems.clear(); schedule(); });
        GM_registerMenuCommand('fav-fix：扫描静默丢弃的条目', function () {
            var mid = detectMediaId();
            if (!mid) { toast('无法识别当前收藏夹 ID', 'err'); return; }
            // Reset all three caches so a manual re-scan re-fetches both
            // ids endpoint AND walks phase 1 again (fresh state).
            _idsListCache.delete(mid);
            _phase1AvsCache.delete(mid);
            _missingBannerShown.delete(mid);
            detectMissingAndRender(mid);
        });
        GM_registerMenuCommand('fav-fix：清除所有缓存并刷新页面', function () {
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
        });
        GM_registerMenuCommand('fav-fix：查看登录状态', function () {
            var a = getAuth();
            var age = a.ts ? Math.floor((Date.now() - a.ts) / 86400000) : null;
            var msg = '登录模式：' + (a.mode || '未登录')
                    + '　凭据：' + (a.access_key ? '已保存' : '未保存')
                    + '　已保存：' + (age == null ? '未知' : age + ' 天前');
            toast(msg);
        });
    } catch (e) { warn('menu register failed', e); }

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
                '__biliFavFix.clearAllItemCache()  nuke all per-item GM storage',
                '__biliFavFix.clearAuth()          drop access_key',
                '__biliFavFix.bvToAv(bv) / avToBv(av)'
            ].join('\n'));
        }
    };

    console.info('[fav-fix] core ' + CORE_VERSION + ' ready · type __biliFavFix.help() for commands');
})();
