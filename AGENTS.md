# bilibili-fav-list-fix Agent 導航

> 本層為 repo root，無上一層。
> 下一層：尚無 per-file 文件（`bilibili-fav-list-fix-core.js` 達 1000 行後可考慮拆出 per-file）

Tampermonkey 雙層 userscript：在 B 站網頁版收藏夾頁面把失效視頻的原始封面 / 標題 / metadata 補回 DOM。**核心發現**：API `/x/v3/fav/folder/resources` 在 Android 主版 appkey 簽名 + 帶齊 4 個客戶端 hint 時，會保留失效條目的快照；網頁版接口只回占位。

---

## 核心觀念

- **bootstrap 永不 bump `@version`** —— 1.0.0 是契約，bump 一次使用者要重新確認安裝。所有變動都該發生在 core，由 server 直送
- **core 跑在 isolated world**，靠 bootstrap 的 `eval(resp.responseText)` 載入；依賴 bilibili.com CSP 允許 `unsafe-eval`
- **失效條目能不能拿到原始 metadata，取決於 4 個 hint** (`mobi_app/platform/build/statistics`) 是否齊全 —— bisect 過，少一個 server 就過濾掉
- **資料來源是 plug-in，分 paginated / per-av 兩類**：`SOURCES` registry + `FIELD_PRIORITY` + `QUALITY` 三件套。paginated source（android、public）走 `fetchPage({mediaId,pn})`；per-av source（biliplus、jijidown）走 `fetchAvs(avs)`，**只對 paginated 救不到（cover+title 任一不及格）的 av 才打**
- **MutationObserver 會反覆觸發** patch / mark / 選單注入；所有 DOM 改動必須 idempotent，用 `data-fav-fix-*` 屬性或 `__favFix*` 旗標 dedup

---

## 入口檔

| 檔 | 職責 | per-file doc? |
|----|------|---------------|
| `bilibili-fav-list-fix.user.js` | **dev bootstrap**，TM 安裝目標。fetch core + eval。`@version` 鎖 1.0.0 | |
| `bilibili-fav-list-fix-core.js` | 主邏輯：sources / resolver / cache / DOM patch / 選單注入 / TV QR login / missing banner | |
| `serve.py` | 本機 :8765 HTTP server，no-cache header（給 bootstrap 用） | |
| `build.py` | 把 core 打包成 `dist/bilibili-fav-restore.user.js`（end-user 單檔版） | |
| `dist/bilibili-fav-restore.user.js` | **end-user 發布物**。GitHub raw URL 對外，TM auto-update。Greasy Fork mirror 從同一 raw URL sync | |
| `README.md` | 給人類的安裝與開發流程 | |
| `LICENSE` | MIT | |

**兩條安裝路徑同時存在**：
- end user → 兩個 mirror 任選：
  - GitHub raw: `dist/bilibili-fav-restore.user.js`（即時，每次 `git push` 立即可裝）
  - [Greasy Fork mirror](https://greasyfork.org/zh-TW/scripts/578965-bilibili-收藏夹失效视频还原)（從 GH raw URL sync，~24h 延遲）
- contributor → `bilibili-fav-list-fix.user.js`（bootstrap）+ `serve.py`（改 core 不用重裝 TM）

兩者 share 同一份 `bilibili-fav-list-fix-core.js`。改 core → 跑 `python build.py` → commit dist/ → push（GF 自動 sync，無需另發）。

---

## 跨檔陷阱

1. **port `8765` 寫死兩處** (`serve.py:27` 的 `DEFAULT_PORT` ＋ `bilibili-fav-list-fix.user.js:55` 的 `SERVER_BASE`) —— 改一邊不改另一邊，瀏覽器開的 install URL 與 bootstrap fetch 的 URL 不一致，core 永遠載不到。改了務必順手把 `README.md` 的指令也改掉

2. **bootstrap `@grant` 是 core 的權限白名單** —— core 呼叫的每個 `GM_*` API（`GM_setClipboard / GM_openInTab / GM_listValues / GM_setValue / ...`）都要列在 bootstrap header `@grant` 行。漏一個的話 TM 把該函式設為 `undefined`，呼叫時 `ReferenceError`。**改 core 引入新 `GM_*` 用法時，bootstrap `@grant` 必須同 commit 補上**，使用者下次 reload 會被 TM 跳「新增權限」對話框

3. **cache-bust 是三層** —— bootstrap append `?t=Date.now()` query (`.user.js:82`) ＋ 帶 `Cache-Control: no-cache` request header (`.user.js:84`) ＋ `serve.py` 回 `Cache-Control: no-store, no-cache, must-revalidate` response header (`serve.py:39`)。三層任一失守，TM 或瀏覽器或代理會 cache 住舊 core，使用者 F5 看不到改動

4. **`Content-Type` 必須是 `application/javascript`** (`serve.py` `guess_type` override) —— Python `http.server` 預設靠 mime db 把 `.js` mapped 到 `text/javascript`，某些 TM 版本只認 `application/javascript` 才觸發 userscript install/update 流程。type 不對 → 瀏覽器直接顯示文字、TM 不跳安裝、`tampermonkey.net/script_installation.php?url=` 那條 install URL 也不 redirect。對照 dl-manager `backend/app/main.py:308-312` 顯式 `media_type='application/javascript'`。**改 server 時動到 mime 處理必須測 `curl -I` 確認**

5. **server 必須 multi-threaded + HTTP/1.1 keep-alive，否則 install URL「卡很久才彈窗」** —— TM 的 install detection 對 `tampermonkey.net/script_installation.php` intermediate page 會 fire 多個 round-trip 來探 metadata / content / 觸發 dialog。`serve.py` 用 `ThreadingTCPServer`（不是 default `TCPServer`，否則 single-threaded 序列化所有 request）＋ **不能** `Connection: close`（強制 close 害每 round-trip 全做 TCP handshake）。`BaseHTTPRequestHandler.handle()` 在 HTTP/1.1 下本來就有 keep-alive loop，留它工作即可。症狀：「URL 終究會 redirect 但等 ~30 秒」就是踩到這個。修法見 `serve.py` `ThreadedHTTPServer` class

6. **`eval()` 依賴 `unsafe-eval`** (`bilibili-fav-list-fix.user.js:94`) —— bilibili.com 目前允許（實測 `eval('1+1')` 過），未來若 B 站加 strict CSP `script-src` 整支爆炸，console 會見 `EvalError`。屆時要改 blob-URL `<script>` 注入 + page-world 執行，可參 [`C:\project\dl-manager\userscripts\instagram\instagram.user.js`](C:\project\dl-manager\userscripts\instagram\instagram.user.js)

7. **新舊 UI 雙 selector** —— `.bili-card-dropdown` / `.bili-card-dropdown-popper.visible`（新）vs `.be-dropdown-menu`（舊）。`injectCardMenu()` 已分支處理，但 `findInvalidContainers()` 也走 DOM 掃描，未來改 patch 邏輯時兩 UI 都要 hold。placeholder 偵測用 `be27fd62` token 跨 UI 通用，這個比 selector 穩

8. **`access_key` 是 appkey-bound** —— TV QR login (appkey `4409e2ce8ffd12b8`) 拿到的 token 不能用 `1d8b6e7d45233436` 簽。`getAuth().mode` (`'tv'` / `'android'`) 與 `appkeyFor()/appsecFor()` 必須一致。失效視頻是否回 `is_invalid` 也可能因簽名 appkey 不同而異 —— TV 模式若 silently 拿不到原 cover，切 manual 模式塞 Android-app access_key

9. **`CORE_VERSION` 是 end-user auto-update 的開關** —— `dist/bilibili-fav-restore.user.js` 的 `@version` 由 `build.py` 從 `core.js:38` 的 `CORE_VERSION` 抓出。TM 只有看到 `@version` 變大才會觸發 auto-update —— **改 core 後沒 bump `CORE_VERSION` 就跑 build，end user 永遠停在舊版**。bootstrap (`bilibili-fav-list-fix.user.js`) 的 `@version 1.0.0` 是另一回事，那條鎖死永遠不能動（陷阱：兩個 version 概念別搞混）。發版 checklist：bump `CORE_VERSION` → `python build.py` → `git add core.js dist/` → commit

10. **`dist/` 必須入庫** —— `.gitignore` 不要排除 `dist/`，GitHub raw URL 才有東西可服。改 core 後忘了重 build / commit dist，end user 自動更新拿到的還是舊版。`build.py` 不會自動跑 —— 沒 hook，純手動

11. **`build.py` header 與 bootstrap header 是兩份手寫副本** —— `@grant` / `@connect` / `@match` 三條清單在兩處各有一份（`bilibili-fav-list-fix.user.js` header ＋ `build.py:build_header()`），沒程式化檢查。core 引入新 `GM_*` 用法或新 fetch 域名時，**兩份都要改**。`build.py` 的 `@connect` 比 bootstrap 少 `127.0.0.1` / `localhost` 兩條（end-user 不需 server fetch）—— 加新 connect 時記得這個差異

12. **Greasy Fork 是 GH raw 的 mirror，不是獨立 source** —— [GF script #578965](https://greasyfork.org/zh-TW/scripts/578965-bilibili-收藏夹失效视频还原) 設了 sync from [dist/ 的 GH raw URL](https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js)，push 後 GF 約 24h 自動拉新版（CORE_VERSION 增大才視為更新；README-only 改動 GF 不會 sync）。**GF 頁面的描述文字不會自動 sync** —— 要改得登入 GF 後台手動貼（描述源以本機 `GREASYFORK.md` 為準，該檔 gitignored 不入庫，避免與 GF 線上版漂移）。GF 用戶安裝後 `@updateURL` / `@downloadURL` 被 GF 改寫指向 GF 自己的 update URL —— 從 GF 裝就從 GF 更新；GH raw 裝的仍從 GH 更新。**核心結論**：dist/ 的內容是 sync 來源；GF 描述頁是手動同步；兩者改動觸發路徑完全不同

---

## 欲修改 X 應讀何處

| 目標 | 入口 |
|------|------|
| 加新 paginated 來源（B 站新接口） | `core.js` 找 `SOURCES = {`；定義 `{name, paginated:true, enabled, fetchPage({mediaId,pn})}`；在 `FIELD_PRIORITY` 把該 source 排進相關欄位優先級 |
| 加新 per-av 來源（xbeibeix / archive.org 等） | `core.js` 同上但 `paginated:false`，實作 `fetchAvs(avs)` 回 `Map<string,item>`；resolver phase 2 自動 gate 在「cover+title 任一不及格才打」（見 `hasGoodCoverAndTitle`）；rate-limit 自己內部 retry（biliplus 範式）；bootstrap `@connect` 加新域名 |
| 改 endpoint 簽名常數（appkey 輪換） | `core.js` 頂端 `TV_APPKEY/TV_APPSEC/AND_APPKEY/AND_APPSEC` 4 個常數 |
| 改失效偵測（B 站換占位圖 hash） | `core.js` `COVER_PLACEHOLDER_RE`（兩處使用：`QUALITY.cover` 與 `findInvalidContainers`） |
| 加 / 改 per-card 三點選單項 | `core.js` `buildMenuItems()` 改清單；`injectCardMenu()` 處理新舊 UI 注入點 |
| 改 hover tooltip 內容 | `core.js` `buildTipHtml()`（DOM 富文字）＋ `buildPlainInfo()`（clipboard 純文字）—— **兩者並存須一起改**，否則「複製完整信息」會跟 hover 看到的不一致 |
| 改 cache 結構 / TTL | `core.js` `CACHE_PREFIX / CACHE_VERSION / CACHE_TTL_MS / loadCache / saveCache`；批量清除 `clearAllItemCache` 用 `CACHE_PREFIX` 前綴掃 `GM_listValues`，前綴改名要連動 |
| 加新 source / 改 merge 語意 | **務必 bump `CACHE_VERSION`** —— 否則舊 cache 永遠不會觸發新 source（每個 entry 帶 `_cache_version` tag，version mismatch 才會重抓） |
| 加新 GM_* API 用法 | bootstrap `@grant` 行 ＋ **`build.py` `build_header()` 的 `@grant` 行**（陷阱 2 + 11）＋ core 呼叫處 |
| 加新 phase-2 source 的 fetch 域名 | bootstrap `@connect` ＋ **`build.py` `build_header()` 的 `@connect` 區**（陷阱 11） |
| 換伺服器 port | `serve.py` `DEFAULT_PORT` ＋ `bilibili-fav-list-fix.user.js` `SERVER_BASE` ＋ `README.md`（陷阱 1） |
| 發版給 end user | bump `core.js:38` `CORE_VERSION` → `python build.py` → `git add core.js dist/` → commit（陷阱 9 + 10） |
| 改 dist meta（GH user / repo / @name 等） | `build.py` 頂端常數 `GH_USER` / `GH_REPO` ＋ `build_header()` 字串 |
| 改 GF 頁面描述 / 安裝指引 | 本機 `GREASYFORK.md`（gitignored，source of truth）→ 手動貼進 GF 後台 script 描述欄（GF 不會 auto-sync 描述，只 sync source code）（陷阱 12） |
| GF sync URL / sync 觸發條件 | GF script 管理頁的 "Sync from external URL"（已設 GH raw），更新觸發看 `@version` 增加（陷阱 12） |
| TV QR login 流程 | `core.js` `tvAuthCode / tvPoll / tvLogin / showQrModal`；QR 渲染用 `api.qrserver.com`，要換 JS encoder 在 `showQrModal` 改 |
| 改 hits 偵測 / DOM 走訪 | `core.js` `findInvalidContainers()`；後續 patch 流程在 `patchOnce()` |
