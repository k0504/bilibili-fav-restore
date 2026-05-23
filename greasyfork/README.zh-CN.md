# Bilibili 收藏夹失效视频信息还原

[**简体中文**](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

恢复 bilibili 网页版收藏夹中失效（已删除 / UP 自删 / 政策下架）视频的原始封面、标题与作者信息。同时检测并展示 bilibili 服务端层面已经丢弃、不在常规接口返回的条目，并附第三方归档站快照链接。

bilibili 网页版收藏夹接口对失效条目仅返回固定占位封面与「已失效视频」文字。本脚本调用 bilibili Android 客户端使用的接口（含正确签名），从服务端取回失效前的元数据快照并替换页面 DOM。

## 功能

- 还原失效条目的原始封面、标题、作者、播放数与弹幕数
- 在收藏夹卡片上以删除线与灰化标记区分已还原条目
- 在卡片三点菜单中注入「复制完整信息」「清除本条缓存并重新抓取」等操作
- 检测 bilibili 服务端静默丢弃的条目（API 实际返回数小于声明总数），列出对应 av 号并附 biliplus、xbeibeix、jijidown 三个第三方归档站的快照链接
- 提供 TV 端二维码登录与手动粘贴 `access_key` 两种登录模式
- 元数据本地缓存（GM storage），减少对 bilibili API 的重复请求

## 首次使用

1. 安装脚本后，打开任意收藏夹页面，例如 `https://space.bilibili.com/{UID}/favlist?fid={收藏夹 ID}`。
2. 点击 Tampermonkey / Violentmonkey 扩展图标，选择 **fav-fix: Login (TV QR)**。
3. 使用 bilibili 手机客户端扫描页面上显示的二维码并在手机端确认登录。仅 bilibili 官方客户端可用，微信扫码或网页扫码无效。
4. 登录成功后 `access_key` 写入 GM storage，有效期约 30 天。刷新页面后，失效条目应自动恢复原始封面与标题。

若 TV 模式下仍有条目无法取回原始元数据，可在脚本菜单中选择 **fav-fix: Login (manual / paste access_key)**，粘贴一份由 Android 主端应用签发的 `access_key`。

## 多语言支持

脚本 metadata 同时提供简体（默认）与繁体（`@name:zh-TW` / `@description:zh-TW`）变体。Tampermonkey 会根据浏览器 `navigator.language` 自动挑选：`zh-TW` / `zh-HK` / `zh-MO` 命中繁体名称，其他语系落回简体。脚本内部 UI 文字（按钮、提示、tooltip）目前为简体；如需贡献繁体 UI 翻译，欢迎提交 Pull Request。

## 已知限制

- 仅支持本人收藏夹或公开收藏夹。私密收藏夹由 API 鉴权限制无法读取。
- 脚本返回的「原始封面」托管于 bilibili CDN，若 bilibili 在服务端清除该资源文件，脚本无法恢复。
- 第三方归档源（biliplus、xbeibeix、jijidown）的可用性与命中率不在脚本控制范围内。
- 若 bilibili 接口签名密钥被官方轮换（错误码 `-3` / `-101` / `-663`），需等待新版本发布。

## 源代码与问题反馈

源代码完全开源，托管于 GitHub：

- [仓库主页](https://github.com/k0504/bilibili-fav-restore)
- [问题反馈 / Issues](https://github.com/k0504/bilibili-fav-restore/issues)
- [完整开发文档 README](https://github.com/k0504/bilibili-fav-restore/blob/main/README.md)
- [直接安装源（GitHub Raw）](https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js)

欢迎提交 Issue 报告 bug、提交 Pull Request 增加新的归档源或修复 bilibili 接口签名变更。

## License

[MIT](https://github.com/k0504/bilibili-fav-restore/blob/main/LICENSE)
