# 無頭端到端測試

`run-e2e.mjs` 用 Edge（CDP）載入這個純前端 App，並在瀏覽器裡：

1. 用 canvas + MediaRecorder **現場產生**一段 6 秒 WebM 測試影片（不依賴外部素材）；
2. 透過 `window.TabCapDebug` 走完：匯入 → 抽幀去重 → 排版 → 匯出 PDF / PSZ；
3. 檢查 `%PDF-` 檔頭、`.psz` 根目錄條目、頁數、console error、橫向溢出；
4. 截圖（桌面／手機版）；
5. `--offline-check` 會模擬斷網後重新載入，驗證 Service Worker 離線殼。

## 用法

```bash
# 在 TabCapWeb/ 根目錄
python -m http.server 8130

# 另開一個終端
node tests/run-e2e.mjs --url http://127.0.0.1:8130/ --out tests/_shots/desktop --width 1440 --height 900
node tests/run-e2e.mjs --url http://127.0.0.1:8130/ --out tests/_shots/mobile  --width 390 --height 844 --mobile --offline-check
```

- `EDGE` 路徑在 `run-e2e.mjs` 開頭，Windows 預設 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；
  其他系統請改成自己的 Chromium／Edge 執行檔。
- 需要 Node.js 18+（內建 `WebSocket` 與 `fetch`；本專案以 Node 24 驗證）。
- 截圖輸出在 `tests/_shots/`（已列在 `.gitignore`，不會進 repo）。
