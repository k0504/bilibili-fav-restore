# bilibili-fav-restore

在 bilibili 网页版收藏夹页面，自动还原失效（已删除 / UP 自删）视频的原始封面、标题与作者信息。

bilibili 网页版的收藏夹接口对失效条目仅返回固定占位封面与「已失效视频」文字。本脚本以 bilibili 自家 Android 客户端使用的接口（含正确签名）取回失效前的快照，并替换页面 DOM。对于服务端层面已被静默丢弃的条目，脚本会在页面顶端列出对应的 av 号及第三方归档站快照链接。

## 功能

- 还原失效条目的封面、标题、作者、播放数 / 弹幕数等元数据
- 为已还原的卡片添加视觉标记（标题加删除线、卡片灰化）
- 在收藏夹卡片的三点菜单中注入 `复制完整信息`、`清除本条缓存并重新抓取` 等操作
- 检测并展示 bilibili 服务端静默丢弃的条目，提供 biliplus、xbeibeix、jijidown 三个第三方归档站的快照链接
- 提供 TV 端二维码登录与手动粘贴 `access_key` 两种登录模式
- 元数据本地缓存（GM storage），减少对 bilibili API 的重复请求
- 手动备份当前收藏夹（元数据与封面图本体 → IndexedDB），条目失效后直接以本地数据还原，不依赖 bilibili 或第三方归档站是否仍保有该条目

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome、Edge、Firefox 均可）。
2. 选择以下任一入口，浏览器访问后 Tampermonkey 将弹出安装对话框：

   - **[从 Greasy Fork 安装](https://greasyfork.org/zh-TW/scripts/578965-bilibili-收藏夹失效视频还原)**（推荐）
   - **[从 GitHub Raw 安装](https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js)**

   两个入口分发同一份脚本。Greasy Fork 通过 sync 机制定期从 GitHub Raw URL 拉取新版本，延迟约 24 小时。

3. 安装完成后，Tampermonkey 会定期向所选入口检查更新，新版本将自动提示安装。

## 首次登录

1. 打开任意收藏夹页面，例如 `https://space.bilibili.com/{UID}/favlist?fid={收藏夹 ID}`。
2. 点击 Tampermonkey 扩展图标，选择 **fav-fix: Login (TV QR)**。
3. 使用 bilibili 手机客户端扫描页面上显示的二维码并确认登录。**仅 bilibili 官方客户端可用**，微信扫码或网页扫码无效。
4. 登录成功后 `access_key` 会写入 GM storage，有效期约 30 天。刷新页面后，失效条目应自动恢复。

如某些条目在 TV 模式下仍无法取回原始元数据，可在 Tampermonkey 菜单中选择 **fav-fix: Login (manual / paste access_key)**，粘贴一份由 Android 主端应用签发的 `access_key`（需自行通过 mitm 工具抓取）。

## 手动备份当前收藏夹

上述还原流程属于事后补救：条目失效之后，脚本才向 bilibili Android 端接口与第三方归档站索取残留快照，能否取回不由脚本决定。备份功能与之相反，用于在条目仍然有效时预先留存。

在收藏夹页面点击 Tampermonkey 扩展图标，选择 **fav-fix：备份当前收藏夹（封面+信息 → IndexedDB）**，脚本将逐页遍历当前收藏夹，把标题、简介、UP 主、分区、时长、投稿与收藏时间等元数据，以及封面图的图片本体，写入浏览器的 IndexedDB 数据库 `bili-fav-fix-backup`。执行过程中会以页为单位显示进度，结束时汇总新增、更新、跳过与封面下载失败的条目数。

该收藏夹中的条目日后失效时，备份将作为优先级最高的数据源参与还原流程：封面与元数据直接取自本地，不依赖 bilibili 或第三方归档站是否仍保有该条目。即使 bilibili CDN 已清除封面图文件，脚本也会改用备份中的图片本体填充卡片封面。

需要说明的是，在已登录的情况下，脚本首次处理某个收藏夹页面时仍会照常遍历收藏夹接口，以确定各条目的当前状态与跳转目标，备份并不取消该步骤。未配置 `access_key`（未登录或已执行注销）时，脚本不再发起任何还原相关的网络请求，仅以本地缓存与备份还原可覆盖的条目。

补充说明：

- 备份可重复执行。封面地址未发生变化的条目仅更新元数据，不会重复下载图片，因此对同一收藏夹再次备份的开销远低于首次。
- 重复备份不会覆盖已有的封面图片。若某条目在本次备份时已经失效，或其封面地址已变更而新地址下载失败，脚本将保留此前存入的图片本体，并在结果汇总中以「沿用旧封面」计数。
- 备份时已失效的条目，若此前曾被还原并写入缓存，将以该还原结果入库；否则计入「跳过失效」，不写入占位封面与「已失效视频」标题。
- 选择 **fav-fix：查看备份状态** 可查看已备份条目数、封面占用体积、浏览器存储用量，以及当前收藏夹最近一次完整备份的时间。若上一次执行中途失败，状态中会另行标注中止页码，此前完整备份的记录不会被覆盖。
- 任何清除缓存的操作均不会删除备份数据。删除备份需经由下述备份管理面板显式执行。

## 管理已有备份

在收藏夹页面点击 Tampermonkey 扩展图标，选择 **fav-fix：管理备份**，将在页面内打开备份管理面板，用于浏览与删除 IndexedDB 中已存的备份条目。

面板功能：

- 列表默认按收藏时间倒序排列（与收藏夹页面的「最近收藏」顺序一致），可通过排序下拉在收藏时间与备份时间的升降序之间切换；每页 20 条，逐条显示封面缩略图、标题、UP 主、收藏或备份日期（随排序依据切换）、封面体积，以及数据来源标签（「备份时有效」表示备份时条目仍然有效，「取自还原缓存」表示备份时条目已失效、内容取自此前的还原结果）。
- 顶部显示已备份条目总数、含封面条目数与封面占用体积。
- 工具栏提供关键词搜索（匹配标题、BV 号与 UP 主名称）与收藏夹过滤。过滤选项为各条目所属收藏夹的并集，以收藏夹名称显示并标注当前收藏夹；仅已执行过备份的收藏夹会出现在选项中。
- 工具栏的「备份当前收藏夹」按钮与 Tampermonkey 菜单中的同名命令等效，以页面当前所在的收藏夹为备份对象。欲备份尚未出现在过滤选项中的收藏夹，先在页面左侧切换至该收藏夹，再点击此按钮；备份完成后面板自动刷新，该收藏夹随即可供过滤。备份进行期间删除操作暂不可用，浏览不受影响。
- 单条删除需二次确认；「删除当前筛选结果」按当前搜索与过滤条件批量删除，筛选条件为「全部收藏夹」且搜索框为空时即为清空全部备份，确认提示会明确标示该情形。
- 删除操作不可撤销。删除某条目时，脚本会一并清除该条目由备份数据生成的还原缓存，避免删除后卡片仍以备份内容还原。

面板亦可在 DevTools Console 中以 `__biliFavFix.backup.manage()` 打开。关闭方式为右上角「关闭」按钮、点击面板外的遮罩区域或按 Esc 键。

## 已知限制

- 仅支持本人收藏夹或公开收藏夹。私密收藏夹受 API 鉴权限制无法读取。
- 脚本返回的「原始封面」托管于 bilibili CDN。若 bilibili 在服务端清除该资源文件，脚本无法恢复，此前已执行手动备份的条目除外。
- 每页 20 条，最多翻阅 50 页（约 1000 条）。如需调整，修改 `src/01-constants.js` 中的 `MAX_PAGE_WALK`。
- 若 API 返回 `-3` / `-101` / `-663`，通常表示 appkey 或 appsec 已被 bilibili 更新，需重新抓取并替换 `src/01-constants.js` 中的 appkey / appsec 常量。
- 第三方归档源（biliplus、xbeibeix、jijidown）的可用性与命中率不在脚本控制范围内。
- 备份数据库受浏览器同源策略约束，`space.bilibili.com` 与 `www.bilibili.com` 各自持有独立的一份。在其中一个域名下备份的数据，在另一个域名下无法读取，需分别备份。备份亦不随浏览器配置文件同步，更换浏览器或清除站点数据后不再存在。

## 开发

仓库同时维护两套 Tampermonkey 入口，分别面向端用户与开发者。

| 文件 | 用途 |
| ---- | ---- |
| `dist/bilibili-fav-restore.user.js` | 端用户安装文件。由 `build.py` 从核心代码生成，提交后通过 GitHub raw URL 对外分发。 |
| `bilibili-fav-list-fix.user.js` | 开发用 bootstrap，`@version` 永久锁定为 `1.0.0`。仅负责从本地 HTTP 服务拉取核心代码并执行，避免每次修改核心都需重新安装 Tampermonkey。 |
| `src/*.js` | 核心代码，按关注点拆分为多个模块（签名、DOM 替换、菜单注入、登录流程、静默丢弃检测等）。两套入口共享同一份核心。各模块职责详见 `AGENTS.md` 的「src/ 模块地图」。 |
| `bundle.py` | 核心代码组装的单一来源。`MANIFEST` 定义模块加载顺序，将 `src/*.js` 拼接还原为单一 IIFE；`serve.py` 与 `build.py` 共享此函数，保证开发与发布产物一致。 |
| `serve.py` | 本地 HTTP 服务（默认 `127.0.0.1:8766`）。响应 bootstrap 请求时即时调用 `bundle.py` 组装核心代码（磁盘上无单文件核心），端用户无需运行。 |
| `build.py` | 将核心代码（经 `bundle.py` 组装）打包为 `dist/bilibili-fav-restore.user.js`，并自动从中提取 `CORE_VERSION` 写入 `@version`。 |

### 开发循环

```bash
python serve.py
# 浏览器地址栏访问 http://127.0.0.1:8766/bilibili-fav-list-fix.user.js
# Tampermonkey 弹出安装对话框，确认安装 bootstrap（仅需一次）
```

随后编辑 `src/` 下的任一模块，刷新任意收藏夹页面即可生效（`serve.py` 每次请求都会重新组装核心代码，无需构建步骤）。bootstrap 每次都会附加 cache-bust 参数，无需手动清除缓存。

### 发布

1. 修改 `src/00-prologue.js` 中的 `CORE_VERSION`。Tampermonkey 仅在版本号增大时触发自动更新。
2. 运行 `python build.py` 重新生成 `dist/bilibili-fav-restore.user.js`。
3. 提交 `src/` 与 `dist/` 目录并推送到 GitHub。Tampermonkey 通常在 24 小时内为端用户拉取新版本。

### 调试接口

核心代码将 `__biliFavFix` 挂载于 `window`，可在 DevTools Console 中调用。

| 调用 | 用途 |
| ---- | ---- |
| `__biliFavFix.VERSION` | 当前核心版本号 |
| `__biliFavFix.getAuth()` | 查看当前登录模式与凭据状态（脱敏返回 `{ mode, hasAccessKey, ageDays }`，不含原始 `access_key`） |
| `__biliFavFix.ensurePage('android', mediaId, pn)` | 手动抓取指定来源的某一页 |
| `__biliFavFix.patchNow()` | 清除内存缓存并立即重跑 |
| `__biliFavFix.detectMissing()` | 重新扫描服务端静默丢弃的条目 |
| `__biliFavFix.backup.run()` | 备份当前收藏夹至 IndexedDB（等同菜单项） |
| `__biliFavFix.backup.status()` | 返回备份条目数、封面体积、存储用量与本收藏夹上次备份记录 |
| `__biliFavFix.backup.manage()` | 打开备份管理面板，浏览或删除已存备份（等同菜单项） |
| `__biliFavFix.cache` | 查看已缓存的元数据 |
| `__biliFavFix.bvToAv('BV1xx411c7mu')` | BV → av 工具函数 |

`debug` 日志默认关闭，可在 Tampermonkey 菜单中切换。

### bootstrap 安装注意事项

- 必须在浏览器地址栏直接访问 `http://127.0.0.1:8766/bilibili-fav-list-fix.user.js`。Tampermonkey 官网的 `script_installation.php?url=...` 中转页对本地 HTTP 资源不会重定向。
- 本地服务返回的 `Content-Type` 必须为 `application/javascript`，`serve.py` 已强制此值。
- 在 Tampermonkey Dashboard 中将 **Settings → Config mode** 切换为 `Advanced`，并在 **Security → Allow scripts to access cross-origin resources** 中勾选允许。

### 为何不使用 Tampermonkey 的 `@updateURL` 自动更新

Tampermonkey 拒绝 `http://127.0.0.1` 作为 `@updateURL`（insecure-origin policy）。dev 用 bootstrap 的存在即为解决此限制：bootstrap 自身锁定版本永不更新，核心逻辑则由本地 HTTP 服务每次重新拉取。端用户安装的 `dist/` 文件通过 GitHub raw URL 分发，不受此限制影响。

## License

[MIT](./LICENSE)
