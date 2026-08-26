# 开发文档

[← 返回 README](../README.md)

仓库同时维护两套 Tampermonkey 入口，分别面向端用户与开发者。

| 文件 | 用途 |
| ---- | ---- |
| `dist/bilibili-fav-restore.user.js` | 端用户安装文件。由 `build.py` 从核心代码生成，提交后通过 GitHub raw URL 对外分发。 |
| `bilibili-fav-list-fix.user.js` | 开发用 bootstrap，`@version` 永久锁定为 `1.0.0`。自身不含任何逻辑，仅以 `@require file://` 载入磁盘上的 `dist/bilibili-fav-restore.user.js`，使修改核心后无需重新安装 Tampermonkey。 |
| `src/*.js` | 核心代码，按关注点拆分为多个模块（签名、DOM 替换、菜单注入、登录流程、静默丢弃检测等）。两套入口共享同一份核心。 |
| `bundle.py` | 核心代码组装的单一来源。`MANIFEST` 定义模块加载顺序，将 `src/*.js` 拼接还原为单一 IIFE；`serve.py` 与 `build.py` 共享此函数，保证开发与发布产物一致。 |
| `serve.py` | 备用的本地 HTTP 服务（默认 `127.0.0.1:8766`），即时调用 `bundle.py` 组装核心代码并附加三层缓存失效标头。已不属于默认开发路径，仅在 `@require` 载入到过期副本时用于排除该因素。 |
| `build.py` | 将核心代码（经 `bundle.py` 组装）打包为 `dist/bilibili-fav-restore.user.js`，并自动从中提取 `CORE_VERSION` 写入 `@version`。 |

## 一次性准备

1. 在 `chrome://extensions` 打开 Tampermonkey 的「详细信息」，开启 **允许访问文件网址**，并将网站访问权限设为 **在所有网站上**。权限范围更窄时 `file://` 读取会失败。
2. 安装 `bilibili-fav-list-fix.user.js`（仅需一次）。该文件的 `@require` 指向本机绝对路径，其他机器需相应修改该行。
3. 若同时安装了 `dist/` 的发布版本，请将其停用，否则两份核心会同时载入。

## 开发循环

编辑 `src/` 下的任一模块后：

```bash
python build.py
```

随后刷新任意收藏夹页面即可生效。`@require` 载入的是构建产物而非 `src/` 中的单个模块——各模块共享同一个闭包（见 `bundle.py`），无法单独载入，因此构建步骤不可省略。

新增 `src/` 模块时须同步在 `bundle.py` 的 `MANIFEST` 中登记，否则 `check_manifest()` 会中断构建。

开发期间 `dist/` 会随每次构建变动。发布前请确认其内容与预期一致：该文件同时是对外分发的产物，提交未完成的中间状态会直接影响端用户。

## 载入到过期副本时

Tampermonkey 不保证在每次页面载入时重新读取 `file://` 依赖。判断当前实际运行的版本有两处：浏览器控制台启动时输出的 `core X.Y.Z ready`，以及悬浮按钮菜单标题栏右侧的版本号。若确认为过期副本，可改用备用路径排除该因素：

```bash
python serve.py
```

并将 bootstrap 的 `@require` 一行替换为原先的 HTTP 拉取逻辑（见该文件注释）。该路径以三层缓存失效标头保证取得当前字节。

## 发布

1. 修改 `src/00-prologue.js` 中的 `CORE_VERSION`。Tampermonkey 仅在版本号增大时触发自动更新。
2. 运行 `python build.py` 重新生成 `dist/bilibili-fav-restore.user.js`。
3. 提交 `src/` 与 `dist/` 目录并推送到 GitHub。Tampermonkey 通常在 24 小时内为端用户拉取新版本。

## 调试接口

核心代码将 `__biliFavFix` 挂载于 `window`，可在 DevTools Console 中调用。完整列表见 `__biliFavFix.help()`。

| 调用 | 用途 |
| ---- | ---- |
| `__biliFavFix.VERSION` | 当前核心版本号 |
| `__biliFavFix.stats()` | 一次性健康检查：登录状态、缓存大小、DOM 中的卡片与已修补数量 |
| `__biliFavFix.listSources()` | 列出各数据源的启用状态与类型 |
| `__biliFavFix.getAuth()` | 查看当前登录模式与凭据状态（脱敏返回 `{ mode, hasAccessKey, ageDays }`，不含原始 `access_key`） |
| `__biliFavFix.ensurePage('android', mediaId, pn)` | 手动抓取指定来源的某一页 |
| `__biliFavFix.patchNow()` | 清除内存缓存并立即重跑 |
| `__biliFavFix.forceRefetch(bvOrAv)` | 清除单个条目的缓存并重新抓取 |
| `__biliFavFix.detectMissing()` | 重新扫描服务端静默丢弃的条目 |
| `__biliFavFix.clearAllItemCache()` | 清除全部逐条元数据缓存（不影响备份数据） |
| `__biliFavFix.backup.run()` | 备份当前收藏夹至 IndexedDB（等同菜单项） |
| `__biliFavFix.backup.status()` | 返回备份条目数、封面体积、存储用量、按数据来源统计的条目数与本收藏夹上次备份记录 |
| `__biliFavFix.backup.manage()` | 打开备份管理面板（等同菜单项） |
| `__biliFavFix.backup.exportAll()` | 不经面板，直接将全部备份导出为一个 ZIP 文件 |
| `__biliFavFix.backup.promote` | 还原结果自动转存的调试入口：`queued()` 查看待转存任务数，`migrated()` 查看一次性迁移是否已执行，`migrateNow()` 重新执行迁移 |
| `__biliFavFix.noRetry.list()` / `.counts()` | 列出或统计全部「停止重试」记录及其类型与时间 |
| `__biliFavFix.noRetry.stop(av)` / `.resume(av)` | 停止或恢复单个条目的重试（等同封面按钮与菜单操作） |
| `__biliFavFix.noRetry.clearAll()` | 清空全部停止记录并重绘当前页面 |
| `__biliFavFix.settings.open()` | 打开设置面板（等同菜单项） |
| `__biliFavFix.settings.get(key)` | 读取单项设置的当前值 |
| `__biliFavFix.settings.set(key, v)` | 写入单项设置，返回 `{ ok, value }` 或 `{ ok: false, error }`，校验规则与面板一致 |
| `__biliFavFix.settings.reset(key)` / `.resetAll()` | 恢复单项或全部设置的默认值 |
| `__biliFavFix.settings.changed()` | 列出全部与默认值不同的设置项 |
| `__biliFavFix.settings.schema()` | 返回全部设置项的定义（键名、分组、类型、默认值、取值范围、说明） |
| `__biliFavFix.fab.resetPosition()` | 将悬浮按钮移回默认位置 |
| `__biliFavFix.fab.open()` / `.close()` | 展开或收起悬浮按钮的菜单 |
| `__biliFavFix.cache` | 查看已缓存的元数据 |
| `__biliFavFix.bvToAv('BV1xx411c7mu')` | BV → av 工具函数 |

`debug` 日志默认关闭，可在 **菜单 → 维护与调试 → 开关调试日志** 或 **设置 → 界面与调试 → 调试日志** 中切换，两处为同一开关。

## bootstrap 安装注意事项

- 必须在浏览器地址栏直接访问 `http://127.0.0.1:8766/bilibili-fav-list-fix.user.js`。Tampermonkey 官网的 `script_installation.php?url=...` 中转页对本地 HTTP 资源不会重定向。
- 本地服务返回的 `Content-Type` 必须为 `application/javascript`，`serve.py` 已强制此值。
- 在 Tampermonkey Dashboard 中将 **Settings → Config mode** 切换为 `Advanced`，并在 **Security → Allow scripts to access cross-origin resources** 中勾选允许。

## 为何不使用 Tampermonkey 的 `@updateURL` 自动更新

Tampermonkey 拒绝 `http://127.0.0.1` 作为 `@updateURL`（insecure-origin policy）。dev 用 bootstrap 的存在即为解决此限制：bootstrap 自身锁定版本永不更新，核心逻辑则由本地 HTTP 服务每次重新拉取。端用户安装的 `dist/` 文件通过 GitHub raw URL 分发，不受此限制影响。
