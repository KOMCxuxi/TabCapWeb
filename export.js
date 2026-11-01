/* =============================================================================
 * js/export.js — TabCapWeb 純前端匯出（PDF / 長圖 PNG / psz 譜面包）
 *
 * 用途
 *   把排版好的每頁 canvas 匯出成使用者要的三種檔案，原本由 Python 後端做
 *   （tab_extractor.build_pdf_from_images / build_long_image / build_score_meta + app.py 的
 *   /api/pdf、/api/long_image、/api/psz）。現在全部在瀏覽器用已 vendored 的 PDFLib / JSZip。
 *
 * 為什麼這樣寫
 *   · 沒有後端 / npm / build step / CDN：只用 vendor/pdf-lib.min.js（全域 PDFLib）與
 *     vendor/jszip.min.js（全域 JSZip），載入順序由 index.html 保證。
 *   · 整個匯出鏈的換算基準是 150 DPI：pt = px × 72 / 150（= 0.48）。PDF 頁面尺寸、psz 的
 *     score.json 幾何都用同一個常數，寫死別的數會讓小節線在 PDF Score 裡偏移。
 *   · PDF 每頁走 canvas → JPEG(0.9) → embedJpg：譜面是線稿，JPEG 0.9 在 150 DPI 下夠清楚，
 *     檔案又比 PNG 小很多（整本譜的 PDF 常常只有幾 MB）。
 *   · psz 是「改了附檔名的 zip」：根目錄只能有 score.pdf / score.json（/cover.<ext>），
 *     多一層子目錄 PDF Score 會把它誤認成第二份樂譜 —— 這裡刻意只用平坦檔名。
 *   · score.json 的規則移植自舊版 tab_extractor.build_score_meta()：
 *       幾何一律 PDF 點、y 軸向上（y0 = 上沿、值大；y1 = 下沿、值小）；
 *       每行首尾兩條小節線都要寫（一行相鄰兩線之間 = 一個小節）。
 *     v1 沒有音訊：每行只有首尾兩條線（一行一小節）時回 null → 包裡就不放 score.json。
 *   · 防禦性：沒有頁面、0 頁、tainted canvas（跨網域圖片）都丟繁體中文 Error，
 *     函式不依賴 app.js / DOM 結構，可在任何頁面或測試頁單獨呼叫。
 * ============================================================================= */
(function (global) {
  "use strict";

  /* 與 layout.js 相同的落盤解析度：PDF 點數 = 像素 × 72 / 150。 */
  var PDF_DPI = 150;
  var PT_PER_PX = 72 / PDF_DPI;

  /* 每頁轉 JPEG 的品質。 */
  var JPEG_QUALITY = 0.9;

  /* 長圖是單一 canvas：保守上限（單邊 / 總面積），超過就等比縮，避免瀏覽器直接畫不出來。 */
  var MAX_LONG_IMAGE_SIDE = 32000;
  var MAX_LONG_IMAGE_AREA = 200000000; /* 2 億像素 */

  var COVER_TYPES = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/avif": "avif"
  };

  /* --------------------------------------------------------------------------
   * 小型工具
   * ------------------------------------------------------------------------ */

  function createCanvas(width, height) {
    if (typeof document === "undefined" || !document.createElement) {
      throw new Error("此環境沒有 Canvas，無法匯出檔案。");
    }
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function isCanvasLike(value) {
    return !!(
      value &&
      typeof value === "object" &&
      typeof value.width === "number" &&
      value.width > 0 &&
      typeof value.height === "number" &&
      value.height > 0 &&
      typeof value.getContext === "function"
    );
  }

  function collectCanvases(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (isCanvasLike(value[i])) out.push(value[i]);
    }
    return out;
  }

  function toFiniteNumber(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /* 像素 → PDF 點（pt）。A4 @150dpi 的 1240 / 1754 換算後剛好是 595.2 / 841.92。 */
  function pxToPt(px) {
    return round2(toFiniteNumber(px, 0) * PT_PER_PX);
  }

  function getPDFLib() {
    if (typeof PDFLib === "undefined" || !PDFLib || !PDFLib.PDFDocument) {
      throw new Error("缺少 PDF 套件：vendor/pdf-lib.min.js 沒有載入（全域 PDFLib 不存在）。");
    }
    return PDFLib;
  }

  function getJSZip() {
    if (typeof JSZip === "undefined" || !JSZip) {
      throw new Error("缺少 ZIP 套件：vendor/jszip.min.js 沒有載入（全域 JSZip 不存在）。");
    }
    return JSZip;
  }

  function base64ToBytes(base64) {
    var text = typeof atob === "function" ? atob(base64) : null;
    if (text === null) throw new Error("此環境無法解 base64，匯出失敗。");
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  /* canvas → JPEG bytes（優先 toBlob，每個瀏覽器都有；沒有時退回 toDataURL）。 */
  function canvasToJpegBytes(canvas) {
    return new Promise(function (resolve, reject) {
      function fromDataUrl() {
        var dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        var comma = String(dataUrl).indexOf(",");
        resolve(base64ToBytes(String(dataUrl).slice(comma + 1)));
      }
      try {
        if (typeof canvas.toBlob !== "function") {
          fromDataUrl();
          return;
        }
        canvas.toBlob(
          function (blob) {
            if (!blob) {
              reject(new Error("canvas 轉 JPEG 失敗（toBlob 回傳空值）。"));
              return;
            }
            if (typeof blob.arrayBuffer === "function") {
              blob.arrayBuffer().then(function (buffer) {
                resolve(new Uint8Array(buffer));
              }, reject);
            } else {
              fromDataUrl();
            }
          },
          "image/jpeg",
          JPEG_QUALITY
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  /* canvas → PNG Blob（長圖用）。 */
  function canvasToPngBlob(canvas) {
    return new Promise(function (resolve, reject) {
      function fromDataUrl() {
        var dataUrl = canvas.toDataURL("image/png");
        resolve(base64ToBlob(String(dataUrl), "image/png"));
      }
      try {
        if (typeof canvas.toBlob !== "function") {
          fromDataUrl();
          return;
        }
        canvas.toBlob(function (blob) {
          if (!blob) {
            reject(new Error("canvas 轉 PNG 失敗（toBlob 回傳空值）。"));
            return;
          }
          resolve(blob);
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    });
  }

  function base64ToBlob(dataUrl, mime) {
    var comma = String(dataUrl).indexOf(",");
    var head = String(dataUrl).slice(0, comma);
    var bytes = base64ToBytes(String(dataUrl).slice(comma + 1));
    var type = mime;
    var match = /^data:([^;]+)/.exec(head);
    if (match && match[1]) type = match[1];
    return new Blob([bytes], { type: type });
  }

  /* 認圖片格式（用魔數，跟舊版 _image_ext_from_bytes 的規則一致），給 psz 的 cover.<ext>。 */
  function sniffImageExt(head) {
    if (!head || !head.length) return null;
    var at = function (offset) {
      return head.length > offset ? head[offset] : 0;
    };
    var ascii = function (start, end) {
      var text = "";
      for (var i = start; i < end && i < head.length; i++) {
        text += String.fromCharCode(head[i]);
      }
      return text;
    };

    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "png";
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "gif";
    if (at(0) === 0x42 && at(1) === 0x4d) return "bmp";
    if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
        at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
      return "webp";
    }
    if (ascii(4, 8) === "ftyp") {
      var brand = ascii(8, 12);
      if (brand === "avif" || brand === "avis") return "avif";
    }
    return null;
  }

  function readBlobHead(blob, length) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof blob.slice === "function" && typeof blob.slice(0, length).arrayBuffer === "function") {
          blob.slice(0, length).arrayBuffer().then(function (buffer) {
            resolve(new Uint8Array(buffer));
          }, reject);
          return;
        }
      } catch (err) {
        /* 繼續往下用 FileReader 回退 */
      }
      if (typeof FileReader === "undefined") {
        resolve(new Uint8Array(0));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var buffer = reader.result;
        resolve(new Uint8Array(buffer));
      };
      reader.onerror = function () {
        resolve(new Uint8Array(0));
      };
      reader.readAsArrayBuffer(blob.slice(0, length));
    });
  }

  /* 封面 Blob → { ext, blob }；型別不認得就當 jpg（舊版最後一層回退）。 */
  function normalizeCover(coverBlob) {
    return Promise.resolve().then(function () {
      if (!coverBlob) return null;
      var blob = null;
      if (typeof Blob !== "undefined" && coverBlob instanceof Blob) {
        blob = coverBlob;
      } else if (typeof coverBlob.arrayBuffer === "function") {
        blob = new Blob([coverBlob]);
      } else if (coverBlob && coverBlob.buffer && typeof coverBlob.byteLength === "number") {
        blob = new Blob([coverBlob]);
      }
      if (!blob || !blob.size) return null;
      return readBlobHead(blob, 16).then(function (head) {
        var ext =
          sniffImageExt(head) || (coverBlob.type && COVER_TYPES[coverBlob.type]) || "jpg";
        return { ext: ext, blob: blob };
      });
    });
  }

  /* --------------------------------------------------------------------------
   * buildScoreMeta(geometry, title) -> object | null
   *
   * geometry 來自 TabCapLayout.layoutPages()，座標是「px、y 軸向下」（y0 上沿、y1 下沿）。
   * 這裡換成 PDF 點 + y 軸向上：y0 = (pageHeight - 上沿) × 72/150（值大）、
   * y1 = (pageHeight - 下沿) × 72/150（值小）。
   *
   * 一行只有首尾兩條小節線（= 一行一小節）且沒有音訊時回 null —— 這份 systems/bars
   * 什麼都沒描述出來，PDF Score 自己認得比較準；呼叫端（exportPsz）就不放 score.json。
   * ------------------------------------------------------------------------ */
  function buildScoreMeta(geometry, title) {
    if (!geometry || typeof geometry !== "object") return null;

    var pageWidth = toFiniteNumber(geometry.pageWidth, 0);
    var pageHeight = toFiniteNumber(geometry.pageHeight, 0);
    if (!(pageWidth > 0) || !(pageHeight > 0)) return null;

    var geoPages = Array.isArray(geometry.pages) ? geometry.pages : [];
    if (!geoPages.length) return null;

    var hasBars = false;
    for (var p = 0; p < geoPages.length && !hasBars; p++) {
      var rows = geoPages[p];
      if (!Array.isArray(rows)) continue;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (row && Array.isArray(row.bars) && row.bars.length > 2) {
          hasBars = true;
          break;
        }
      }
    }
    if (!hasBars) return null;

    var pageWidthPt = pxToPt(pageWidth);
    var pageHeightPt = pxToPt(pageHeight);

    var pages = [];
    for (var pi = 0; pi < geoPages.length; pi++) {
      var pageRows = Array.isArray(geoPages[pi]) ? geoPages[pi] : [];
      var systems = [];
      for (var ri = 0; ri < pageRows.length; ri++) {
        var geoRow = pageRows[ri];
        if (!geoRow || typeof geoRow !== "object") continue;

        /* 取行上下沿：正常是 y0 = 上沿、y1 = 下沿（px、向下）；
         * 對調或舊版 {y, h} 形式都能吃，換算完一定 y0(上沿, 大) ≥ y1(下沿, 小)。 */
        var topPx;
        var bottomPx;
        if (geoRow.y0 !== undefined && geoRow.y1 !== undefined) {
          topPx = Math.min(toFiniteNumber(geoRow.y0, 0), toFiniteNumber(geoRow.y1, 0));
          bottomPx = Math.max(toFiniteNumber(geoRow.y0, 0), toFiniteNumber(geoRow.y1, 0));
        } else if (geoRow.y !== undefined) {
          topPx = toFiniteNumber(geoRow.y, 0);
          bottomPx = topPx + toFiniteNumber(geoRow.h, 0);
        } else {
          continue;
        }
        topPx = Math.max(0, Math.min(pageHeight, topPx));
        bottomPx = Math.max(topPx, Math.min(pageHeight, bottomPx));

        var y0 = pxToPt(pageHeight - topPx);
        var y1 = pxToPt(pageHeight - bottomPx);
        if (y0 < y1) {
          var tmpY = y0;
          y0 = y1;
          y1 = tmpY;
        }

        var rawBars = Array.isArray(geoRow.bars) ? geoRow.bars : [];
        var barXs = [];
        for (var b = 0; b < rawBars.length; b++) {
          var bx = toFiniteNumber(rawBars[b], NaN);
          if (!isFinite(bx)) continue;
          if (barXs.length && bx - barXs[barXs.length - 1] < 1) continue;
          barXs.push(bx);
        }

        var bars = [];
        for (var k = 0; k < barXs.length; k++) {
          var xPt = pxToPt(barXs[k]);
          var nextPt = k + 1 < barXs.length ? pxToPt(barXs[k + 1]) : xPt;
          bars.push({
            id: "br_" + (pi + 1) + "_" + (ri + 1) + "_" + (k + 1),
            /* PDF Score 認的是每條小節線的 x；x0/x1/y0/y1 是同一條線的邊界描述。 */
            x: xPt,
            x0: xPt,
            x1: nextPt,
            y0: y0,
            y1: y1
          });
        }

        systems.push({
          id: "sy_" + (pi + 1) + "_" + (ri + 1),
          y0: y0,
          y1: y1,
          bars: bars
        });
      }

      pages.push({
        width: pageWidthPt,
        height: pageHeightPt,
        systems: systems
      });
    }

    return {
      version: 1,
      title: typeof title === "string" ? title : "",
      tags: [],
      /* v1 沒有音訊檔在包裡：欄位照舊版格式留空，PDF Score 就不會去找音軌。 */
      audio: {
        name: "",
        type: "",
        duration: null,
        startOffset: 0,
        startPosition: 1
      },
      pages: pages,
      /* 空段落表：PDF Score 會補一條 120 BPM 4/4 的「開頭」段落（改不了速度資訊）。 */
      segments: [],
      jumps: []
    };
  }

  /* --------------------------------------------------------------------------
   * exportPdf(pageCanvases, opts) -> { blob, bytes }
   *
   * opts: { title, author, subject }
   * 每頁 canvas → JPEG(0.9) → PDFLib embedJpg；頁面尺寸 pt = px × 72 / 150。
   * ------------------------------------------------------------------------ */
  async function exportPdf(pageCanvases, opts) {
    var options = opts && typeof opts === "object" ? opts : {};
    var PDFLib = getPDFLib();
    var pages = collectCanvases(pageCanvases);
    if (!pages.length) {
      throw new Error("匯出 PDF 失敗：沒有可匯出的頁面。");
    }

    var title = typeof options.title === "string" ? options.title.trim() : "";

    var doc = await PDFLib.PDFDocument.create();
    doc.setTitle(title || "TabCap Lite");
    doc.setCreator("TabCap Lite");
    doc.setProducer("TabCap Lite");
    if (options.author) doc.setAuthor(String(options.author));
    if (options.subject) doc.setSubject(String(options.subject));

    for (var index = 0; index < pages.length; index++) {
      var canvas = pages[index];
      var widthPt = pxToPt(canvas.width);
      var heightPt = pxToPt(canvas.height);
      if (!(widthPt > 0) || !(heightPt > 0)) {
        throw new Error("匯出 PDF 失敗：第 " + (index + 1) + " 頁尺寸為 0。");
      }

      var jpgBytes;
      try {
        jpgBytes = await canvasToJpegBytes(canvas);
      } catch (err) {
        throw new Error(
          "匯出 PDF 失敗：第 " + (index + 1) +
            " 頁轉 JPEG 失敗（畫布可能來自跨網域圖片）。"
        );
      }

      var image = await doc.embedJpg(jpgBytes);
      var page = doc.addPage([widthPt, heightPt]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: widthPt,
        height: heightPt
      });
    }

    var bytes = await doc.save();
    return {
      blob: new Blob([bytes], { type: "application/pdf" }),
      bytes: bytes
    };
  }

  /* --------------------------------------------------------------------------
   * exportLongImage(pageCanvases) -> Blob（垂直拼接 PNG）
   * ------------------------------------------------------------------------ */
  function exportLongImage(pageCanvases) {
    return Promise.resolve().then(function () {
      var pages = collectCanvases(pageCanvases);
      if (!pages.length) {
        throw new Error("匯出長圖失敗：沒有可匯出的頁面。");
      }

      var maxWidth = 0;
      var rawHeight = 0;
      for (var i = 0; i < pages.length; i++) {
        maxWidth = Math.max(maxWidth, Math.round(pages[i].width));
        rawHeight += Math.round(pages[i].height);
      }
      if (maxWidth < 1 || rawHeight < 1) {
        throw new Error("匯出長圖失敗：頁面尺寸為 0。");
      }

      /* 超過畫布上限就等比縮（長圖是「看整份譜」用，縮一點不影響可讀性）。 */
      var scale = 1;
      if (rawHeight * scale > MAX_LONG_IMAGE_SIDE) scale = MAX_LONG_IMAGE_SIDE / rawHeight;
      var area = maxWidth * scale * (rawHeight * scale);
      if (area > MAX_LONG_IMAGE_AREA) scale *= Math.sqrt(MAX_LONG_IMAGE_AREA / area);

      var heights = [];
      var widths = [];
      var totalHeight = 0;
      for (var s = 0; s < 3; s++) {
        heights = [];
        widths = [];
        totalHeight = 0;
        for (var p = 0; p < pages.length; p++) {
          var h = Math.max(1, Math.round(pages[p].height * scale));
          heights.push(h);
          widths.push(Math.max(1, Math.round(pages[p].width * scale)));
          totalHeight += h;
        }
        if (totalHeight <= MAX_LONG_IMAGE_SIDE) break;
        scale *= MAX_LONG_IMAGE_SIDE / totalHeight;
      }

      var canvasWidth = 0;
      for (var w = 0; w < widths.length; w++) canvasWidth = Math.max(canvasWidth, widths[w]);

      var canvas = createCanvas(canvasWidth, totalHeight);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvasWidth, totalHeight);
      if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";

      var y = 0;
      for (var n = 0; n < pages.length; n++) {
        try {
          ctx.drawImage(pages[n], 0, y, widths[n], heights[n]);
        } catch (err) {
          /* 單頁壞掉不要讓整張長圖失敗 */
        }
        y += heights[n];
      }

      return canvasToPngBlob(canvas).catch(function () {
        throw new Error("匯出長圖失敗：canvas 轉 PNG 失敗（畫布可能來自跨網域圖片）。");
      });
    });
  }

  /* --------------------------------------------------------------------------
   * exportPsz({ pdfBytes, geometry, title, coverBlob? }) -> Blob
   *
   * 包結構（全部在根目錄，不可有子目錄）：
   *   score.pdf    正文（就是 exportPdf 的 bytes）
   *   score.json   由 buildScoreMeta 產生；回 null 時不放（每行一小節且無音訊）
   *   cover.<ext>  有給封面才放，副檔名用魔數認
   * ------------------------------------------------------------------------ */
  function exportPsz(payload) {
    return Promise.resolve().then(function () {
      var data = payload && typeof payload === "object" ? payload : {};
      var JSZip = getJSZip();

      var pdfSource = data.pdfBytes;
      var pdfPromise;
      if (pdfSource && typeof pdfSource.arrayBuffer === "function") {
        pdfPromise = pdfSource.arrayBuffer().then(function (buffer) {
          return new Uint8Array(buffer);
        });
      } else if (pdfSource instanceof ArrayBuffer) {
        pdfPromise = Promise.resolve(new Uint8Array(pdfSource));
      } else {
        pdfPromise = Promise.resolve(pdfSource);
      }

      return pdfPromise.then(function (pdfBytes) {
        if (!pdfBytes || typeof pdfBytes.length !== "number" || !pdfBytes.length) {
          throw new Error("匯出 psz 失敗：缺少 PDF 內容（pdfBytes 為空）。");
        }

        var zip = new JSZip();
        /* score.pdf 本身就是壓縮過的 PDF，用 STORE 不再浪費時間重壓。 */
        zip.file("score.pdf", pdfBytes, { binary: true, compression: "STORE" });

        var meta = buildScoreMeta(data.geometry, data.title);
        if (meta) {
          zip.file("score.json", JSON.stringify(meta, null, 2), { compression: "DEFLATE" });
        }

        return normalizeCover(data.coverBlob).then(function (cover) {
          if (cover) zip.file("cover." + cover.ext, cover.blob);

          return zip
            .generateAsync({
              type: "blob",
              mimeType: "application/zip",
              compression: "DEFLATE"
            })
            .then(function (blob) {
              return blob;
            });
        });
      });
    });
  }

  /* --------------------------------------------------------------------------
   * 對外 API（契約固定，不要改名字）
   * ------------------------------------------------------------------------ */
  global.TabCapExport = {
    exportPdf: exportPdf,
    exportLongImage: exportLongImage,
    exportPsz: exportPsz,
    buildScoreMeta: buildScoreMeta
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.TabCapExport;
  }
})(typeof window !== "undefined" ? window : globalThis);
