/* =============================================================================
 * js/layout.js — TabCapWeb 純前端排版引擎（A4 @150dpi，每張截圖一行）
 *
 * 用途
 *   把第 3 步處理好的圖片排成 A4 頁面（第 4 步即時預覽 + 匯出 PDF / 長圖 / psz 都用同一份
 *   排版結果）。原本是 Python 的 tab_extractor.build_pdf_from_images() 在做，現在整段搬到
 *   瀏覽器：算出每一頁、每一行圖片的落點，再畫成每頁 canvas。
 *
 * 為什麼這樣寫
 *   · 沒有後端 / npm / build step：純原生 JS + Canvas 2D，掛在 window.TabCapLayout。
 *   · v1 採契約指定的簡化模型「一張 Capture = 一行」：行寬 = 可用寬 × scale、依比例算行高，
 *     放大到放不下就換頁。比舊版「把小節線切成的豎條塞滿一整行」簡單得多，也讓
 *     psz 的小節線幾何（每行起點 / 終點 + 各小節線 x）有明確來源。
 *   · layoutPages() 一次回傳 { pages, geometry }：pages 給 renderPages 畫圖，
 *     geometry 給 export.js 的 buildScoreMeta 換算 score.json —— 排版只算一次，不在別處重算，
 *     否則 PDF 上的小節線與 score.json 會對不起來（舊版踩過的坑）。
 *   · 「150 DPI」是整個匯出鏈的換算基準：A4 直式 = 1240×1754 px，PDF 點數 = px × 72 / 150。
 *   · 標題用 canvas 內建系統字體（微軟雅黑 / 蘋方 / Noto CJK …），不載外部字型檔，
 *     所以中文標題在離線的 GitHub Pages 也能正常顯示。
 *   · 幾何一律記整數 px、y 軸向下（跟 canvas 一致），換成 PDF 座標是 export.js 的事。
 * ============================================================================= */
(function (global) {
  "use strict";

  /* A4 @150dpi（1240×1754）。直式用原值，橫式互換。 */
  var A4_WIDTH = 1240;
  var A4_HEIGHT = 1754;

  var DEFAULT_MARGIN = 40;
  var DEFAULT_SPACING = 25;
  var DEFAULT_SCALE = 1;

  /* 標題：字級 ≈ 頁寬 × 3.2%（1240px 頁寬 → 40px），1.35 倍行高；最小 12px。 */
  var TITLE_FONT_RATIO = 0.032;
  var TITLE_LINE_RATIO = 1.35;
  var TITLE_MIN_FONT = 12;

  var FONT_STACK =
    '"Microsoft YaHei", "PingFang TC", "Noto Sans CJK TC", "Heiti TC", ' +
    '"Hiragino Sans GB", system-ui, sans-serif';

  /* --------------------------------------------------------------------------
   * 小型工具
   * ------------------------------------------------------------------------ */

  function createCanvas(width, height) {
    if (typeof document === "undefined" || !document.createElement) {
      throw new Error("此環境沒有 Canvas，無法排版 / 預覽頁面。");
    }
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function toFiniteNumber(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function roundNumber(value) {
    return Math.max(0, Math.round(toFiniteNumber(value, 0)));
  }

  function clampNumber(value, min, max, fallback) {
    var n = Number(value);
    if (!isFinite(n)) n = fallback;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function normalizeColor(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  }

  function normalizeTitleLines(titleLines) {
    if (!Array.isArray(titleLines)) {
      if (typeof titleLines === "string") titleLines = titleLines.split(/\r?\n/);
      else return [];
    }
    var out = [];
    for (var i = 0; i < titleLines.length; i++) {
      var line = titleLines[i];
      if (typeof line !== "string") continue;
      line = line.trim();
      if (line) out.push(line);
    }
    return out;
  }

  /* 標題區塊的度量：字級 / 行高 / 預設保留高度。layoutPages 與 renderPages 共用同一份計算，
   * 才不會「排版留的空間」與「實際畫的位置」對不上。 */
  function computeTitleMetrics(pageWidth, titleLines, margin) {
    var lines = normalizeTitleLines(titleLines);
    if (!lines.length) {
      return { lines: [], fontPx: 0, lineHeight: 0, gap: 0, height: 0 };
    }
    var fontPx = Math.round(clampNumber(pageWidth * TITLE_FONT_RATIO, 16, 72, 40));
    var lineHeight = Math.round(fontPx * TITLE_LINE_RATIO);
    var gap = Math.max(8, Math.round(margin * 0.75)); /* 標題與內文之間的留白 */
    return {
      lines: lines,
      fontPx: fontPx,
      lineHeight: lineHeight,
      gap: gap,
      height: lines.length * lineHeight + gap
    };
  }

  /* 讀出 item 的圖片尺寸（item 可以是 { canvas, measures } 或直接是一個 canvas）。 */
  function readItem(item) {
    if (!item || typeof item !== "object") return null;
    var source = null;
    if (item.canvas && typeof item.canvas === "object" && item.canvas.width > 0) {
      source = item.canvas;
    } else if (typeof item.width === "number" && item.height > 0) {
      source = item;
    }
    if (!source) return null;
    var width = Math.round(toFiniteNumber(source.width, 0));
    var height = Math.round(toFiniteNumber(source.height, 0));
    if (width < 1 || height < 1) return null;
    return { canvas: source, width: width, height: height, measures: item.measures };
  }

  /* 一行的座標邊界：左邊界 → 各小節線 → 右邊界（整數 px、嚴格遞增）。
   * 這些就是 score.json 裡 systems.bars 的來源（舊版規則：行首尾兩條線都要標）。 */
  function buildRowBars(x, width, measures) {
    var left = Math.round(x);
    var right = Math.round(x + width);
    var points = [left];

    if (Array.isArray(measures)) {
      for (var i = 0; i < measures.length; i++) {
        var ratio = Number(measures[i]);
        if (!isFinite(ratio) || ratio <= 0 || ratio >= 1) continue;
        points.push(Math.round(x + ratio * width));
      }
    }
    points.push(right);
    points.sort(function (a, b) {
      return a - b;
    });

    var bars = [];
    for (var p = 0; p < points.length; p++) {
      if (!bars.length || points[p] - bars[bars.length - 1] >= 1) bars.push(points[p]);
    }
    if (!bars.length) return [left, Math.max(left + 1, right)];
    /* 保證右邊界一定要在（最後一小節會用到它） */
    bars[bars.length - 1] = right;
    if (bars.length === 1) bars.push(right + 1);
    return bars;
  }

  /* --------------------------------------------------------------------------
   * layoutPages(items, opts) -> { pages, geometry }
   *
   * opts: { margin, spacing, scale, orientation, align, valign,
   *         titleLines, titleHeight, bgColor, textColor }
   *
   * pages[]  : { width, height, rows: [{ x, y, w, h, canvas }] }      px
   * geometry : { pageWidth, pageHeight, pages: [[{ y0, y1, bars }]] } px
   *            y0 = 行上沿、y1 = 行下沿（都從頁面頂端往下量；export.js 會轉成
   *            PDF 點數與 y 軸向上的座標）。bars = 該行左邊界 → ... → 右邊界。
   * ------------------------------------------------------------------------ */
  function layoutPages(items, opts) {
    var options = opts && typeof opts === "object" ? opts : {};
    var margin = Math.round(clampNumber(options.margin, 0, 600, DEFAULT_MARGIN));
    var spacing = Math.round(clampNumber(options.spacing, 0, 600, DEFAULT_SPACING));
    var scale = clampNumber(options.scale, 0.05, 10, DEFAULT_SCALE);
    var orientation = options.orientation === "landscape" ? "landscape" : "portrait";
    var align =
      options.align === "center" || options.align === "right" ? options.align : "left";
    var valign =
      options.valign === "center" || options.valign === "bottom" ? options.valign : "top";
    var textColor = normalizeColor(options.textColor, "#111111");

    var pageWidth = orientation === "landscape" ? A4_HEIGHT : A4_WIDTH;
    var pageHeight = orientation === "landscape" ? A4_WIDTH : A4_HEIGHT;

    var titleLines = normalizeTitleLines(options.titleLines);
    var titleMetrics = computeTitleMetrics(pageWidth, titleLines, margin);
    var titleHeight = 0;
    if (titleLines.length) {
      titleHeight =
        options.titleHeight === undefined || options.titleHeight === null
          ? titleMetrics.height
          : Math.max(0, roundNumber(options.titleHeight));
    }

    var contentWidth = pageWidth - 2 * margin;
    var usableHeight = pageHeight - 2 * margin;
    if (contentWidth < 8 || usableHeight < 8) {
      throw new Error("排版失敗：邊距（margin）太大，頁面沒有可用空間。");
    }
    var bottomLimit = pageHeight - margin;

    var pages = [];
    var geometryPages = [];
    var currentY = 0;

    function startPage() {
      var index = pages.length;
      var page = {
        width: pageWidth,
        height: pageHeight,
        margin: margin,
        titleHeight: index === 0 ? titleHeight : 0,
        rows: []
      };
      if (index === 0 && titleLines.length) page.titleLines = titleLines.slice();
      pages.push(page);
      geometryPages.push([]);
      currentY = margin + page.titleHeight;
    }

    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var entry = readItem(list[i]);
      if (!entry) continue; /* 防禦：壞掉的項目直接跳過，不要讓整個排版爆掉 */

      /* 行寬 = 可用寬 × scale；行高依原圖比例。 */
      var rowWidth = Math.max(1, Math.round(contentWidth * scale));
      var rowHeight = Math.max(1, Math.round(entry.height * (rowWidth / entry.width)));

      /* 單行比一整頁可用高度還高（超長條截圖）→ 等比縮到放得下一整頁，避免無限換頁。 */
      if (rowHeight > usableHeight) {
        var shrink = usableHeight / rowHeight;
        rowHeight = Math.max(1, Math.floor(rowHeight * shrink));
        rowWidth = Math.max(1, Math.round(rowWidth * shrink));
      }

      if (!pages.length) startPage();
      var page = pages[pages.length - 1];

      if (currentY + rowHeight > bottomLimit) {
        /* 目前頁已有內容 → 換頁；第一頁只有標題也放不下這一行的話，也換到下一頁。 */
        startPage();
        page = pages[pages.length - 1];
        /* 保險：理論上不會再塞不下，還是塞不下就等比縮到剩餘高度。 */
        if (currentY + rowHeight > bottomLimit) {
          var available = Math.max(1, bottomLimit - currentY);
          var fit = Math.min(1, available / rowHeight);
          rowHeight = Math.max(1, Math.floor(rowHeight * fit));
          rowWidth = Math.max(1, Math.round(rowWidth * fit));
        }
      }

      /* 水平對齊：left / center / right（依可用寬，不是頁寬）。 */
      var x = margin;
      if (align === "center") x = margin + Math.round((contentWidth - rowWidth) / 2);
      else if (align === "right") x = margin + (contentWidth - rowWidth);

      /* v1 一行只有一張圖，行高就等於圖片高 → valign 在行內沒有位移空間；
       * 真正的 valign 效果在下方「整頁剩餘空間的垂直分佈」處理。 */
      var row = {
        x: x,
        y: currentY,
        w: rowWidth,
        h: rowHeight,
        canvas: entry.canvas
      };
      page.rows.push(row);
      geometryPages[geometryPages.length - 1].push({
        y0: row.y,
        y1: row.y + row.h,
        bars: buildRowBars(row.x, row.w, entry.measures)
      });

      currentY += rowHeight + spacing;
    }

    /* valign：把每頁內容在「頁面可用高度」內重新分佈（top 不動、center 置中、bottom 貼底）。
     * 一般只有最後一頁會有剩餘空間；geometry 同步位移，psz 才不會錯位。 */
    if (valign !== "top") {
      for (var p = 0; p < pages.length; p++) {
        var rows = pages[p].rows;
        if (!rows.length) continue;
        var lastRow = rows[rows.length - 1];
        var leftover = bottomLimit - (lastRow.y + lastRow.h);
        if (leftover <= 0) continue;
        var shift = valign === "center" ? Math.round(leftover / 2) : leftover;
        if (!shift) continue;
        for (var r = 0; r < rows.length; r++) rows[r].y += shift;
        var geoRows = geometryPages[p];
        for (var g = 0; g < geoRows.length; g++) {
          geoRows[g].y0 += shift;
          geoRows[g].y1 += shift;
        }
      }
    }

    /* 附帶一點預覽會用到的資訊（契約沒禁止，app.js 若不需要可忽略）。 */
    var geometry = {
      pageWidth: pageWidth,
      pageHeight: pageHeight,
      pages: geometryPages
    };

    return { pages: pages, geometry: geometry, textColor: textColor };
  }

  /* 把文字截斷到指定寬度（還是太寬就加省略號）。 */
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var chars = text.split("");
    var clipped = chars.slice();
    while (clipped.length > 1) {
      clipped.pop();
      if (ctx.measureText(clipped.join("") + "…").width <= maxWidth) {
        return clipped.join("") + "…";
      }
    }
    return "…";
  }

  function drawTitle(ctx, pageWidth, margin, lines, reservedHeight, textColor, titleAlign) {
    var metrics = computeTitleMetrics(pageWidth, lines, margin);
    if (!metrics.lines.length) return;

    var contentWidth = pageWidth - 2 * margin;
    var lineHeight = metrics.lineHeight;
    if (reservedHeight > 0 && lines.length * lineHeight > reservedHeight) {
      lineHeight = Math.max(10, Math.floor(reservedHeight / lines.length));
    }

    var size = metrics.fontPx;
    ctx.fillStyle = textColor;
    ctx.font = "600 " + size + "px " + FONT_STACK;
    while (size > TITLE_MIN_FONT) {
      var tooWide = false;
      for (var c = 0; c < metrics.lines.length; c++) {
        if (ctx.measureText(metrics.lines[c]).width > contentWidth) {
          tooWide = true;
          break;
        }
      }
      if (!tooWide) break;
      size -= 2;
      ctx.font = "600 " + Math.max(TITLE_MIN_FONT, size) + "px " + FONT_STACK;
    }

    var align = titleAlign === "left" || titleAlign === "right" ? titleAlign : "center";
    ctx.textAlign = align;
    ctx.textBaseline = "top";
    var x = margin;
    if (align === "center") x = pageWidth / 2;
    else if (align === "right") x = pageWidth - margin;

    for (var i = 0; i < metrics.lines.length; i++) {
      ctx.fillText(
        fitText(ctx, metrics.lines[i], contentWidth),
        x,
        margin + i * lineHeight
      );
    }
  }

  /* --------------------------------------------------------------------------
   * renderPages(pages, opts) -> HTMLCanvasElement[]
   *
   * opts: { titleLines, titleAlign, bgColor, textColor, margin, titleHeight,
   *         items, pageNumbers }
   *   · 背景色、每行圖片（依 rows 的 x/y/w/h 縮放繪製）、第一頁標題（系統中文字體）。
   *   · pages 的 rows 內已帶 canvas；若外部自己組 pages，可用 opts.items 依序對應。
   * ------------------------------------------------------------------------ */
  function renderPages(pages, opts) {
    var options = opts && typeof opts === "object" ? opts : {};
    if (!Array.isArray(pages)) return [];

    var bgColor = normalizeColor(options.bgColor, "#ffffff");
    var textColor = normalizeColor(options.textColor, "#111111");
    var fallbackItems = Array.isArray(options.items) ? options.items : [];
    var fallbackIndex = 0;
    var out = [];

    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      if (!page || typeof page !== "object") continue;

      var pageWidth = Math.max(1, Math.round(toFiniteNumber(page.width, A4_WIDTH)));
      var pageHeight = Math.max(1, Math.round(toFiniteNumber(page.height, A4_HEIGHT)));
      var margin = Math.round(
        clampNumber(
          options.margin !== undefined ? options.margin : page.margin,
          0,
          600,
          DEFAULT_MARGIN
        )
      );

      var canvas = createCanvas(pageWidth, pageHeight);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, pageWidth, pageHeight);

      /* 第一頁標題 */
      if (p === 0) {
        var lines = normalizeTitleLines(
          options.titleLines !== undefined ? options.titleLines : page.titleLines
        );
        if (lines.length) {
          var reserved = toFiniteNumber(
            options.titleHeight !== undefined ? options.titleHeight : page.titleHeight,
            0
          );
          drawTitle(ctx, pageWidth, margin, lines, reserved, textColor, options.titleAlign);
        }
      }

      /* 每行圖片 */
      var rows = Array.isArray(page.rows) ? page.rows : [];
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (!row || typeof row !== "object") continue;

        var source = row.canvas || row.img || row.image || null;
        if (!source && fallbackItems.length) {
          var item = fallbackItems[fallbackIndex];
          if (item && typeof item === "object") source = item.canvas || item;
        }
        fallbackIndex += 1;
        if (!source || typeof ctx.drawImage !== "function") continue;

        var x = toFiniteNumber(row.x, 0);
        var y = toFiniteNumber(row.y, 0);
        var w = Math.max(1, toFiniteNumber(row.w, 1));
        var h = Math.max(1, toFiniteNumber(row.h, 1));
        try {
          if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
          if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
          ctx.drawImage(source, x, y, w, h);
        } catch (err) {
          /* 壞掉的圖片不要讓整頁預覽掛掉，跳過即可。 */
        }
      }

      /* 頁碼（預設不畫；舊版 PDF 有，需要時由 opts.pageNumbers 開啟）。 */
      if (options.pageNumbers) {
        var fontPx = Math.max(12, Math.round(pageWidth * 0.018));
        ctx.fillStyle = textColor;
        ctx.font = fontPx + "px " + FONT_STACK;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(
          String(p + 1) + " / " + String(pages.length),
          pageWidth / 2,
          pageHeight - Math.max(4, Math.round(margin / 2))
        );
      }

      out.push(canvas);
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * 對外 API（契約固定，不要改名字）
   * ------------------------------------------------------------------------ */
  global.TabCapLayout = {
    layoutPages: layoutPages,
    renderPages: renderPages
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.TabCapLayout;
  }
})(typeof window !== "undefined" ? window : globalThis);
