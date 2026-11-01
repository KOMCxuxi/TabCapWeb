# 架構說明（TabCap Web）

純靜態 PWA，沒有任何後端。所有程式都是原生 JS，掛在 `window.TabCap*` 命名空間，
依序由 `index.html` 以 `<script defer>` 載入；沒有 npm、沒有 build step、沒有 CDN。

## 模組

| 模組 | 全域 | 職責 |
| --- | --- | --- |
| `app.js` | — | 主控制器：狀態機、四步流程、UI 綁定、匯出按鈕；只透過下列模組做事 |
| `js/ui.js` | `TabCapUI` | toast / setBusy / confirmDialog / setStage / 離線提示 / 安裝流程 / SW 註冊 |
| `js/media.js` | `TabCapMedia` | 建立影片或圖片來源、seek 取幀、`getDisplayMedia` 螢幕擷取、canvas → Blob |
| `js/capture.js` | `TabCapCapture` | 抽幀（可 seek 影片／即時串流）與去重（譜面像素差異 + 播放頭條帶遮罩 + 空白跳過） |
| `js/image.js` | `TabCapImage` | 正規化裁切、縮放、二值化／反色、小節線偵測（列投影 → 譜線分群 → 欄投影） |
| `js/layout.js` | `TabCapLayout` | A4 @150dpi 排版、自動分頁、頁面 canvas 繪製、psz 幾何（px） |
| `js/export.js` | `TabCapExport` | PDF（pdf-lib）、長圖 PNG、`.psz`（JSZip）+ `score.json` |

## 資料流

```
檔案 / 螢幕擷取
      │  TabCapMedia.createVideoSource / createImageSource / openScreenCapture
      ▼
  state.source ──► TabCapCapture.sampleVideo / sampleLive（Frame[]）
      │                     │
      │                     ▼
      │              TabCapCapture.dedupe（保留 Frame[]）
      ▼                     │
  TabCapMedia.grabFrame ◄───┘（預覽）
      │
      ▼
  Capture[]（blob + crop + measures + hidden）  ── 第 3 步：TabCapImage.cropCanvas / detectMeasures
      │
      ▼
  TabCapImage.drawPrepared → toWorkingCanvas
      │
      ▼
  TabCapLayout.layoutPages → { pages, geometry } → renderPages → canvas[]
      │
      ├─ TabCapExport.exportPdf   → PDF（pt = px × 72 / 150）
      ├─ TabCapExport.exportLongImage → PNG
      └─ TabCapExport.exportPsz   → .psz（根目錄：score.pdf + score.json）
```

## 重要取捨

- **為什麼不能貼連結下載**：瀏覽器跨網域抓 YouTube／B 站影片會被 CORS 與平臺防護擋下；
  純靜態沒有後端可代理。替代方案是桌面 Chrome/Edge 的 `getDisplayMedia` 分頁擷取，
  或使用者先螢幕錄影再匯入。
- **一張截圖 = 一行**：伺服器版有「多行譜表自動切分／跨截圖拼接」，純前端 v1 先採簡化模型；
  需要時可在第 3 步把同一張大圖用不同裁切拆成多張。
- **`.psz` 幾何**：沿用伺服器版已被 PDF Score 驗證的格式：
  `pages[].systems[] = { id, y0(上沿, 大), y1(下沿, 小), bars: [{ id, x }] }`；
  每行相鄰兩條小節線之間是一個小節，所以行首與行尾都要各標一條。
  `pt = px × 72 / 150`，與 PDF 頁面尺寸同一個換算。
- **記憶體**：截圖以 Blob 保存在頁面記憶體，沒有 IndexedDB 持久化；重新整理即消失。
- **離線**：Service Worker 預快取頁面殼與程式；離線可開啟頁面，但匯入／抽幀仍靠本機效能。
- **更新快取**：改任何靜態資源都要遞增 `sw.js` 的 `CACHE_VERSION`，否則已安裝的裝置會用舊殼。

## 測試

`tests/run-e2e.mjs`（Edge + CDP）在瀏覽器裡現場用 canvas + MediaRecorder 產生 6 秒測試影片，
跑完 匯入 → 抽幀去重 → 排版 → PDF/PSZ，並檢查檔頭、zip 根目錄、console error、橫向溢出；
加上 `--offline-check` 會模擬斷網重載驗證 Service Worker。用法見 `tests/README.md`。
