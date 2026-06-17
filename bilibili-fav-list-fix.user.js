// ==UserScript==
// @name         Bilibili 收藏夹失效视频信息还原 (bootstrap)
// @name:zh-TW   Bilibili 收藏夾失效影片資訊還原 (bootstrap)
// @name:en      Bilibili Fav List Fix (bootstrap)
// @namespace    https://github.com/SocialSisterYi/bilibili-API-collect
// @version      1.0.0
// @description  开发用 bootstrap — 从本地 HTTP 服务拉取最新核心代码并执行。`@version 1.0.0` 永久锁定，除非 bootstrap 协议本身变更，否则不要 bump（一旦 bump 使用者要重新确认安装）。
// @description:zh-TW  開發用 bootstrap — 從本機 HTTP 服務拉取最新核心代碼並執行。`@version 1.0.0` 永久鎖定，除非 bootstrap 協議本身變更，否則不要 bump（一旦 bump 使用者要重新確認安裝）。
// @description:en  Dev bootstrap — fetches latest core logic from local server and runs it. `@version 1.0.0` is permanent; never bump unless the bootstrap protocol itself changes.
// @author       you
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
// @connect      127.0.0.1
// @connect      localhost
// @connect      api.bilibili.com
// @connect      passport.bilibili.com
// @connect      hdslb.com
// @connect      biliplus.com
// @connect      jijidown.com
// @license      MIT
// ==/UserScript==

/*
 * Two-layer architecture (same idea as dl-manager):
 *
 *   1. THIS FILE — installed in Tampermonkey ONCE, version 1.0.0.
 *      Only job: fetch the core JS from the local server and eval it.
 *      NEVER bump @version — bumping forces the user to re-confirm install.
 *
 *   2. The core (served at /bilibili-fav-list-fix-core.js) — all the real
 *      logic, assembled from src/*.js by serve.py (see bundle.py). Edit any
 *      src/ module; reload the bilibili tab to pick up changes. No
 *      Tampermonkey re-touch needed.
 *
 * Why: TM rejects http://127.0.0.1 as @updateURL (insecure-origin policy),
 * so an auto-updating userscript pointing at the local server is impossible.
 * Solution: pin the stub at v1.0.0 forever, do all updates server-side.
 *
 * CSP: bilibili.com allows 'unsafe-eval' (verified — eval('1+1') on
 * space.bilibili.com works), so the core runs in the userscript ISOLATED
 * world via eval() and inherits GM_xmlhttpRequest / GM_getValue / etc.
 *
 * Trade-off: server down ⇒ userscript inert until it returns. Acceptable —
 * the fix only adds metadata; the page still works without it.
 */

(function () {
    'use strict';

    var SERVER_BASE = 'http://127.0.0.1:8766';
    var CORE_PATH = '/bilibili-fav-list-fix-core.js';

    function showError(msg) {
        try {
            var paint = function () {
                var el = document.createElement('div');
                el.textContent = 'fav-fix: ' + msg;
                el.style.cssText = [
                    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
                    'padding:6px 10px', 'border-radius:14px',
                    'font:600 12px/1.2 -apple-system,Segoe UI,sans-serif',
                    'color:#fff', 'background:#c0392b',
                    'box-shadow:0 2px 6px rgba(0,0,0,.25)',
                    'pointer-events:none', 'user-select:none'
                ].join(';');
                document.body.appendChild(el);
                setTimeout(function () { el.remove(); }, 8000);
            };
            if (document.body) paint();
            else document.addEventListener('DOMContentLoaded', paint, { once: true });
        } catch (e) { /* ignore */ }
    }

    try {
        GM_xmlhttpRequest({
            method: 'GET',
            url: SERVER_BASE + CORE_PATH + '?t=' + Date.now(),
            timeout: 5000,
            headers: { 'Cache-Control': 'no-cache' },
            onload: function (resp) {
                if (resp.status < 200 || resp.status >= 300) {
                    console.warn('[fav-fix/bootstrap] core fetch HTTP', resp.status);
                    showError('core HTTP ' + resp.status);
                    return;
                }
                try {
                    // eval keeps the core in the userscript ISOLATED world so
                    // it inherits GM_xmlhttpRequest / GM_getValue / etc.
                    eval(resp.responseText);
                    console.log('[fav-fix/bootstrap] core loaded ('
                                + resp.responseText.length + ' bytes)');
                } catch (e) {
                    console.error('[fav-fix/bootstrap] core eval failed', e);
                    showError('core eval failed: ' + e.message);
                }
            },
            onerror: function () {
                console.warn('[fav-fix/bootstrap] server unreachable at', SERVER_BASE);
                showError('server offline — run `python serve.py`');
            },
            ontimeout: function () {
                console.warn('[fav-fix/bootstrap] core fetch timeout');
                showError('core fetch timeout');
            }
        });
    } catch (e) {
        console.error('[fav-fix/bootstrap] GM_xmlhttpRequest threw', e);
        showError('bootstrap error');
    }
})();
