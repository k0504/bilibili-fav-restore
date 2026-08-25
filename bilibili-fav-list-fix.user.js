// ==UserScript==
// @name         Bilibili 收藏夹失效视频信息还原 (bootstrap)
// @name:zh-TW   Bilibili 收藏夾失效影片資訊還原 (bootstrap)
// @name:en      Bilibili Fav List Fix (bootstrap)
// @namespace    https://github.com/SocialSisterYi/bilibili-API-collect
// @version      1.0.0
// @description  开发用 bootstrap — 以 @require 直接载入磁盘上的构建产物，无需任何本地服务。`@version 1.0.0` 永久锁定，除非 bootstrap 协议本身变更，否则不要 bump。
// @description:zh-TW  開發用 bootstrap — 以 @require 直接載入磁碟上的建置產物，無需任何本機服務。`@version 1.0.0` 永久鎖定，除非 bootstrap 協定本身變更，否則不要 bump。
// @description:en  Dev bootstrap — @requires the built script straight off disk; no local server. `@version 1.0.0` is permanent; never bump unless the bootstrap protocol itself changes.
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
// @connect      api.bilibili.com
// @connect      passport.bilibili.com
// @connect      hdslb.com
// @connect      biliplus.com
// @connect      jijidown.com
// @require      file:///C:/project/bilibili-fav-list-fix/dist/bilibili-fav-restore.user.js
// @license      MIT
// ==/UserScript==

/*
 * Development stub. Runs the working copy on disk rather than the snapshot the
 * userscript manager holds, so the cycle is: edit a module under src/, run
 * `python build.py`, reload the bilibili tab.
 *
 * ── Why there is a stub at all ──
 * Installed ONCE at version 1.0.0 and never bumped: bumping forces the user to
 * re-confirm the install. All change happens in the required file, which the
 * manager re-reads on every page load.
 *
 * The require names the BUILT script at dist/, not a part under src/: the parts
 * are concatenated into one closure (see bundle.py) and cannot be loaded
 * separately. That is also why `python build.py` is now part of the loop —
 * under the previous serve.py bootstrap the assembly happened per request.
 *
 * ── Prerequisites, on chrome://extensions under Tampermonkey's details ──
 *   - "Allow access to file URLs" must be ON
 *   - Site access set to "On all sites"; a narrower setting fails file:// reads
 *
 * ── The path below is this machine's ──
 * Anyone else working on the script edits that one line; nothing else here is
 * local. A require naming a missing file loads NOTHING and reports NOTHING:
 * the stub still runs, the manager still lists it as active, and the page looks
 * exactly as though no userscript were installed. Check the path first when the
 * script appears not to run at all.
 *
 * ── The required file's own metadata block is inert ──
 * dist/bilibili-fav-restore.user.js carries a full ==UserScript== header. When
 * pulled in through @require it is just a comment: THIS stub's @grant list is
 * what the code actually runs with, so the two lists have to agree. build.py
 * parses @match / @grant / @connect out of this file precisely so they cannot
 * drift (see lint_grants there, which fails the build on a missing grant).
 *
 * ── Disable the released script while this one is installed ──
 * Otherwise both run. The core's __biliFavFixLoaded guard stops the second copy
 * from doing anything, but which copy wins is then a race.
 *
 * ── Known failure mode ──
 * Userscript managers do not guarantee re-reading a file:// require on every
 * page load; a stale copy has been observed on this workflow's sibling project.
 * The version is printed at boot ("core X.Y.Z ready" in the console) and shown
 * in the FAB menu header — check it before concluding that an edit did not take
 * effect. serve.py is kept in the repository as a fallback: it cache-busts in
 * three layers and is deterministic about serving the current bytes.
 */

/*
 * Nothing below. The @require above IS the payload: it is fetched and executed
 * before this file's own body, so an empty body is the whole design. Do not add
 * loader logic here — that was the previous (HTTP) bootstrap, and having both
 * would run the core twice.
 */
