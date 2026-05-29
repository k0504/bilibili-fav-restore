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
    var CORE_VERSION = '0.8.12';

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
                    if (opts.raw) {
                        // Raw mode: caller wants the response body verbatim
                        // (HTML scraping / non-JSON sources like xbeibeix).
                        // Also surface the final URL so callers can detect
                        // server-side redirects (e.g. xbeibeix bouncing back
                        // to its landing page when an av isn't archived).
                        resolve({ status: resp.status, body: resp.responseText, finalUrl: resp.finalUrl || url });
                        return;
                    }
                    try { resolve(JSON.parse(resp.responseText)); }
                    catch (e) { reject(new Error('JSON parse failed: ' + e.message + ' body=' + resp.responseText.slice(0, 200))); }
                },
                onerror: function () { reject(new Error('network error: ' + url)); },
                ontimeout: function () { reject(new Error('timeout: ' + url)); }
            });
        });
        // Pad client-side guard by 500ms so the underlying GM timer wins
        // for legitimate timeouts (cleaner error message), and we only
        // catch the pathological stall case.
        return Promise.race([
            underlying,
            new Promise(function (_, rej) {
                setTimeout(function () {
                    rej(new Error('client-side timeout (' + timeoutMs + 'ms+500): ' + url));
                }, timeoutMs + 500);
            })
        ]);
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
    // Short TTL for degenerate merges (no cover + no title from any source).
    // Android API has walk-to-walk variability — same av sometimes appears
    // on a page, sometimes doesn't. A 30-day lock-in turns one bad walk
    // into a permanent failure; 10 min lets the next patchOnce retry.
    var CACHE_TTL_DEGENERATE_MS = 1000 * 60 * 10;   // 10 min

    function loadCache(av) {
        var v = GM_getValue(CACHE_PREFIX + av, null);
        if (!v) return null;
        if (v._cache_version !== CACHE_VERSION) {
            log('cache av', av, 'version', v._cache_version, '!=', CACHE_VERSION, '— invalidating');
            return null;
        }
        var ttl = v._degenerate ? CACHE_TTL_DEGENERATE_MS : CACHE_TTL_MS;
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

        // ─── Phase 1.5: Android flap retry ─────────────────────────────
        // Bilibili's android API is empirically non-deterministic: ~5% of
        // avs flap in/out across consecutive walks (same access_key, same
        // mediaId, seconds apart). Confirmed by 3-walk diagnostic on
        // mediaId=1687751814: walks returned 888 / 879 / 887 avs from a
        // claimed total of 923, with 44 avs (5%) appearing in some walks
        // but not others. Flapping correlates strongly with deactivated
        // accounts (7.6x over-represented) and short legacy aids — bilibili
        // is doing eventually-consistent server-side filtering for items
        // in a boundary state (account suspended / under review / etc).
        //
        // Detection: av must satisfy ALL THREE
        //   1. android missing in pageItems (flap symptom)
        //   2. public present (confirms the av exists; avoids retrying truly
        //      missing items where retry won't help)
        //   3. public's data is degenerate — both cover AND title fail
        //      QUALITY. This is the crucial guard: VALID videos can also
        //      flap (android drops them), but their public entry has real
        //      cover/title so the merge is fine without android. Only the
        //      INVALID-and-android-flapped case actually benefits from
        //      retry, and that's exactly the set this filter selects.
        //
        // Without guard #3, every page with healthy-but-android-missing
        // items triggers a wasteful full android walk (~5-8s) and freezes
        // all loading spinners for the entire patch cycle. With it, normal
        // browsing pays 0 cost; only patches with actual degenerate-
        // candidates incur the retry.
        //
        // Cost (with guard #3): one extra full android walk (~5-8s) ONLY
        // when there are real degenerate candidates. Early-exits as soon
        // as all candidates are recovered (typically pn=1-3).
        var flapCandidates = (SOURCES.android.enabled())
            ? todoAvs.filter(function (av) {
                if (pageItems.has('android|' + av)) return false;
                var p = pageItems.get('public|' + av);
                if (!p) return false;
                // Public has the av — would the merge be degenerate WITHOUT
                // android? If public alone has good cover OR good title,
                // merge is fine, no retry needed.
                var pubCoverOk = QUALITY.cover(p.cover) >= 5;
                var pubTitleOk = QUALITY.title(p.title) >= 10;
                return !pubCoverOk && !pubTitleOk;
            })
            : [];
        if (flapCandidates.length) {
            log('android flap retry for', flapCandidates.length, 'av(s):',
                flapCandidates.slice(0, 5).join(',') + (flapCandidates.length > 5 ? ',…' : ''));
            // Wipe android page cache so ensurePage re-issues network calls
            // instead of returning the cached page Promises from phase 1.
            // Only touch THIS mediaId's keys; other media's caches are
            // untouched (unlikely to matter — only one favlist per page —
            // but safer).
            var pcKeys = [];
            pageCache.forEach(function (_, k) { pcKeys.push(k); });
            for (var ki = 0; ki < pcKeys.length; ki++) {
                if (pcKeys[ki].indexOf('android|' + mediaId + '|') === 0) {
                    pageCache.delete(pcKeys[ki]);
                }
            }
            var pn = 1, MAX_PN = MAX_PAGE_WALK;
            while (pn <= MAX_PN) {
                var allFound = flapCandidates.every(function (av) { return pageItems.has('android|' + av); });
                if (allFound) { log('android flap retry: all candidates recovered at pn=' + pn); break; }
                var page;
                try { page = await ensurePage('android', mediaId, pn); }
                catch (e) { warn('android flap retry pn ' + pn + ' failed:', e.message); break; }
                if (!page.has_more) break;
                pn++;
            }
            // Log final outcome for visibility.
            var stillMissing = flapCandidates.filter(function (av) { return !pageItems.has('android|' + av); });
            if (stillMissing.length) {
                log('android flap retry: ' + (flapCandidates.length - stillMissing.length) + '/' + flapCandidates.length
                    + ' recovered;', stillMissing.length, 'still missing (likely permanent filter, falling through to 3rd-party)');
            } else {
                log('android flap retry: ' + flapCandidates.length + '/' + flapCandidates.length + ' recovered');
            }
        }

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
        todoAvs.forEach(function (av) {
            var perSource = {};
            for (var s2 = 0; s2 < srcOrder.length; s2++) {
                var item = pageItems.get(srcOrder[s2] + '|' + av);
                if (item) perSource[srcOrder[s2]] = item;
            }
            if (Object.keys(perSource).length === 0) {
                // None of the 4 sources have this av. Still emit a stub
                // merged record + persist it, so:
                //   - patchOnce sees an entry and runs markPatched (lets
                //     the user see "we tried" rather than "did nothing").
                //   - markPatched can render the unrecoverable styling
                //     based on `_no_source` flag.
                //   - the GM cache short-circuits the next page reload
                //     instead of re-walking 4 dead sources.
                var attemptedStub = attemptedPerAv.get(av);
                var stub = {
                    oid: Number(av),
                    _no_source: true,
                    // _attempted: union of every source that queried this av
                    // (phase 1 paginated + phase 2 per-av). Tooltip "已查询
                    // 但无记录" reads this. Old cache entries used the
                    // narrower _attempted_3rd field; tooltip falls back.
                    _attempted: attemptedStub ? Array.from(attemptedStub) : [],
                    _tried_sources: srcOrder.slice()
                };
                log('av', av, 'NOT FOUND in any source — caching stub');
                saveCache(av, stub);
                result.set(av, stub);
                return;
            }
            var merged = mergeBySource(perSource);
            var attempted = attemptedPerAv.get(av);
            if (attempted) merged._attempted = Array.from(attempted);
            log('av', av, 'merged from {' + Object.keys(perSource).join(',') + '}',
                attempted ? '(attempted: ' + Array.from(attempted).join(',') + ')' : '',
                '→', 'cover=' + (merged._src_cover || '·'),
                'title=' + (merged._src_title || '·'),
                'upper=' + (merged._src_upper || '·'),
                'cnt=' + (merged._src_cnt_info || '·'),
                'dates=' + (merged._src_pubtime || merged._src_fav_time || '·'));
            saveCache(av, merged);
            result.set(av, merged);
        });
        return result;
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
            // Walk up looking for a container that has a link to /video/avXXX or /video/BVXXX,
            // bounded at <body>.
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
        var titleHits = [];
        var allText = document.querySelectorAll('p, span, div, a');
        for (var i = 0; i < allText.length; i++) {
            var el = allText[i];
            if (el.children.length === 0 && el.textContent.trim() === INVALID_TITLE) {
                var n = el;
                while (n && n !== document.body) {
                    var link = n.querySelector && n.querySelector('a[href*="/video/"]');
                    if (link) { titleHits.push({ container: n, img: n.querySelector('img'), link: link, titleEl: el }); break; }
                    n = n.parentElement;
                }
            }
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

    function patchTitle(container, realTitle) {
        if (!container || !realTitle) return;
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() === INVALID_TITLE) {
                node.nodeValue = node.nodeValue.replace(INVALID_TITLE, realTitle);
            }
        }
        // Also patch title attributes (tooltip).
        container.querySelectorAll('[title="' + INVALID_TITLE + '"]').forEach(function (el) {
            el.setAttribute('title', realTitle);
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
        var bv = real.bvid || (av ? avToBv(av) : null);
        var items = [];
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
        if (av) items.push({
            // Label kept short to avoid wrapping inside bilibili's
            // fixed-width card-menu popper. "清除本条缓存并重新抓取" (11
            // chars) wrapped to two lines and the second line overflowed
            // the popper bounds — see git log around this label change.
            key: 'clear-cache', label: '清缓存并重抓',
            successMsg: '缓存已清除，重新抓取中',
            onClick: function () {
                // Cache nuke: GM, in-memory raw rows, paginated promises.
                clearItemCache(av);
                Object.keys(SOURCES).forEach(function (src) {
                    pageItems.delete(src + '|' + av);
                });
                // pageCache holds Promise<page>; must be flushed so the next
                // patchOnce actually re-fetches Android pages (otherwise the
                // resolved promise's items list is reused — and that list is
                // exactly the one that already dropped this av).
                pageCache.clear();

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
        var existingKeys = new Set(
            Array.from(popper.querySelectorAll('[data-fav-fix-key]'))
                 .map(function (el) { return el.getAttribute('data-fav-fix-key'); })
        );
        items.forEach(function (it) {
            if (existingKeys.has(it.key)) return;
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

    // ─── Mark a patched item ────────────────────────────────────────────
    //   - solid red outline (4px) on the cover img — uses CSS outline so
    //     it doesn't reflow layout; outline-offset:-4px tucks it inside
    //     the rounded-corner clip so it doesn't bleed past corners
    //   - rich hover tooltip showing title / UP / stats / dates / intro
    //   - data-fav-fix-marked guard avoids double-binding on observer re-runs

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
        // Bind tooltip handlers to the whole container so hovering anywhere
        // on the card triggers them. Read latest data from `__favFixReal`
        // inside the handler so cache refreshes propagate without re-binding.
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
        // 在 biliplus 打开、清缓存). Safe to call repeatedly; dedup via
        // data-fav-fix-key on the menu items themselves.
        try { injectCardMenu(hit, real); }
        catch (e) { warn('injectCardMenu threw:', e); }
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
    // has_more=false. This is the "what did bilibili actually return for
    // the whole collection" set. CANNOT use pageItems for this — patchOnce
    // stops phase 1 the moment all current-page invalid hits are covered,
    // so pageItems is a partial subset biased toward invalid items. Using
    // it would massively over-count "missing" on collections where the
    // current DOM page has few or no invalid cards. (Was the 0.8.0 bug:
    // a 99-item clean collection reported "static 99 项" because pageItems
    // was empty.)
    //
    // Cached per mediaId so a tab that lingers doesn't re-walk on every
    // observer tick. ensurePage adds its own request-level dedup.
    // Returns { avs:Set<avStr>, complete:bool }. `complete` is true ONLY when
    // the walk reached a natural has_more=false end (i.e. it saw the whole
    // collection). It is false when the walk stopped early — a page error or
    // the MAX_PAGE_WALK cap. Callers MUST NOT compute a "missing" diff against
    // an incomplete walk: the unwalked tail would be falsely flagged as
    // silently-dropped (the >600-item false-positive this `complete` flag
    // exists to prevent).
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
        var complete = false;
        for (var pn = 1; pn <= MAX_PAGE_WALK; pn++) {
            var page;
            try { page = await ensurePage(srcName, mediaId, pn); }
            catch (e) {
                warn('fetchFullPhase1Avs:', srcName, 'page', pn, 'failed:', e.message);
                break;   // complete stays false — partial walk
            }
            (page.list || []).forEach(function (it) {
                if (it.oid != null) collected.add(String(it.oid));
            });
            if (!page.has_more) { complete = true; break; }
        }
        var result = { avs: collected, complete: complete };
        _phase1AvsCache.set(mediaId, result);
        log('fetchFullPhase1Avs: ' + srcName + ' walked → '
            + collected.size + ' items collected (complete=' + complete + ')');
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
            var av = String(m.id);
            var bv = m.bvid || '';
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
            markPatched(hit, real);
            return 'unrecoverable';
        }
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
    // still awaiting. Concurrent runs share pageCache/pageItems and the flap-
    // retry path even deletes android page-cache keys mid-walk, so they can
    // clobber each other. Serialize here: if a run is in flight, mark dirty
    // and let the current run loop once more when it finishes (so the trigger
    // that arrived mid-run — e.g. a clear-cache that just nuked the cache —
    // is never dropped).
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
                // New folder → flush in-memory page cache. Per-avid GM
                // storage cache is intentionally NOT cleared (re-hits will
                // use stored data — clear from menu if needed).
                pageCache.clear(); pageItems.clear();
                // Also drop missing-detection caches so the new folder
                // gets its own scan (banner state is per-mediaId), and
                // tear down any banner the previous folder painted.
                _idsListCache.clear();
                _phase1AvsCache.clear();
                _missingBannerShown.clear();
                // Drop in-flight scan dedup too: a scan that was walking the
                // OLD folder must not be reused for the new mediaId. (The
                // render-time detectMediaId() guard already stops a stale
                // scan from painting; clearing here also lets the new folder
                // start its own scan immediately rather than awaiting the old.)
                _missingInFlight.clear();
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
        GM_registerMenuCommand('fav-fix：清除所有条目缓存', function () {
            var n = clearAllItemCache();
            if (n < 0) toast('GM_listValues 权限缺失，无法批量清除', 'err');
            else toast('已清除 ' + n + ' 项条目缓存', 'ok');
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
            // bilibili's modern fav UI uses .bili-video-card; older layouts
            // use other names. Multi-selector covers both.
            var cardCount = document.querySelectorAll('.bili-video-card, .fav-video-card, .small-item').length;
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
        patchNow: function () { pageCache.clear(); pageItems.clear(); return patchOnce(); },
        // forceRefetch(avOrBv) — drop cache for one av and re-run patch
        forceRefetch: function (avOrBv) {
            var av = String(avOrBv);
            if (/^BV/i.test(av)) av = bvToAv(av);
            clearItemCache(av);
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
