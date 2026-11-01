# Changelog

## [1.0.0] — 2026-11-01

首個 **TabCap Web** 純前端版本（與 TabCap 伺服器版 4.0.0 同一天發布）。

### Added
- 完全瀏覽器端執行的四步製譜流程：匯入 → 截圖 → 調整 → 排版匯出。
- 本地影片／圖片匯入；桌面 Chrome / Edge 支援**螢幕／分頁擷取**（`getDisplayMedia`）。
- 抽幀去重：譜面像素差異比例 + 移動播放頭條帶遮罩 + 空白畫面跳過。
- 小節線自動偵測（投影法）＋手動點擊新增／移除。
- 排版：A4 @150dpi、直式／橫式、邊距／間距／縮放／對齊、底色／字色、二值化／反色、即時預覽。
- 匯出：PDF（pdf-lib）、長圖 PNG、`.psz`（JSZip，含 `score.pdf` + `score.json`）。
- PWA：manifest、Service Worker（離線殼、預快取）、安裝提示（Chromium `beforeinstallprompt`、iOS 加入主畫面引導）。
- GitHub Pages 部署 workflow（`.github/workflows/pages.yml`）。
- 無頭端到端測試（Edge + CDP）：真實產生測試影片、跑完整流程、驗證 PDF/PSZ、離線重載。

### Changed
- 專案為純靜態（HTML/CSS/JS + vendored 函式庫），無後端、無資料庫、無 npm/build step。
- 繁體中文介面（台灣用字）。

### Not included（與伺服器版的差異）
- 貼 YouTube／B 站連結自動下載（純前端受 CORS／平臺防護限制）。
- PDF 檔匯入、歷史記錄／中斷續傳、`.psz` 伴奏音檔。
- 多行譜表自動切分／拼接（目前一張截圖 = 一行）。

## [伺服器版 4.0.0]

見另一個 `TabCap` 專案的 `CHANGELOG.md`（多平臺解析、Docker 部署、完整 PWA 等）。
