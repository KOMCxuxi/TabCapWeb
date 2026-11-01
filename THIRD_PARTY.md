# 第三方元件與授權

本專案自己的程式碼以 **MIT** 釋出（見 `LICENSE`）。執行時只使用下列兩個第三方函式庫，
兩者都已**內附**在 `vendor/`（沒有使用 CDN、沒有 npm）：

| 元件 | 版本 | 用途 | 授權 |
| --- | --- | --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | 產生 PDF（嵌入頁面 JPEG、設定頁面尺寸與 metadata） | MIT |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | 打包 `.psz`（zip 內含 `score.pdf` / `score.json`） | MIT 或 GPLv3（雙授權；本專案以 MIT 條款使用） |

## 靈感與演算法來源

- **TabCap 伺服器版**（本專案的前身，Flask + OpenCV + PyMuPDF）：四步流程、抽幀去重、
  小節線偵測、PDF／`.psz` 幾何規則移植自該專案。
- [santiRostan/TabCapture](https://github.com/santiRostan/TabCapture)：原始專案框架與截圖演算法。
- [Carrot-shreds/score_capture](https://github.com/Carrot-shreds/score_capture)：小節線識別與裁剪去重。
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)：伺服器版的多平臺解析（本純前端版不含此功能）。

上述上游專案的授權狀態請以其倉庫為準；若你要再分發，建議一併確認。

## 商標與平臺聲明

本專案與 YouTube、嗶哩嗶哩（bilibili）、Vimeo 等平臺**沒有任何官方關聯**；
所有平臺名稱與商標屬於各自所有者。本工具不提供 DRM 破解，僅供個人學習與練習使用。
