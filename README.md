# TabCap Web

**把動態吉他譜 / 六線譜影片，自動截圖、去重、按小節線拼接成整潔 PDF — 完全在你的瀏覽器裡完成。**

純靜態 PWA：不用安裝、不用後端、不需要 build step；上傳到 **GitHub Pages**（或任何靜態空間）就能直接開網頁使用，也可以「加到主畫面」變成手機 App。

[![PWA](https://img.shields.io/badge/PWA-installable-176b5b)](https://web.dev/explore/progressive-web-apps)
[![GitHub Pages](https://img.shields.io/badge/deploy-GitHub%20Pages-176b5b)](https://pages.github.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-176b5b)](LICENSE)

![桌面版：排版與匯出](docs/screenshots/desktop-layout.png)

## 這是什麼

| 步驟 | 功能 |
| --- | --- |
| 1 匯入 | 本機影片／圖片；桌面 Chrome / Edge 可用**螢幕或分頁擷取**抓正在播放的線上影片 |
| 2 截圖 | 設定時間範圍、採樣間隔、差異閾值；自動抽幀並**去重**（忽略移動中的播放頭） |
| 3 調整 | 逐張裁切、自動／手動小節線、隱藏、刪除 |
| 4 排版 | 標題、紙張方向、邊距、間距、縮放、對齊、二值化／反色，即時預覽 |
| 匯出 | **PDF**、**長圖 PNG**、**`.psz`**（PDF Score 譜麵包，含 `score.pdf`/`score.json` 幾何） |

四步流程與伺服器版 TabCap 相同，但**所有運算都在瀏覽器**：檔案不會上傳到任何伺服器。

| 手機：第 3 步調整 | 手機：第 4 步排版 |
| --- | --- |
| ![手機第3步](docs/screenshots/mobile-step3.png) | ![手機第4步](docs/screenshots/mobile-layout.png) |

## 一鍵上線 GitHub Pages

> 建議把這個資料夾（`TabCapWeb/`）當成一個**獨立 repo** 上傳，最省事。
> 若你已經有 TabCap 伺服器版 repo，也可以把這個資料夾複製進去（改名 `webapp/`），再用內附的 Pages workflow 指定路徑部署。

```bash
# 1) 建一個新 repo（例如 tabcap-web），把本資料夾內容推上去
cd TabCapWeb
git init
git add .
git commit -m "feat: TabCap Web 1.0.0 — 純前端 PWA"
git branch -M main
git remote add origin https://github.com/<你的帳號>/tabcap-web.git
git push -u origin main
```

2) 到 repo **Settings → Pages → Build and deployment**：
   - Source 選 **GitHub Actions**（本 repo 已附 `.github/workflows/pages.yml`，push 後會自動部署）
   - 或 Source 選 **Deploy from a branch** → `main` / `(root)`
3) 等 1～2 分鐘，打開 `https://<你的帳號>.github.io/tabcap-web/`。
4) 手機用 **Safari** 開啟 → 分享 → **加入主畫面**；桌面 Chrome / Edge 可點網址列安裝圖示。

> 靜態伺服器必須支援 HTTPS（或 `localhost`），Service Worker 與安裝功能才會生效。
> 本專案**不能直接雙擊 `index.html`**（`file://` 下限制較多），本機請用 `python -m http.server 8080`。

## 與伺服器版（TabCap 4.x）的差異

| 項目 | 伺服器版 | 本版（純前端） |
| --- | --- | --- |
| 貼上 YouTube／B 站連結自動下載 | ✅ yt-dlp / B 站原生解析 | ❌ 純前端做不到（CORS + 平臺防護，見下） |
| 線上影片製譜 | ✅ | 桌面 Chrome / Edge：**螢幕／分頁擷取**；iOS：先螢幕錄影再匯入 |
| 本地影片／圖片 | ✅ | ✅ |
| PDF 檔匯入 | ✅ | ❌（本版只收影片與圖片） |
| 歷史記錄／中斷續傳 | ✅ 伺服器端快取 | ❌ 全在頁面記憶體，重新整理即消失 |
| 檔案隱私 | 上傳到自己的後端 | ✅ 完全留在瀏覽器 |
| PWA／離線殼 | ✅ | ✅ |

### 為什麼不能貼連結下載？

瀏覽器直接抓 YouTube／B 站影片會遇到 CORS 與平臺防護；純靜態網站沒有後端可以代抓。可行的替代方案只有：

1. **桌面 Chrome / Edge**：先播放影片，按「擷取螢幕／分頁」，選擇該分頁，讓本工具即時取樣。
2. **任何裝置**：用系統螢幕錄影錄下要製譜的片段，再用「本地影片」匯入。

DRM 保護內容與直播一律不支援。

## 功能細節

- **抽幀去重**：以「譜面像素（暗色像素）差異比例」判斷新畫面，並偵測移動中的播放頭條帶、比較時忽略，避免同一行被重複截圖。
- **小節線偵測**：灰階 → 水平譜線群組 → 譜表帶內垂直投影找小節線；找不到可手動點擊圖片新增／移除。
- **排版**：A4 @150dpi（直式 1240×1754）自動分頁，支援邊距／間距／縮放／對齊／橫豎／底色字色／二值化／反色。
- **`.psz`**：`score.pdf` + `score.json`（PDF Score 幾何：每行系統上下沿與小節線 x 座標，`pt = px × 72 / 150`）放在壓縮包**根目錄**。
- **離線**：Service Worker 預快取頁面殼與程式；斷網仍可開啟頁面（但無法匯入新檔案）。
- **隱私**：沒有後端、沒有分析、沒有 CDN；`vendor/` 內的 pdf-lib / JSZip 都是本地檔案。

## 本機開發

```bash
# 在 TabCapWeb/ 目錄下
python -m http.server 8080
# 開 http://127.0.0.1:8080/
```

沒有 npm、沒有 build step；改完檔案重新整理即可。改了任何靜態資源請把 `sw.js` 的 `CACHE_VERSION` 加一（例如 `tabcap-web-v2`），否則已安裝的裝置會沿用舊快取。

### 目錄結構

```
index.html                  四步流程 UI
styles.css                  全部樣式（品牌色、手機、安全區、standalone）
app.js                      主控制器（狀態機、四步流程、匯出）
js/ui.js                    UI 工具（toast / setBusy / dialog / stage / 離線 / 安裝 / SW）
js/media.js                 媒體：建立來源、取幀、螢幕擷取
js/capture.js               抽幀與去重演算法
js/image.js                 裁切、二值化、小節線偵測
js/layout.js                排版計算與頁面繪製
js/export.js                PDF / 長圖 / psz（pdf-lib + JSZip）
vendor/                     pdf-lib.min.js、jszip.min.js（已內附，無 CDN）
assets/                     PWA 圖示
docs/                       架構說明、截圖
tests/                      無頭端到端測試（Edge + CDP）
```

## 測試

需要 Node.js 與 Edge（Windows 預設路徑；其他平臺改 `tests/run-e2e.mjs` 開頭的 `EDGE`）：

```bash
# 1) 起靜態伺服器
python -m http.server 8130

# 2) 跑端到端：頁面產生 6 秒測試影片 → 匯入 → 抽幀去重 → 排版 → PDF/PSZ
node tests/run-e2e.mjs --url http://127.0.0.1:8130/ --out tests/_shots/desktop --width 1440 --height 900

# 手機視窗 + 離線外殼驗證
node tests/run-e2e.mjs --url http://127.0.0.1:8130/ --out tests/_shots/mobile --width 390 --height 844 --mobile --offline-check
```

測試會檢查：`%PDF-` 檔頭、`.psz` 根目錄條目、頁數、console error、橫向溢出、Service Worker 離線重載。

## 已知限制

- 不能貼 YouTube／B 站連結自動下載（純前端限制；請用螢幕擷取或先錄影）。
- 不支援 PDF 檔匯入。
- iPhone／iPad 沒有 `getDisplayMedia`，無法直接擷取螢幕。
- 沒有歷史記錄與進度恢復；重新整理就消失，長影片請一次做完。
- 大量高解析度截圖可能讓手機變慢；建議加大採樣間隔或差異閾值。
- `.psz` 不含伴奏音檔（純前端不解析影片音軌）。
- 排版模型是「一張截圖 = 一行」，尚未做伺服器版的多行自動切分／拼接；若截圖本身含多行譜表，建議在第 3 步用不同裁切拆成多張。

## 授權與致謝

- 本專案程式碼：**MIT**（見 [LICENSE](LICENSE)）。
- 第三方：**pdf-lib**（MIT）、**JSZip**（MIT / GPLv3 雙授權），已 vendored 於 `vendor/`。
- 流程與演算法移植自 TabCap 伺服器版（原始靈感：santiRostan/TabCapture、Carrot-shreds/score_capture、yt-dlp）。
- 商標聲明：與 YouTube、嗶哩嗶哩等平臺無官方關聯。僅供個人學習使用，請尊重譜面作者與平臺條款。
