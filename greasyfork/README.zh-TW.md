# Bilibili 收藏夾失效影片資訊還原

[简体中文](./README.zh-CN.md) | [**繁體中文**](./README.zh-TW.md)

還原 bilibili 網頁版收藏夾中失效（已刪除 / UP 自刪 / 政策下架）影片的原始封面、標題與作者資訊。同時偵測並展示 bilibili 服務端層面已經丟棄、不在常規接口回傳的條目，並附第三方歸檔站快照連結。

bilibili 網頁版收藏夾接口對失效條目僅回傳固定佔位封面與「已失效视频」文字。本腳本呼叫 bilibili Android 客戶端使用的接口（含正確簽名），從服務端取回失效前的 metadata 快照並替換頁面 DOM。

## 功能

- 還原失效條目的原始封面、標題、作者、播放數與彈幕數
- 在收藏夾卡片上以刪除線與灰化標記區分已還原條目
- 在卡片三點選單中注入「複製完整資訊」「清除本條快取並重新抓取」等操作
- 偵測 bilibili 服務端靜默丟棄的條目（API 實際回傳數小於聲明總數），列出對應 av 號並附 biliplus、xbeibeix、jijidown 三個第三方歸檔站的快照連結
- 提供 TV 端 QR Code 登入與手動貼上 `access_key` 兩種登入模式
- Metadata 本機快取（GM storage），減少對 bilibili API 的重複請求

## 首次使用

1. 安裝腳本後，開啟任意收藏夾頁面，例如 `https://space.bilibili.com/{UID}/favlist?fid={收藏夾 ID}`。
2. 點擊 Tampermonkey / Violentmonkey 擴充功能圖示，選擇 **fav-fix: Login (TV QR)**。
3. 使用 bilibili 手機客戶端掃描頁面上顯示的 QR Code 並在手機端確認登入。僅 bilibili 官方客戶端可用，微信掃碼或網頁掃碼無效。
4. 登入成功後 `access_key` 寫入 GM storage，有效期約 30 天。重新整理頁面後，失效條目應自動還原原始封面與標題。

若 TV 模式下仍有條目無法取回原始 metadata，可在腳本選單中選擇 **fav-fix: Login (manual / paste access_key)**，貼上一份由 Android 主端應用簽發的 `access_key`。

## 多語言支援

腳本 metadata 同時提供簡體（預設）與繁體（`@name:zh-TW` / `@description:zh-TW`）變體。Tampermonkey 會根據瀏覽器 `navigator.language` 自動挑選：`zh-TW` / `zh-HK` / `zh-MO` 命中繁體名稱，其他語系回退到簡體。腳本內部 UI 文字（按鈕、提示、tooltip）目前為簡體；若希望貢獻繁體 UI 翻譯，歡迎提交 Pull Request。

## 已知限制

- 僅支援本人收藏夾或公開收藏夾。私密收藏夾因 API 鑑權限制無法讀取。
- 腳本回傳的「原始封面」託管於 bilibili CDN，若 bilibili 在服務端清除該資源檔案，腳本無法還原。
- 第三方歸檔源（biliplus、xbeibeix、jijidown）的可用性與命中率不在腳本控制範圍內。
- 若 bilibili 接口簽名金鑰被官方輪換（錯誤碼 `-3` / `-101` / `-663`），需等待新版本發布。

## 原始碼與問題回報

原始碼完全開源，託管於 GitHub：

- [倉庫主頁](https://github.com/k0504/bilibili-fav-restore)
- [問題回報 / Issues](https://github.com/k0504/bilibili-fav-restore/issues)
- [完整開發文件 README](https://github.com/k0504/bilibili-fav-restore/blob/main/README.md)
- [直接安裝源（GitHub Raw）](https://raw.githubusercontent.com/k0504/bilibili-fav-restore/main/dist/bilibili-fav-restore.user.js)

歡迎提交 Issue 回報 bug、提交 Pull Request 新增歸檔源或修復 bilibili 接口簽名變更。

## License

[MIT](https://github.com/k0504/bilibili-fav-restore/blob/main/LICENSE)
