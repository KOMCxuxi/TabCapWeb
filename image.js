/* =============================================================================
 * js/image.js — TabCapWeb 純前端影像處理（裁切 / 工作寬度縮放 / 小節線偵測 / 二值化反色）
 *
 * 用途
 *   這是第 3 步「調整」與第 4 步「排版」最前面的影像處理，原本由 Python + OpenCV 後端
 *   （tab_extractor.py / app.py 的 /api/detect_measures）負責：裁切、縮到工作寬度、
 *   抓小節線、二值化 / 反色。這個檔把同一批工作搬到瀏覽器的 Canvas 2D 上做。
 *
 * 為什麼這樣寫
 *   · 沒有後端、沒有 npm、不能有 build step：純原生 JS + Canvas 2D，掛在 window.TabCapImage。
 *   · 不依賴 app.js 或頁面上任何 DOM 元素（只 createElement('canvas')），所以測試頁可以單獨
 *     載入；錯誤訊息一律繁體中文。
 *   · 小節線偵測不搬 OpenCV 形態學（前端沒有、也不該為此引入函式庫），改用
 *     「灰階 → 列投影找譜線 → 把譜線分群成譜表帶 → 帶內欄投影找暗像素比例高的直線」的簡化版。
 *     重點是「寧可回 []，不要亂猜」：找不到就由 UI 讓使用者手動點小節線。
 *   · 灰階與投影全部用 TypedArray 手算、只做 1~2 次 getImageData，2000px 寬的截圖也很快。
 *   · 縮圖統一走 toWorkingCanvas(canvas, 1600)：後續排版／匯出都吃工作寬度，
 *     避免把 4K 截圖原樣塞進頁面 canvas 造成記憶體爆掉。
 * ============================================================================= */
(function (global) {
  "use strict";

  /* 偵測時的工作寬度：再寬也只是浪費 CPU，小節線位置用比例表示，精度足夠。 */
  var MAX_DETECT_WIDTH = 1200;

  /* 墨跡（暗像素）閾值：沿用舊版 tab_extractor 的 ink_threshold = 150。 */
  var INK_THRESHOLD = 150;

  /* 二值化的預設亮度閾值（0..255）。 */
  var DEFAULT_THRESHOLD = 150;

  /* 列投影中「暗像素佔全寬比例」達到這個值 → 視為譜線所在列。 */
  var STAFF_ROW_RATIO = 0.3;

  /* 譜表帶太窄就當作沒偵測到（例如只抓到一條雜線）。 */
  var MIN_BAND_HEIGHT = 6;

  /* 欄投影「暗像素佔帶高比例」的候選門檻：由嚴到鬆依序嘗試，先找到的先贏。 */
  var BARLINE_RATIOS = [0.85, 0.65, 0.45];

  /* 排除圖片最左 / 最右的比例（契約要求「不含邊界」）。 */
  var EDGE_MARGIN_RATIO = 0.03;

  /* 譜線分群門檻：相鄰譜線間距超過「中位間距 × 這個倍數」就視為不同譜表（system）。 */
  var SYSTEM_GAP_FACTOR = 2.5;

  /* --------------------------------------------------------------------------
   * 小型工具
   * ------------------------------------------------------------------------ */

  function createCanvas(width, height) {
    if (typeof document === "undefined" || !document.createElement) {
      throw new Error("此環境沒有 Canvas，無法處理影像。");
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
      typeof value.height === "number" &&
      typeof value.getContext === "function" &&
      value.width > 0 &&
      value.height > 0
    );
  }

  function assertCanvas(canvas, fnName) {
    if (!isCanvasLike(canvas)) {
      throw new Error(fnName + "：缺少有效的 canvas（需要非空的 HTMLCanvasElement）。");
    }
  }

  function clampNumber(value, min, max, fallback) {
    var n = Number(value);
    if (!isFinite(n)) n = fallback;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /* 把任意字串 / 非字串顏色整理成 CSS 可用的顏色；不合法就回退。 */
  function normalizeColor(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  }

  /* 正規化裁切框：一律夾在 0..1、必要時對調左右 / 上下。 */
  function normalizeCrop(crop) {
    var l = 0,
      r = 1,
      t = 0,
      b = 1;
    if (crop && typeof crop === "object") {
      l = clampNumber(crop.l, 0, 1, 0);
      r = clampNumber(crop.r, 0, 1, 1);
      t = clampNumber(crop.t, 0, 1, 0);
      b = clampNumber(crop.b, 0, 1, 1);
      if (l > r) {
        var tmpX = l;
        l = r;
        r = tmpX;
      }
      if (t > b) {
        var tmpY = t;
        t = b;
        b = tmpY;
      }
    }
    return { l: l, r: r, t: t, b: b };
  }

  /* --------------------------------------------------------------------------
   * cropCanvas：正規化裁切（至少 1px）
   * ------------------------------------------------------------------------ */
  function cropCanvas(canvas, crop) {
    assertCanvas(canvas, "cropCanvas");
    var imgW = Math.round(canvas.width);
    var imgH = Math.round(canvas.height);
    if (imgW < 1 || imgH < 1) {
      throw new Error("cropCanvas：來源畫布尺寸為 0，無法裁切。");
    }

    var box = normalizeCrop(crop);
    var x0 = clampNumber(Math.round(imgW * box.l), 0, imgW - 1, 0);
    var x1 = clampNumber(Math.round(imgW * box.r), 0, imgW, imgW);
    var y0 = clampNumber(Math.round(imgH * box.t), 0, imgH - 1, 0);
    var y1 = clampNumber(Math.round(imgH * box.b), 0, imgH, imgH);

    /* 最小 1px：比例極端（例如整張圖只有 1 列）時仍要生出一張可用的圖。 */
    if (x1 <= x0) {
      x1 = Math.min(imgW, x0 + 1);
      x0 = Math.min(x0, x1 - 1);
    }
    if (y1 <= y0) {
      y1 = Math.min(imgH, y0 + 1);
      y0 = Math.min(y0, y1 - 1);
    }

    var outW = Math.max(1, x1 - x0);
    var outH = Math.max(1, y1 - y0);
    var out = createCanvas(outW, outH);
    var ctx = out.getContext("2d");
    try {
      ctx.drawImage(canvas, x0, y0, outW, outH, 0, 0, outW, outH);
    } catch (err) {
      throw new Error("cropCanvas：裁切失敗，畫布內容無法讀取（可能來自跨網域圖片）。");
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * toWorkingCanvas：等比縮小到工作寬度
   *
   * 回傳 { canvas, scale }；scale 是「實際套用的比例」（新寬 / 原寬），
   * 原本就比 maxWidth 窄時回傳同一個 canvas 物件、scale = 1（不浪費一次重繪）。
   * ------------------------------------------------------------------------ */
  function toWorkingCanvas(canvas, maxWidth) {
    assertCanvas(canvas, "toWorkingCanvas");
    var target = Math.round(Number(maxWidth));
    if (!isFinite(target) || target < 1) target = 1600;

    var srcW = Math.round(canvas.width);
    var srcH = Math.round(canvas.height);
    if (srcW <= target) return { canvas: canvas, scale: 1 };

    var scale = target / srcW;
    var outW = Math.max(1, Math.round(srcW * scale));
    var outH = Math.max(1, Math.round(srcH * scale));
    var out = createCanvas(outW, outH);
    var ctx = out.getContext("2d");
    if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(canvas, 0, 0, srcW, srcH, 0, 0, outW, outH);
    } catch (err) {
      throw new Error("toWorkingCanvas：縮圖失敗，畫布內容無法讀取（可能來自跨網域圖片）。");
    }
    return { canvas: out, scale: outW / srcW };
  }

  /* --------------------------------------------------------------------------
   * 灰階讀取（含深色背景自動反轉）
   *
   * 回傳 { gray: Uint8Array, width, height }；gray 的值是亮度 0..255，
   * 且保證「背景亮、線條暗」（整體偏暗的圖先反轉），後面的投影才不用分兩種情況。
   * ------------------------------------------------------------------------ */
  function readGray(canvas, maxWidth) {
    var srcW = Math.round(canvas.width);
    var srcH = Math.round(canvas.height);
    var work = canvas;
    var w = srcW;
    var h = srcH;

    if (srcW > maxWidth) {
      var k = maxWidth / srcW;
      w = Math.max(1, Math.round(maxWidth));
      h = Math.max(1, Math.round(srcH * k));
      work = createCanvas(w, h);
      var reduceCtx = work.getContext("2d");
      if ("imageSmoothingEnabled" in reduceCtx) reduceCtx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in reduceCtx) reduceCtx.imageSmoothingQuality = "high";
      try {
        reduceCtx.drawImage(canvas, 0, 0, srcW, srcH, 0, 0, w, h);
      } catch (err) {
        throw new Error("偵測小節線失敗：無法讀取畫布內容（可能來自跨網域圖片）。");
      }
    }

    var pixels;
    try {
      pixels = work.getContext("2d").getImageData(0, 0, w, h);
    } catch (err) {
      /* 跨網域圖片會讓 canvas 變成 tainted，getImageData 直接丟 SecurityError。 */
      throw new Error("偵測小節線失敗：無法讀取畫布像素（可能來自跨網域圖片）。");
    }

    var data = pixels.data;
    var gray = new Uint8Array(w * h);
    var total = 0;
    for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
      var lum;
      if (data[p + 3] < 16) {
        lum = 255; /* 透明視為白底 */
      } else {
        lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114 + 500) / 1000 | 0;
      }
      gray[i] = lum;
      total += lum;
    }

    var mean = total / gray.length;
    if (mean < 128) {
      for (var j = 0; j < gray.length; j++) gray[j] = 255 - gray[j];
    }
    return { gray: gray, width: w, height: h };
  }

  /* 把連續的譜線列合併成一條「譜線」，回傳 [{ start, end }]（含頭含尾）。 */
  function groupStaffRows(rows) {
    var lines = [];
    var current = null;
    for (var i = 0; i < rows.length; i++) {
      var y = rows[i];
      if (current && y - current.end <= 1) {
        current.end = y;
      } else {
        current = { start: y, end: y };
        lines.push(current);
      }
    }
    return lines;
  }

  /* 把譜線依間距分群成「譜表帶」（一個系統可能有 5 條線，兩系統之間間距更大）。 */
  function groupStaffLines(lines) {
    if (lines.length < 2) return [lines];

    var gaps = [];
    for (var i = 1; i < lines.length; i++) gaps.push(lines[i].start - lines[i - 1].start);
    var sorted = gaps.slice().sort(function (a, b) {
      return a - b;
    });
    var median = sorted[Math.floor(sorted.length / 2)] || 1;
    var threshold = Math.max(median * SYSTEM_GAP_FACTOR, median + 2);

    var groups = [[lines[0]]];
    for (var j = 1; j < lines.length; j++) {
      if (lines[j].start - lines[j - 1].start > threshold) groups.push([]);
      groups[groups.length - 1].push(lines[j]);
    }
    return groups;
  }

  /* 在一個譜表帶 [top, bottom] 內用欄投影找小節線，回傳像素 x 中心（升序）。 */
  function findBarlinesInBand(gray, width, top, bottom) {
    var bandHeight = bottom - top + 1;
    if (bandHeight < MIN_BAND_HEIGHT) return [];

    var ratios = new Float32Array(width);
    for (var x = 0; x < width; x++) {
      var dark = 0;
      var offset = top * width + x;
      for (var y = top; y <= bottom; y++, offset += width) {
        if (gray[offset] < INK_THRESHOLD) dark++;
      }
      ratios[x] = dark / bandHeight;
    }

    var mergeGap = Math.max(1, Math.round(width * 0.004));
    for (var r = 0; r < BARLINE_RATIOS.length; r++) {
      var span = BARLINE_RATIOS[r];
      var centers = [];
      var runStart = -1;
      var runEnd = -1;
      for (var col = 0; col < width; col++) {
        if (ratios[col] >= span) {
          if (runStart < 0) {
            runStart = col;
            runEnd = col;
          } else if (col - runEnd <= mergeGap) {
            runEnd = col;
          } else {
            centers.push(Math.round((runStart + runEnd) / 2));
            runStart = col;
            runEnd = col;
          }
        }
      }
      if (runStart >= 0) centers.push(Math.round((runStart + runEnd) / 2));
      if (centers.length) return centers;
    }
    return [];
  }

  /* --------------------------------------------------------------------------
   * detectMeasures：回傳正規化小節線 x（0..1、遞增、不含 0/1）；找不到回 []
   *
   * 流程（契約要求）：
   *   灰階 → 列投影找譜線（暗像素佔全寬比例高的列）→ 譜線帶 → 帶內欄投影找小節線
   *   （暗像素佔帶高比例高者）→ 排除左右邊界 → 正規化成 0..1。
   * ------------------------------------------------------------------------ */
  function detectMeasures(canvas) {
    assertCanvas(canvas, "detectMeasures");

    var srcW = Math.round(canvas.width);
    var srcH = Math.round(canvas.height);
    if (srcW < 8 || srcH < 8) return [];

    /* 1) 灰階（必要時縮到偵測寬度） */
    var prepared = readGray(canvas, MAX_DETECT_WIDTH);
    var width = prepared.width;
    var height = prepared.height;
    var gray = prepared.gray;
    if (width < 8 || height < 8) return [];

    /* 2) 列投影：找出譜線所在列 */
    var staffRows = [];
    for (var y = 0; y < height; y++) {
      var dark = 0;
      var offset = y * width;
      for (var x = 0; x < width; x++) {
        if (gray[offset + x] < INK_THRESHOLD) dark++;
      }
      if (dark / width >= STAFF_ROW_RATIO) staffRows.push(y);
    }
    if (staffRows.length < 2) return [];

    var lines = groupStaffRows(staffRows);
    if (!lines.length) return [];

    /* 3) 譜線分群成譜表帶，逐帶找小節線（單譜表與多譜表頁面都適用） */
    var groups = groupStaffLines(lines);
    var centers = [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (!group.length) continue;
      var top = group[0].start;
      var bottom = group[group.length - 1].end;
      var found = findBarlinesInBand(gray, width, top, bottom);
      for (var f = 0; f < found.length; f++) centers.push(found[f]);
    }
    if (!centers.length) return [];

    /* 4) 排序、合併過近的重複（不同譜表帶常常抓到同一條對齊的小節線）、排除邊界 */
    centers.sort(function (a, b) {
      return a - b;
    });
    var minX = width * EDGE_MARGIN_RATIO;
    var maxX = width * (1 - EDGE_MARGIN_RATIO);
    var minGap = Math.max(2, width * 0.002);

    var measures = [];
    var last = -Infinity;
    for (var c = 0; c < centers.length; c++) {
      var px = centers[c];
      if (px < minX || px > maxX) continue;
      if (px - last < minGap) continue;
      var normalized = (px + 0.5) / width;
      if (normalized <= 0 || normalized >= 1) continue;
      measures.push(Math.round(normalized * 100000) / 100000);
      last = px;
    }
    return measures;
  }

  /* --------------------------------------------------------------------------
   * drawPrepared：先二值化（白底黑線）再可選反色
   *
   * opts: { binarize, invert, bgColor, threshold }
   *   binarize  把亮度 < threshold 的像素變黑、其餘變白（透明視為白底）
   *   invert    整張反色（在 binarize 之後）
   *   bgColor   輸出畫布先填的底色（來源有透明區域時看得出來）
   *   threshold 0..255，預設 150（沿用舊版墨跡閾值）
   * ------------------------------------------------------------------------ */
  function drawPrepared(canvas, opts) {
    assertCanvas(canvas, "drawPrepared");
    var options = opts && typeof opts === "object" ? opts : {};
    var binarize = !!options.binarize;
    var invert = !!options.invert;
    var bgColor = normalizeColor(options.bgColor, "#ffffff");
    var threshold = Math.round(clampNumber(options.threshold, 0, 255, DEFAULT_THRESHOLD));

    var width = Math.round(canvas.width);
    var height = Math.round(canvas.height);
    var out = createCanvas(width, height);
    var ctx = out.getContext("2d");

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    try {
      ctx.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
    } catch (err) {
      throw new Error("drawPrepared：無法繪製來源畫布（可能來自跨網域圖片）。");
    }

    /* 不需要逐像素處理時就直接回傳（保留原圖，避免白做一次 1600×900 的迴圈）。 */
    if (!binarize && !invert) return out;

    var imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (err) {
      throw new Error("drawPrepared：無法讀取畫布像素（可能來自跨網域圖片）。");
    }

    var data = imageData.data;
    for (var i = 0; i < data.length; i += 4) {
      if (binarize) {
        var lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000 | 0;
        var v = lum < threshold ? 0 : 255;
        if (invert) v = 255 - v;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      } else if (invert) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return out;
  }

  /* --------------------------------------------------------------------------
   * 對外 API（契約固定，不要改名字）
   * ------------------------------------------------------------------------ */
  global.TabCapImage = {
    cropCanvas: cropCanvas,
    toWorkingCanvas: toWorkingCanvas,
    detectMeasures: detectMeasures,
    drawPrepared: drawPrepared
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.TabCapImage;
  }
})(typeof window !== "undefined" ? window : globalThis);
