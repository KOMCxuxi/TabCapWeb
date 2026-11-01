/*!
 * TabCapWeb · js/capture.js — 純前端抽幀 + 去重引擎
 * -----------------------------------------------------------------------------
 * 用途：
 *   sampleVideo  本地影片按「每 N 秒」seek 抽幀（可取消 / 有進度 / 有上限保護）
 *   sampleLive   螢幕或分頁的即時串流按真實時間取樣（不 seek）
 *   dedupe       從一堆幀裡挑掉「內容一樣」的幀，只留換行/換頁後的新畫面
 *   framesToCaptures  把 Frame[] 轉成 app.js 要的 Capture[]（PNG blob + object URL）
 *
 * 為什麼這樣做（演算法移植自 TabCap 伺服器版 tab_extractor.extract_unique_crops）：
 * 1. 譜面影片每秒都在變的只有「播放頭 / 正在響的音符」與「卷動」，
 *    對制譜的人來說，只有「換行（換小節）」之後的畫面才值得留一張 →
 *    所以去重是這個工具的核心價值，不是可有可無的最佳化。
 * 2. 播放頭（那種淡藍/淡綠色直條）本身每幀都不同，會讓「同一行」被判成不同畫面。
 *    伺服器版是偵測那個特定顏色；純前端版改成契約要求的做法：
 *    **對相鄰幀做逐列差異，找出差異集中的垂直條帶，比較時把條帶忽略**。
 *    這樣不綁定播放頭顏色，深色/淺色主題都能用。
 * 3. 比較用的是「二值化後的譜面像素差比例」：先灰階 → 亮度 < 185 視為譜面(1)、
 *    其餘當背景(0)（與伺服器版 normalize_tab_for_hash 的 185 一致），
 *    再算「忽略條帶後，有多少比例的像素不一樣」。
 *    diffThreshold = 0.01 代表「只有 1% 以上譜面像素變了才算新畫面」。
 *    用二值化而不是原始灰階平均差，是因為影片壓縮雜訊會讓整張圖都有一點點差異，
 *    原始灰階差會把「完全同一行」誤判成新畫面（伺服器版踩過這個坑）。
 * 4. 全黑/全白/幾乎單色幀（載入中、廣告黑屏、轉場白閃）直接跳過，避免佔用截圖額度。
 * 5. 速度：工作解析度固定寬 480 的灰階縮圖，一幀的比較成本 ≈ 480×270 次整數比較，
 *    200 幀目標 < 3 秒（實測見回報）。dedupe 是同步函式（契約如此），
 *    所以不需要 / 也不會 yield 給事件迴圈。
 * 6. 防禦性：所有參數都會被夾到合法範圍、錯誤訊息繁體中文、
 *    不依賴 app.js 的 state 與任何 UI DOM（只借用 media.js 取幀）。
 *
 * 對外 API（契約見 CONTRACT.md）：
 *   TabCapCapture.sampleVideo(source, params, { onProgress, shouldStop }) -> Frame[]
 *   TabCapCapture.sampleLive(source, params, { onProgress, shouldStop })  -> Frame[]
 *   TabCapCapture.dedupe(frames, params, { onProgress }) -> { kept, stats }
 *   TabCapCapture.framesToCaptures(frames) -> Capture[]
 */
(function (global) {
  "use strict";

  var API_VERSION = "1.0.0";

  var MAX_SAMPLE_FRAMES = 2000; // 抽幀上限保護（契約要求）
  var MIN_SAMPLE_EVERY = 0.05; // 即時取樣的間隔下限（秒），避免把主執行緒塞爆
  var WORK_WIDTH = 480; // dedupe 工作解析度（契約：縮成灰階、寬 ~480）
  // 抽幀用的最大寬度：伺服器版會把每張裁圖寫到磁碟，瀏覽器只能留在記憶體
  // （每張 canvas ≈ w×h×4 bytes），所以預設就縮到 PDF 版面真正需要的尺寸
  // （A4@150dpi 可用寬約 1160px），需要更高畫質時可由 params.maxWidth 調大。
  var DEFAULT_FRAME_MAX_WIDTH = 1280;
  var FRAME_MEMORY_BUDGET_BYTES = 900 * 1024 * 1024; // 超過就先自動降解析度
  var MIN_AUTO_FRAME_WIDTH = 640; // 自動降解析度的下限（再低就沒意義了）
  var MAX_FRAME_MEMORY_BYTES = 1.5 * 1024 * 1024 * 1024; // 連降完都超過 → 直接報錯，別讓瀏覽器 crash
  var INK_THRESHOLD = 185; // 亮度 < 185 視為譜面（沿用伺服器版）
  var BLANK_STD = 8.0; // 灰階標準差 < 8 視為幾乎單色（沿用伺服器版）
  var BAND_MIN_PEAK = 4.0; // 條帶偵測門檻：峰值欄位平均差異至少 4 個灰階
  var BAND_PEAK_RATIO = 2.0; // 峰值至少是全部欄位平均的 2 倍，才算「集中」
  var MAX_CONSECUTIVE_ERRORS = 3; // 連續抽幀失敗幾次才放棄
  var YIELD_EVERY = 8; // 每抽 8 幀讓出一次主執行緒（讓進度條有機會重繪）

  function nowMs() {
    return global.performance && typeof global.performance.now === "function"
      ? global.performance.now()
      : Date.now();
  }

  function toNumber(value, fallback) {
    var n = typeof value === "number" ? value : parseFloat(value);
    return isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function round3(value) {
    return Math.round(value * 1000) / 1000;
  }

  /** 讓出主執行緒（用 MessageChannel 避免 setTimeout 的 4ms 巢狀夾限）。 */
  function yieldToUi() {
    if (typeof global.MessageChannel === "function") {
      return new Promise(function (resolve) {
        var channel = new global.MessageChannel();
        channel.port1.onmessage = function () {
          try {
            channel.port1.close();
          } catch (err) { /* 忽略 */ }
          resolve();
        };
        channel.port2.postMessage(0);
      });
    }
    return new Promise(function (resolve) {
      global.setTimeout(resolve, 0);
    });
  }

  function requireMedia() {
    var media = global.TabCapMedia;
    if (!media || typeof media.grabFrame !== "function") {
      throw new Error(
        "媒體模組 js/media.js 沒有載入，無法取得畫面。" +
        "請確認 index.html 的載入順序：js/media.js 在 js/capture.js 之前。"
      );
    }
    return media;
  }

  function normalizeCrop(crop) {
    var c = crop || {};
    var l = clamp(toNumber(c.l, 0), 0, 1);
    var r = clamp(toNumber(c.r, 1), 0, 1);
    var t = clamp(toNumber(c.t, 0), 0, 1);
    var b = clamp(toNumber(c.b, 1), 0, 1);
    if (!(r > l)) {
      l = 0;
      r = 1;
    }
    if (!(b > t)) {
      t = 0;
      b = 1;
    }
    return { l: l, r: r, t: t, b: b };
  }

  /* ------------------------------------------------------------------ *
   * 1) sampleVideo：本地影片按秒抽幀
   * ------------------------------------------------------------------ */

  /** 把第 2 步參數整理成「實際上要跑幾幀、從哪到哪」。 */
  function planVideoSampling(source, params) {
    var p = params || {};
    var duration = isFinite(source && source.duration) && source.duration > 0 ? source.duration : 0;
    var crop = normalizeCrop(p.crop);
    var maxWidth = toNumber(p.maxWidth, DEFAULT_FRAME_MAX_WIDTH);
    if (!(maxWidth > 0)) maxWidth = DEFAULT_FRAME_MAX_WIDTH;

    var start = toNumber(p.start, 0);
    var end = toNumber(p.end, duration);
    var every = toNumber(p.sampleEvery, 2);
    if (!(every > 0)) every = 2; // 0 / 負數 / NaN 一律回退預設值
    // 注意：這裡刻意「不」把太小的間隔偷偷夾大 —— 使用者輸入 0.001 就該拿到
    // 「超過 2000 幀上限」的明確錯誤（契約要求），而不是被靜默改成 0.05。
    // 真正的上限保護在下面用 total 判斷。

    if (duration > 0) {
      if (start < 0) start = 0;
      if (start > duration) {
        throw new Error(
          "開始時間（" + round3(start) + " 秒）超出影片長度（" + round3(duration) + " 秒）。"
        );
      }
      if (!(end > 0) || end > duration) end = duration;
    } else if (!(end > start)) {
      throw new Error("無法判斷影片長度，請重新匯入影片。");
    }

    if (!(end > start)) {
      throw new Error("結束時間必須大於開始時間（目前 " + round3(start) + " 秒 → " + round3(end) + " 秒）。");
    }

    var total = Math.floor((end - start) / every + 1e-6) + 1;
    if (total > MAX_SAMPLE_FRAMES) {
      throw new Error(
        "抽幀數量 " + total + " 張超過上限 " + MAX_SAMPLE_FRAMES +
        " 張。請加大「抽幀間隔」或縮短起止時間。"
      );
    }

    // 記憶體保護：每張 canvas ≈ 寬×高×4 bytes，瀏覽器只能留在記憶體（沒有磁碟暫存）。
    // 先算「這個張數要塞進預算需要多寬」；不夠就自動降解析度（最低 640px），
    // 只有連 640px 都放不下（極端張數）才丟錯。降解析度會回報在 frames.notice 裡。
    var size = fitFrameSize(source, crop, maxWidth, total);
    return {
      start: start,
      end: end,
      every: every,
      total: total,
      crop: crop,
      maxWidth: size.width,
      notice: size.notice
    };
  }

  /** 依「張數 × 每張像素」估算並收斂抽幀寬度，讓總記憶體落在預算內。 */
  function fitFrameSize(source, crop, maxWidth, total) {
    var cropW = Math.max(1, (source.width || 1) * (crop.r - crop.l));
    var cropH = Math.max(1, (source.height || 1) * (crop.b - crop.t));
    var originalWidth = Math.max(1, Math.min(Math.round(maxWidth), Math.round(cropW)));
    var width = originalWidth;
    var height = Math.max(1, Math.round(cropH * (width / cropW)));
    var bytes = total * width * height * 4;

    while (bytes > FRAME_MEMORY_BUDGET_BYTES && width > MIN_AUTO_FRAME_WIDTH) {
      var next = Math.max(MIN_AUTO_FRAME_WIDTH, Math.floor(width * 0.85));
      if (next >= width) break;
      width = next;
      height = Math.max(1, Math.round(cropH * (width / cropW)));
      bytes = total * width * height * 4;
    }

    var notice = null;
    if (width < originalWidth) {
      notice =
        "為了避免佔用過多記憶體，抽幀解析度已自動降到 " + width + "×" +
        Math.max(1, Math.round(cropH * (width / cropW))) + "（共 " + total + " 張）。";
    }

    if (bytes > MAX_FRAME_MEMORY_BYTES) {
      throw new Error(
        "要抽 " + total + " 張約 " + width + "×" + height + " 的畫面，記憶體需求約 " +
        Math.round(bytes / (1024 * 1024)) + " MB，可能讓瀏覽器當掉。" +
        "請加大「抽幀間隔」（例如 2 秒以上）、縮短時間範圍，或先用「抽幀前裁切」縮小畫面。"
      );
    }
    return { width: width, notice: notice };
  }

  /**
   * 從「可 seek 的影片」抽幀。
   * @param {object} source Source（kind === "video"；也容忍 kind === "image" 回單幀）
   * @param {{start:number,end:number,sampleEvery:number,crop:object}} params
   * @param {{onProgress?:function, shouldStop?:function}} [options]
   * @returns {Promise<Array<{t:number, canvas:HTMLCanvasElement}>>}
   */
  async function sampleVideo(source, params, options) {
    var opts = options || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    var shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : null;
    var media = requireMedia();

    if (!source || typeof source !== "object") {
      throw new Error("沒有可用的來源，請先匯入影片。");
    }
    if (source.kind === "screen") {
      throw new Error("螢幕擷取是即時串流、沒有時間軸，請改用「即時取樣」（sampleLive）。");
    }

    // 圖片只有一張：不需要「起止時間 / 抽幀間隔」這套規劃，單幀就好
    if (source.kind === "image") {
      var only = await media.grabFrame(source, 0, {
        crop: normalizeCrop(params && params.crop),
        maxWidth: toNumber(params && params.maxWidth, DEFAULT_FRAME_MAX_WIDTH) || DEFAULT_FRAME_MAX_WIDTH
      });
      if (onProgress) {
        try {
          onProgress({ phase: "sampling", done: 1, total: 1, t: 0 });
        } catch (err) {
          if (global.console && global.console.error) global.console.error(err);
        }
      }
      var single = [{ t: 0, canvas: only }];
      single.requested = 1;
      single.cancelled = false;
      return single;
    }
    if (source.kind !== "video") {
      throw new Error("不支援的來源類型（" + String(source.kind) + "），無法抽幀。");
    }

    var plan = planVideoSampling(source, params);

    function report(done, total, t, extra) {
      if (!onProgress) return;
      var payload = { phase: "sampling", done: done, total: total, t: round3(t) };
      if (extra) {
        if (extra.cancelled) payload.cancelled = true;
      }
      try {
        onProgress(payload);
      } catch (err) {
        if (global.console && global.console.error) global.console.error(err);
      }
    }

    var frames = [];
    var cancelled = false;
    var consecutiveErrors = 0;
    var lastError = null;

    report(0, plan.total, plan.start);

    for (var i = 0; i < plan.total; i++) {
      if (shouldStop && shouldStop()) {
        cancelled = true;
        break;
      }
      var t = plan.start + i * plan.every;
      if (t > plan.end) t = plan.end;

      var canvas = null;
      try {
        canvas = await media.grabFrame(source, t, {
          crop: plan.crop,
          maxWidth: plan.maxWidth
        });
      } catch (err) {
        lastError = err;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(
            "抽幀失敗（t=" + round3(t) + " 秒）：" + (err && err.message ? err.message : String(err))
          );
        }
        continue;
      }
      consecutiveErrors = 0;
      frames.push({ t: round3(t), canvas: canvas });
      report(frames.length, plan.total, t);
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToUi();
    }

    if (!frames.length && !cancelled) {
      throw new Error(
        "沒有取到任何畫面" +
        (lastError && lastError.message ? "：" + lastError.message : "，請確認影片可以正常播放。")
      );
    }

    report(frames.length, plan.total, frames.length ? frames[frames.length - 1].t : plan.start, {
      cancelled: cancelled
    });
    frames.requested = plan.total;
    frames.cancelled = cancelled;
    frames.maxWidthUsed = plan.maxWidth;
    if (plan.notice) frames.notice = plan.notice;
    return frames;
  }

  /* ------------------------------------------------------------------ *
   * 2) sampleLive：螢幕 / 分頁即時串流按真實時間取樣
   * ------------------------------------------------------------------ */

  /**
   * 從即時串流取樣（不 seek）。t 從 0 起算（開始取樣後的秒數）。
   * @param {object} source openScreenCapture() 回傳的物件
   * @param {{start:number,end:number,sampleEvery:number,crop:object}} params
   * @param {{onProgress?:function, shouldStop?:function}} [options]
   * @returns {Promise<Array<{t:number, canvas:HTMLCanvasElement}>>}
   */
  async function sampleLive(source, params, options) {
    var opts = options || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    var shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : null;
    var media = requireMedia();

    if (!source || !source.video) {
      throw new Error("螢幕擷取來源不正確（缺少 video 元素），請重新按「擷取螢幕」。");
    }
    var video = source.video;

    var p = params || {};
    var start = Math.max(0, toNumber(p.start, 0));
    var end = toNumber(p.end, start + 10);
    var span = end - start;
    if (!isFinite(span) || span <= 0) span = Math.max(1, toNumber(p.duration, 10));
    span = clamp(span, 0.5, 600);
    var every = clamp(toNumber(p.sampleEvery, 2), MIN_SAMPLE_EVERY, 60);
    var crop = normalizeCrop(p.crop);
    var maxWidth = toNumber(p.maxWidth, DEFAULT_FRAME_MAX_WIDTH);
    if (!(maxWidth > 0)) maxWidth = DEFAULT_FRAME_MAX_WIDTH;

    var total = Math.max(1, Math.floor(span / every + 1e-6) + 1);
    var frames = [];
    var cancelled = false;
    var stoppedBySource = false;
    var lastError = null;
    var t0 = nowMs();
    var nextAt = 0;
    var pendingCaptures = 0;

    function elapsedSeconds() {
      return (nowMs() - t0) / 1000;
    }

    function report() {
      if (!onProgress) return;
      try {
        onProgress({
          phase: "live",
          done: frames.length,
          total: total,
          t: round3(elapsedSeconds())
        });
      } catch (err) {
        if (global.console && global.console.error) global.console.error(err);
      }
    }

    report();

    await new Promise(function (resolve) {
      var finished = false;
      var safetyTimer = null;

      function finish() {
        if (finished) return;
        finished = true;
        if (safetyTimer !== null) global.clearTimeout(safetyTimer);
        resolve();
      }

      function captureAt(seconds) {
        // 重要：grabFrame 對 live 來源是「同步 drawImage」（async 函式在第一個 await 前就畫完），
        // 所以這裡拿到的就是「現在這一幀」的畫面，不會慢一拍。
        pendingCaptures++;
        media.grabFrame(source, seconds, { crop: crop, maxWidth: maxWidth }).then(
          function (canvas) {
            pendingCaptures--;
            frames.push({ t: round3(seconds), canvas: canvas });
            report();
          },
          function (err) {
            pendingCaptures--;
            lastError = err;
          }
        );
      }

      function tick() {
        if (finished) return;
        if (shouldStop && shouldStop()) {
          cancelled = true;
          finish();
          return;
        }
        if (source.ended) {
          stoppedBySource = true;
          finish();
          return;
        }
        var elapsed = elapsedSeconds();
        if (elapsed >= span) {
          finish();
          return;
        }
        if (elapsed >= nextAt) {
          captureAt(elapsed);
          // 用「固定網格」推進，而不是 elapsed + every：
          // rVFC 只能在新幀到達時被呼叫，量化誤差若用累加會愈漂愈多。
          nextAt += every;
          while (nextAt <= elapsed) nextAt += every;
        }
        schedule();
      }

      var schedule;
      if (typeof video.requestVideoFrameCallback === "function") {
        schedule = function () {
          try {
            video.requestVideoFrameCallback(function () {
              tick();
            });
          } catch (err) {
            // 影片元素壞掉（串流被使用者停止）→ 收工
            stoppedBySource = true;
            finish();
          }
        };
      } else {
        var raf = typeof global.requestAnimationFrame === "function"
          ? global.requestAnimationFrame.bind(global)
          : function (fn) { return global.setTimeout(fn, 16); };
        schedule = function () {
          raf(tick);
        };
      }

      // 安全網：就算 rVFC/rAF 完全不再回呼，也一定會結束
      safetyTimer = global.setTimeout(finish, Math.ceil((span + 2) * 1000));
      schedule();
    });

    // 已發出的取幀 promise 可能還在 microtask 佇列裡 → 等一下再收尾，
    // 否則 frames 會在 sampleLive 回傳之後才被 push（呼叫端會拿到少一幀的陣列）。
    for (var waitRounds = 0; waitRounds < 50 && pendingCaptures > 0; waitRounds++) {
      await new Promise(function (resolve) {
        global.setTimeout(resolve, 10);
      });
    }

    if (!frames.length) {
      if (stoppedBySource) {
        throw new Error("螢幕/分頁分享已停止，沒有取到任何畫面。請重新擷取並保持分享中的分頁在前景。");
      }
      if (!cancelled) {
        throw new Error(
          "即時取樣沒有取到任何畫面" +
          (lastError && lastError.message ? "：" + lastError.message : "（分享可能已停止）") + "。"
        );
      }
    }

    report();
    frames.requested = total;
    frames.cancelled = cancelled;
    return frames;
  }

  /* ------------------------------------------------------------------ *
   * 3) dedupe：灰階縮圖 → 播放頭條帶偵測 → 與前 N 張已保留幀比較
   * ------------------------------------------------------------------ */

  function normalizeDedupeParams(params) {
    var p = params || {};
    var diffThreshold = toNumber(p.diffThreshold, 0.01);
    if (!(diffThreshold >= 0)) diffThreshold = 0.01;
    diffThreshold = clamp(diffThreshold, 0, 1);

    var bandHalfWidth = toNumber(p.bandHalfWidth, 90);
    if (!(bandHalfWidth >= 0)) bandHalfWidth = 90;
    bandHalfWidth = clamp(bandHalfWidth, 0, 4096);

    var compareWindow = Math.floor(toNumber(p.compareWindow, 1));
    if (!(compareWindow >= 1)) compareWindow = 1;
    compareWindow = clamp(compareWindow, 1, 64);

    return {
      diffThreshold: diffThreshold,
      bandHalfWidth: bandHalfWidth,
      compareWindow: compareWindow
    };
  }

  /** 一維盒狀濾波（用前綴和，O(n)）。 */
  function boxSmooth(src, dst, width, smoothWidth) {
    var half = (smoothWidth - 1) >> 1;
    var prefix = new Float64Array(width + 1);
    var sum = 0;
    var i;
    for (i = 0; i < width; i++) {
      sum += src[i];
      prefix[i + 1] = sum;
    }
    for (i = 0; i < width; i++) {
      var a = i - half;
      if (a < 0) a = 0;
      var b = i + half + 1;
      if (b > width) b = width;
      dst[i] = b > a ? (prefix[b] - prefix[a]) / (b - a) : 0;
    }
  }

  /**
   * 去重。
   * @param {Array<{t:number, canvas:HTMLCanvasElement}>} frames
   * @param {{diffThreshold:number, bandHalfWidth:number, compareWindow:number}} params
   * @param {{onProgress?:function}} [options]
   * @returns {{kept:Array, stats:object}}
   */
  function dedupe(frames, params, options) {
    var opts = options || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    var cfg = normalizeDedupeParams(params);
    var startedAt = nowMs();

    var total = frames && frames.length ? frames.length : 0;
    var stats = {
      checked: 0,
      duplicates: 0,
      kept: 0,
      blank: 0,
      frames: total,
      workWidth: 0,
      workHeight: 0,
      keptWithBand: 0,
      elapsedMs: 0
    };
    var emptyResult = { kept: [], stats: stats };
    if (!total) {
      stats.elapsedMs = round3(nowMs() - startedAt);
      return emptyResult;
    }

    var doc = global.document;
    if (!doc || typeof doc.createElement !== "function") {
      throw new Error("去重需要瀏覽器環境（canvas），目前環境不支援。");
    }

    var workCanvas = null;
    var workCtx = null;
    var W = 0;
    var H = 0;
    var frameWidth = 0; // 原始幀寬（用來換算 bandHalfWidth）
    var colProfile = null;
    var colSmoothed = null;
    var smoothWidth = 0;

    var kept = [];
    var keptThumbs = []; // {bin, band}
    var keptBands = [];
    var keptWithBand = 0;

    var prevGray = null;
    var prevBand = null;

    function setupWork(canvas) {
      frameWidth = Math.max(1, canvas.width || 1);
      W = Math.max(16, Math.min(WORK_WIDTH, frameWidth));
      H = Math.max(1, Math.round((canvas.height || 1) * (W / frameWidth)));
      workCanvas = doc.createElement("canvas");
      workCanvas.width = W;
      workCanvas.height = H;
      workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
      if (!workCtx) throw new Error("無法建立離屏畫布（瀏覽器記憶體不足？）。");
      colProfile = new Float32Array(W);
      colSmoothed = new Float32Array(W);
      smoothWidth = Math.max(3, Math.round((31 * W) / 1280));
      if (smoothWidth % 2 === 0) smoothWidth += 1;
      smoothWidth = Math.min(smoothWidth, Math.max(3, W - 1) | 1);
      stats.workWidth = W;
      stats.workHeight = H;
    }

    /** 縮成灰階縮圖，同時產生二值化「譜面/背景」陣列與亮度統計。 */
    function prepareThumb(canvas) {
      try {
        workCtx.drawImage(canvas, 0, 0, W, H);
      } catch (err) {
        throw new Error("建立灰階縮圖失敗：" + (err && err.message ? err.message : String(err)));
      }
      var data = workCtx.getImageData(0, 0, W, H).data;
      var n = W * H;
      var gray = new Uint8Array(n);
      var bin = new Uint8Array(n);
      var sum = 0;
      var sumSq = 0;
      for (var i = 0, p = 0; i < n; i++, p += 4) {
        // 標準 luma 權重（整數近似）
        var g = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
        gray[i] = g;
        bin[i] = g < INK_THRESHOLD ? 1 : 0;
        sum += g;
        sumSq += g * g;
      }
      var mean = sum / n;
      var variance = sumSq / n - mean * mean;
      var std = variance > 0 ? Math.sqrt(variance) : 0;
      return { gray: gray, bin: bin, mean: mean, std: std };
    }

    /**
     * 偵測「移動的元素集中在哪一欄」：
     * 對相鄰兩幀算每一欄的平均灰階差 → 平滑 → 取峰值。
     * 峰值太小（沒東西在動）或差異平均散在整個寬度（整頁卷動）→ 回 null（不遮罩）。
     */
    function detectBandCenter(prevGrayArr, grayArr) {
      var y;
      var x;
      colProfile.fill(0);
      for (y = 0; y < H; y++) {
        var off = y * W;
        for (x = 0; x < W; x++) {
          var d = prevGrayArr[off + x] - grayArr[off + x];
          if (d < 0) d = -d;
          colProfile[x] += d;
        }
      }
      for (x = 0; x < W; x++) colProfile[x] /= H;
      boxSmooth(colProfile, colSmoothed, W, smoothWidth);

      var peak = -1;
      var peakIndex = 0;
      var sum = 0;
      for (x = 0; x < W; x++) {
        var v = colSmoothed[x];
        sum += v;
        if (v > peak) {
          peak = v;
          peakIndex = x;
        }
      }
      var mean = sum / W;
      if (!(peak >= BAND_MIN_PEAK)) return null;
      if (peak < mean * BAND_PEAK_RATIO) return null;
      return peakIndex;
    }

    /** bandHalfWidth 以「原始幀像素」為單位，換算到工作寬度。 */
    function bandHalfWidthInWork() {
      if (!(cfg.bandHalfWidth > 0) || !(frameWidth > 0)) return 0;
      var half = Math.round((cfg.bandHalfWidth * W) / frameWidth);
      if (half < 1) half = 1;
      var maxHalf = Math.floor(W / 2);
      return Math.min(half, maxHalf);
    }

    /** 把要忽略的欄位區間合併成「可比較的欄位區間」（互補區間）。 */
    function allowedColumnRanges(centerA, centerB, half) {
      var cuts = [];
      var centers = [centerA, centerB];
      for (var i = 0; i < centers.length; i++) {
        var center = centers[i];
        if (center === null || center === undefined) continue;
        var x1 = Math.max(0, Math.round(center - half));
        var x2 = Math.min(W, Math.round(center + half));
        if (x2 > x1) cuts.push([x1, x2]);
      }
      if (!cuts.length) return [[0, W]];
      cuts.sort(function (a, b) {
        return a[0] - b[0];
      });
      var merged = [];
      for (var c = 0; c < cuts.length; c++) {
        var last = merged[merged.length - 1];
        if (last && cuts[c][0] <= last[1]) {
          if (cuts[c][1] > last[1]) last[1] = cuts[c][1];
        } else {
          merged.push([cuts[c][0], cuts[c][1]]);
        }
      }
      var ranges = [];
      var cursor = 0;
      for (var m = 0; m < merged.length; m++) {
        if (merged[m][0] > cursor) ranges.push([cursor, merged[m][0]]);
        cursor = Math.max(cursor, merged[m][1]);
      }
      if (cursor < W) ranges.push([cursor, W]);
      return ranges;
    }

    /**
     * 兩幀的「譜面像素差比例」。
     * = 忽略播放頭條帶後，二值化像素不一樣的比例（0..1）。
     */
    function diffRatio(thumbPrev, thumbCurr, bandPrev, bandCurr, half) {
      var ranges = allowedColumnRanges(bandPrev, bandCurr, half);
      var allowed = 0;
      for (var r = 0; r < ranges.length; r++) {
        allowed += (ranges[r][1] - ranges[r][0]) * H;
      }
      if (allowed <= 0) return 1; // 全部被遮罩（極端參數）→ 當成不同，避免把東西全殺光
      var a = thumbPrev.bin;
      var b = thumbCurr.bin;
      var changed = 0;
      for (var i = 0; i < ranges.length; i++) {
        var x0 = ranges[i][0];
        var x1 = ranges[i][1];
        for (var y = 0; y < H; y++) {
          var off = y * W;
          for (var x = x0; x < x1; x++) {
            if (a[off + x] !== b[off + x]) changed++;
          }
        }
      }
      return changed / allowed;
    }

    for (var index = 0; index < total; index++) {
      var frame = frames[index];
      // 空幀（被取消或取幀失敗）→ 直接跳過，不算「檢查過」也不影響去重結果
      if (!frame || !frame.canvas || !frame.canvas.width) continue;
      stats.checked++;
      if (!workCanvas) setupWork(frame.canvas);

      var thumb = prepareThumb(frame.canvas);

      // 條帶偵測：與「上一張被檢查到的幀」比較（不看是否保留，跟伺服器版一樣逐幀掃）
      var band = null;
      if (prevGray) band = detectBandCenter(prevGray, thumb.gray);
      prevGray = thumb.gray;
      prevBand = band;

      // 幾乎單色（全黑/全白/轉場）→ 跳過
      if (thumb.std < BLANK_STD) {
        stats.blank++;
        continue;
      }

      // 與前 compareWindow 張已保留幀比較；只要有一張「夠像」就是重複
      var isDuplicate = false;
      var half = bandHalfWidthInWork();
      var from = Math.max(0, keptThumbs.length - cfg.compareWindow);
      for (var k = from; k < keptThumbs.length; k++) {
        var ratio = diffRatio(keptThumbs[k], thumb, keptBands[k], band, half);
        if (ratio <= cfg.diffThreshold) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        stats.duplicates++;
      } else {
        kept.push(frame);
        // 只留二值化陣列（灰階只給下一幀的條帶偵測用，不必留）
        keptThumbs.push({ bin: thumb.bin });
        keptBands.push(band);
        if (band !== null) keptWithBand++;
        stats.kept++;
      }

      if (onProgress && (index % 10 === 9 || index === total - 1)) {
        try {
          onProgress({
            phase: "dedupe",
            done: index + 1,
            total: total,
            kept: stats.kept
          });
        } catch (err) {
          if (global.console && global.console.error) global.console.error(err);
        }
      }
    }

    // keptWithBand：有幾張被保留的幀偵測到播放頭條帶（除錯用）
    stats.keptWithBand = keptWithBand;
    stats.elapsedMs = round3(nowMs() - startedAt);
    return { kept: kept, stats: stats };
  }

  /* ------------------------------------------------------------------ *
   * 4) Frame[] → Capture[]
   * ------------------------------------------------------------------ */

  /**
   * 把抽好的幀轉成 app.js / 第 3 步用的 Capture[]（PNG blob + object URL）。
   * @param {Array<{t:number, canvas:HTMLCanvasElement}>} frames
   * @returns {Promise<Array<object>>}
   */
  async function framesToCaptures(frames) {
    var media = requireMedia();
    if (!frames || !frames.length) return [];
    var captures = [];
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (!frame || !frame.canvas || !frame.canvas.width || !frame.canvas.height) continue;
      var blob;
      try {
        blob = await media.canvasToBlob(frame.canvas, "image/png");
      } catch (err) {
        throw new Error(
          "第 " + (captures.length + 1) + " 張截圖轉存 PNG 失敗：" +
          (err && err.message ? err.message : String(err))
        );
      }
      captures.push({
        id: "c" + captures.length,
        blob: blob,
        url: global.URL.createObjectURL(blob),
        t: round3(toNumber(frame.t, 0)),
        w: frame.canvas.width,
        h: frame.canvas.height,
        crop: { l: 0, r: 1, t: 0, b: 1 },
        measures: [],
        hidden: false,
        canvas: frame.canvas
      });
    }
    return captures;
  }

  global.TabCapCapture = {
    version: API_VERSION,
    sampleVideo: sampleVideo,
    sampleLive: sampleLive,
    dedupe: dedupe,
    framesToCaptures: framesToCaptures,
    // 給 UI 做輸入驗證用（契約沒要求，屬額外曝光）
    LIMITS: {
      maxFrames: MAX_SAMPLE_FRAMES,
      minSampleEvery: MIN_SAMPLE_EVERY,
      workWidth: WORK_WIDTH,
      defaultFrameMaxWidth: DEFAULT_FRAME_MAX_WIDTH
    },
    // 方便除錯/驗證
    defaults: {
      diffThreshold: 0.01,
      bandHalfWidth: 90,
      compareWindow: 1
    }
  };
})(typeof window !== "undefined" ? window : this);
