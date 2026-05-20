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

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome、Edge、Firefox 均可）。
2. 在浏览器地址栏直接访问以下链接，Tampermonkey 将弹出安装对话框：

   ```
   https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js
   ```

3. 安装完成后，Tampermonkey 会定期向同一 URL 检查更新；新版本将自动提示安装。

## 首次登录

1. 打开任意收藏夹页面，例如 `https://space.bilibili.com/{UID}/favlist?fid={收藏夹 ID}`。
2. 点击 Tampermonkey 扩展图标，选择 **fav-fix: Login (TV QR)**。
3. 使用 bilibili 手机客户端扫描页面上显示的二维码并确认登录。**仅 bilibili 官方客户端可用**，微信扫码或网页扫码无效。
4. 登录成功后 `access_key` 会写入 GM storage，有效期约 30 天。刷新页面后，失效条目应自动恢复。

如某些条目在 TV 模式下仍无法取回原始元数据，可在 Tampermonkey 菜单中选择 **fav-fix: Login (manual / paste access_key)**，粘贴一份由 Android 主端应用签发的 `access_key`（需自行通过 mitm 工具抓取）。

## 已知限制

- 仅支持本人收藏夹或公开收藏夹。私密收藏夹受 API 鉴权限制无法读取。
- 脚本返回的「原始封面」托管于 bilibili CDN。若 bilibili 在服务端清除该资源文件，脚本无法恢复。
- 每页上限 20 条，最多翻阅 30 页。如需调整，修改 `bilibili-fav-list-fix-core.js` 中的 `MAX_PN`。
- 若 API 返回 `-3` / `-101` / `-663`，通常表示 appkey 或 appsec 已被 bilibili 更新，需重新抓取并替换核心代码顶端常量。
- 第三方归档源（biliplus、xbeibeix、jijidown）的可用性与命中率不在脚本控制范围内。

## 开发

仓库同时维护两套 Tampermonkey 入口，分别面向端用户与开发者。

| 文件 | 用途 |
| ---- | ---- |
| `dist/bilibili-fav-restore.user.js` | 端用户安装文件。由 `build.py` 从核心代码生成，提交后通过 GitHub raw URL 对外分发。 |
| `bilibili-fav-list-fix.user.js` | 开发用 bootstrap，`@version` 永久锁定为 `1.0.0`。仅负责从本地 HTTP 服务拉取核心代码并执行，避免每次修改核心都需重新安装 Tampermonkey。 |
| `bilibili-fav-list-fix-core.js` | 核心代码。包含请求签名、DOM 替换、菜单注入、登录流程、静默丢弃检测等全部逻辑。两套入口共享同一份核心。 |
| `serve.py` | 本地 HTTP 服务（默认 `127.0.0.1:8765`）。仅供 dev bootstrap 拉取核心代码，端用户无需运行。 |
| `build.py` | 将核心代码打包为 `dist/bilibili-fav-restore.user.js`，并自动从核心代码中提取 `CORE_VERSION` 写入 `@version`。 |

### 开发循环

```bash
python serve.py
# 浏览器地址栏访问 http://127.0.0.1:8765/bilibili-fav-list-fix.user.js
# Tampermonkey 弹出安装对话框，确认安装 bootstrap（仅需一次）
```

随后编辑 `bilibili-fav-list-fix-core.js`，刷新任意收藏夹页面即可生效。bootstrap 每次都会附加 cache-bust 参数，无需手动清除缓存。

### 发布

1. 修改 `bilibili-fav-list-fix-core.js` 顶端的 `CORE_VERSION`。Tampermonkey 仅在版本号增大时触发自动更新。
2. 运行 `python build.py` 重新生成 `dist/bilibili-fav-restore.user.js`。
3. 提交核心代码与 `dist/` 目录并推送到 GitHub。Tampermonkey 通常在 24 小时内为端用户拉取新版本。

### 调试接口

核心代码将 `__biliFavFix` 挂载于 `window`，可在 DevTools Console 中调用。

| 调用 | 用途 |
| ---- | ---- |
| `__biliFavFix.VERSION` | 当前核心版本号 |
| `__biliFavFix.getAuth()` | 查看当前登录模式与 `access_key` 状态 |
| `__biliFavFix.fetchPage(mediaId, pn)` | 手动调用 Android 接口 |
| `__biliFavFix.patchNow()` | 清除内存缓存并立即重跑 |
| `__biliFavFix.detectMissing()` | 重新扫描服务端静默丢弃的条目 |
| `__biliFavFix.cache` | 查看已缓存的元数据 |
| `__biliFavFix.bvToAv('BV1xx411c7mu')` | BV → av 工具函数 |

`debug` 日志默认关闭，可在 Tampermonkey 菜单中切换。

### bootstrap 安装注意事项

- 必须在浏览器地址栏直接访问 `http://127.0.0.1:8765/bilibili-fav-list-fix.user.js`。Tampermonkey 官网的 `script_installation.php?url=...` 中转页对本地 HTTP 资源不会重定向。
- 本地服务返回的 `Content-Type` 必须为 `application/javascript`，`serve.py` 已强制此值。
- 在 Tampermonkey Dashboard 中将 **Settings → Config mode** 切换为 `Advanced`，并在 **Security → Allow scripts to access cross-origin resources** 中勾选允许。

### 为何不使用 Tampermonkey 的 `@updateURL` 自动更新

Tampermonkey 拒绝 `http://127.0.0.1` 作为 `@updateURL`（insecure-origin policy）。dev 用 bootstrap 的存在即为解决此限制：bootstrap 自身锁定版本永不更新，核心逻辑则由本地 HTTP 服务每次重新拉取。端用户安装的 `dist/` 文件通过 GitHub raw URL 分发，不受此限制影响。

## License

[MIT](./LICENSE)
