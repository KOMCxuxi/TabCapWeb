/*!
 * TabCapWeb · js/media.js — 純前端媒體來源層
 * -----------------------------------------------------------------------------
 * 用途：把「本地影片 / 本地圖片 / 螢幕(分頁)擷取」包成統一的 Source，
 *      並提供「取得任意秒的畫面」與「canvas → Blob」。
 *
 * 為什麼這樣做：
 * 1. 伺服器版用 OpenCV 直接 seek 讀幀；瀏覽器沒有等價 API，只能靠 <video> + seek。
 *    seek 是主要成本（尤其往回跳），所以每個 <video> 都記住上次位置；連續往前抽幀時
 *    只做小幅度前進，避免每幀都從 keyframe 重解。seeked 之後再用
 *    requestVideoFrameCallback 確認「那一幀真的被送進繪製管線」才 drawImage，
 *    不支援時退化成兩次 rAF（同樣是「等到下一次繪製」的意思）。
 * 2. <video> 一定要留在 DOM 繪製管線裡：部分瀏覽器（尤其 iOS Safari）對
 *    display:none 的 video 會停止更新畫面，drawImage 會拿到空白/舊幀。
 *    因此用「畫面外 + 極低不透明度」而不是 hidden。
 * 3. 本專案零依賴、零 build、沒有 ES module，所有東西掛在 window.TabCapMedia；
 *    每個函式都不讀 app.js 的 state、不碰 UI DOM，錯誤訊息一律繁體中文，
 *    讓第 1 步的 importStatus 直接顯示即可。
 * 4. 螢幕擷取（getDisplayMedia）只回傳「可停止」的 stream 包裝，不支援就明確報錯，
 *    不做任何假裝可用的 fallback（純前端無法下載 YouTube/B 站連結）。
 *
 * 對外 API（契約見 CONTRACT.md）：
 *   TabCapMedia.createVideoSource(file, { onProgress }) -> Source
 *   TabCapMedia.createImageSource(file)                 -> Source
 *   TabCapMedia.grabFrame(source, timeSec, { crop, maxWidth }) -> HTMLCanvasElement
 *   TabCapMedia.openScreenCapture({ audio })            -> { stream, video, stop(), ended, onended }
 *   TabCapMedia.canvasToBlob(canvas, type, quality)     -> Blob
 *   TabCapMedia.disposeSource(source)                   -> void   （額外的清理小工具）
 */
(function (global) {
  "use strict";

  var API_VERSION = "1.0.0";

  // 隱形 <video> 樣式：不能用 display:none（見檔頭第 2 點）。
  var OFFSCREEN_CSS =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0.01;" +
    "pointer-events:none;border:0;z-index:-1;";

  // 只做「明顯不是影片/圖片」的早期攔截；真正的可解碼性交給瀏覽器判斷，
  // 因為副檔名與實際編碼不一定一致（例如 .m4v 可能是 HEVC）。
  var VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "ogv", "ogg", "mov", "mkv", "avi", "ts", "flv", "m4s", "mpg", "mpeg"];
  var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

  var METADATA_TIMEOUT_MS = 30000; // 讀 metadata 的上限（大檔從 blob 解也很快，30s 很寬）
  var SEEK_TIMEOUT_MS = 15000; // 單次 seek 上限
  var FRAME_WAIT_TIMEOUT_MS = 1000; // 已知 rVFC 可用時，等「畫面被呈現」的硬上限
  var RVFC_PROBE_MS = 200; // 第一次探測 rVFC 到底會不會回呼的上限
  var LIVE_READY_TIMEOUT_MS = 15000; // 螢幕擷取來源可用的上限

  var RVFC_UNKNOWN = 0;
  var RVFC_WORKS = 1;
  var RVFC_BROKEN = 2;

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

  function extensionOf(name) {
    var m = /\.([A-Za-z0-9]+)\s*$/.exec(String(name || ""));
    return m ? m[1].toLowerCase() : "";
  }

  function fileKind(file) {
    if (!file || typeof file !== "object") return "invalid";
    if (typeof file.size !== "number" || typeof file.slice !== "function") return "invalid";
    return file.size > 0 ? "ok" : "empty";
  }

  /** 把 error 的 code 轉成繁體中文說明（<video> 的 MediaError）。 */
  function videoErrorMessage(mediaError) {
    var code = mediaError && mediaError.code ? mediaError.code : 0;
    if (code === 1) return "影片讀取被中止（檔案可能被移動或刪除）。";
    if (code === 2) return "影片讀取失敗（檔案讀取或網路錯誤）。";
    if (code === 3) return "影片解碼失敗，檔案可能損毀。請改用其他檔案或先轉檔。";
    if (code === 4) {
      return "瀏覽器不支援這支影片的格式或編碼（常見於 MKV / AVI / HEVC / MPEG-4 Part 2）。" +
        "請先轉成 MP4（H.264）或 WebM（VP8/VP9/AV1）再匯入。";
    }
    return "影片載入失敗（未知錯誤）。請確認檔案可以正常播放。";
  }

  /** 建立「畫面外但仍在繪製管線」的 <video>。 */
  function createHiddenVideo() {
    var video = global.document.createElement("video");
    video.muted = true; // muted 才能自動播放、也避免播放音訊
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    video.controls = false;
    video.setAttribute("aria-hidden", "true");
    video.style.cssText = OFFSCREEN_CSS;
    var host = global.document.body || global.document.documentElement;
    if (host && host.appendChild) host.appendChild(video);
    return video;
  }

  /** 兩次 requestAnimationFrame（等下一次繪製；不支援 rVFC 時的退路）。 */
  function afterNextPaint(callback) {
    var raf = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : function (fn) { return global.setTimeout(fn, 16); };
    raf(function () {
      raf(function () {
        callback();
      });
    });
  }

  /**
   * 註冊 requestVideoFrameCallback，最多等 timeoutMs；回傳「有沒有真的回呼」。
   * 不回呼就取消註冊並回 false，絕對不會卡住。
   */
  function rvfcOrTimeout(video, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var handle = null;
      var timer = global.setTimeout(function () {
        settle(false);
      }, timeoutMs);

      function settle(fired) {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        if (!fired && handle !== null) {
          try {
            video.cancelVideoFrameCallback(handle);
          } catch (err) { /* 忽略 */ }
        }
        resolve(fired);
      }

      try {
        handle = video.requestVideoFrameCallback(function () {
          settle(true);
        });
      } catch (err) {
        settle(false);
      }
    });
  }

  /**
   * 等「新的一幀真的被送進繪製管線」。
   *
   * 重要實測結論（Chromium 系，包含 Edge headless）：對**暫停中**的 <video> seek 之後，
   * requestVideoFrameCallback 不一定會回呼（rAF 會）。若每幀都傻等一個 1 秒 timeout，
   * 抽 200 幀就會多花 200 秒。所以這裡做「一次性探測」：
   *   - 第一次先短等 200ms 看 rVFC 會不會回呼；
   *   - 會 → 之後每幀都等 rVFC（有 1s 硬上限）；
   *   - 不會 → 之後直接放行（seeked 事件本身就保證該時間點的幀已解碼完成，
   *     diag 量測 readyState=4，drawImage 拿到的就是目標幀）。
   * 完全沒有 rVFC 的老瀏覽器則退化成「兩次 rAF」，這也是契約要求的退路。
   */
  function waitForPresentedFrame(video) {
    if (typeof video.requestVideoFrameCallback !== "function") {
      return new Promise(function (resolve) {
        afterNextPaint(resolve);
      });
    }
    var state = video.__tabcapRvfcState || RVFC_UNKNOWN;
    if (state === RVFC_BROKEN) return Promise.resolve();
    if (state === RVFC_WORKS) {
      return rvfcOrTimeout(video, FRAME_WAIT_TIMEOUT_MS).then(function () {});
    }
    return rvfcOrTimeout(video, RVFC_PROBE_MS).then(function (fired) {
      video.__tabcapRvfcState = fired ? RVFC_WORKS : RVFC_BROKEN;
    });
  }

  /** seek 到指定秒，等 seeked（含超時與錯誤處理）。 */
  function seekToTime(video, target) {
    return new Promise(function (resolve, reject) {
      if (!video || typeof video.currentTime !== "number") {
        reject(new Error("來源缺少可用的 <video> 元素，無法取得畫面。"));
        return;
      }
      if (video.error) {
        reject(new Error(videoErrorMessage(video.error)));
        return;
      }
      var settled = false;
      var timer = null;

      function cleanup() {
        if (timer !== null) global.clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      }
      function finish(err, timedOut) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          reject(err);
          return;
        }
        if (timedOut && video.readyState < 2) {
          reject(new Error(
            "讀取影片畫面逾時（跳到 " + target.toFixed(2) + " 秒）。影片可能損毀或格式不受支援。"
          ));
          return;
        }
        resolve();
      }
      function onSeeked() {
        finish(null, false);
      }
      function onError() {
        finish(new Error(videoErrorMessage(video.error)));
      }

      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      timer = global.setTimeout(function () {
        finish(null, true);
      }, SEEK_TIMEOUT_MS);

      try {
        video.currentTime = target;
      } catch (err) {
        finish(new Error(
          "無法跳到指定時間（" + target.toFixed(2) + " 秒）：" +
          (err && err.message ? err.message : String(err))
        ));
        return;
      }
      // 同一個位置再設定一次不會再發 seeked（部分瀏覽器）。用 setTimeout(0) 等一個
      // task 邊界後再確認：若真的沒在 seek 且資料已就緒，就直接放行，不要等到 15 秒。
      global.setTimeout(function () {
        if (settled) return;
        if (!video.seeking && Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) {
          finish(null, false);
        }
      }, 0);
    });
  }

  /** 影片 seek 包裝：記住上次位置、夾在合法範圍內、跳過重複 seek。 */
  async function seekVideo(video, timeSec) {
    var target = toNumber(timeSec, 0);
    var duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    target = Math.max(0, target);
    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.001));
    var last = video.__tabcapSeekTime;
    if (typeof last === "number" && Math.abs(last - target) < 1e-6 && video.readyState >= 2) {
      return target; // 同一幀，不用再 seek
    }
    await seekToTime(video, target);
    video.__tabcapSeekTime = target;
    return target;
  }

  /**
   * 有些 WebM（螢幕錄影 / MediaRecorder 產物）在 metadata 階段 duration = Infinity，
   * 要「跳到很後面」觸發 durationchange 才能拿到真正長度。失敗就回 0 讓上層報錯。
   */
  async function resolveDuration(video) {
    if (isFinite(video.duration) && video.duration > 0) return video.duration;
    await new Promise(function (resolve) {
      var done = false;
      var timer = global.setTimeout(finish, 3000);
      function finish() {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        video.removeEventListener("durationchange", onDurationChange);
        try {
          video.currentTime = 0;
        } catch (err) {
          /* 忽略：拿不到長度時上層會報錯 */
        }
        global.setTimeout(resolve, 30);
      }
      function onDurationChange() {
        if (isFinite(video.duration) && video.duration > 0) finish();
      }
      video.addEventListener("durationchange", onDurationChange);
      try {
        video.currentTime = 1e7;
      } catch (err) {
        finish();
      }
    });
    return isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  }

  /** 等 <video> 的 readyState >= 2（HAVE_CURRENT_DATA）。 */
  function waitVideoReady(video, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      var settled = false;
      var timer = global.setTimeout(function () {
        finish(new Error(label + "逾時（" + Math.round(timeoutMs / 1000) + " 秒）。"));
      }, timeoutMs);
      function cleanup() {
        global.clearTimeout(timer);
        video.removeEventListener("loadeddata", onData);
        video.removeEventListener("playing", onData);
        video.removeEventListener("canplay", onData);
        video.removeEventListener("error", onError);
      }
      function finish(err) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      }
      function onData() {
        if (video.readyState >= 2) finish(null);
      }
      function onError() {
        finish(new Error(videoErrorMessage(video.error)));
      }
      video.addEventListener("loadeddata", onData);
      video.addEventListener("playing", onData);
      video.addEventListener("canplay", onData);
      video.addEventListener("error", onError);
    });
  }

  /* ------------------------------------------------------------------ *
   * 1) 建立來源
   * ------------------------------------------------------------------ */

  /**
   * 本地影片 → Source。
   * @param {File|Blob} file
   * @param {{onProgress?: function}} [options]
   * @returns {Promise<object>} Source
   */
  async function createVideoSource(file, options) {
    var opts = options || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    var state = fileKind(file);
    if (state === "invalid") throw new Error("沒有選擇影片檔案，請先選擇一個影片檔。");
    if (state === "empty") throw new Error("影片檔案是空的（0 位元組），請重新選擇。");

    var type = String(file.type || "").toLowerCase();
    var ext = extensionOf(file.name);
    if (type && type.indexOf("video/") !== 0) {
      throw new Error("「" + (file.name || "未命名檔案") + "」不是影片檔。請選擇 MP4 / WebM / MOV 等影片檔。");
    }
    if (!type && ext && VIDEO_EXTENSIONS.indexOf(ext) < 0) {
      throw new Error("「" + (file.name || "未命名檔案") + "」看起來不像影片檔（." + ext + "）。請選擇 MP4 / WebM / MOV 等影片檔。");
    }

    var url;
    try {
      url = global.URL.createObjectURL(file);
    } catch (err) {
      throw new Error("無法建立影片暫存位址（瀏覽器記憶體不足？）。請重新選擇檔案。");
    }

    var video = createHiddenVideo();
    var totalBytes = file.size;

    function reportLoading() {
      if (!onProgress) return;
      var ratio = 0;
      try {
        var duration = video.duration;
        if (video.buffered && video.buffered.length > 0 && isFinite(duration) && duration > 0) {
          ratio = clamp(video.buffered.end(video.buffered.length - 1) / duration, 0, 1);
        }
      } catch (err) {
        ratio = 0;
      }
      onProgress({
        phase: "loading",
        ratio: ratio,
        loadedBytes: Math.round(ratio * totalBytes),
        totalBytes: totalBytes,
        duration: isFinite(video.duration) ? video.duration : 0
      });
    }

    try {
      await new Promise(function (resolve, reject) {
        var settled = false;
        var timer = global.setTimeout(function () {
          finish(new Error("讀取影片資訊逾時（30 秒）。檔案可能過大或已損毀。"));
        }, METADATA_TIMEOUT_MS);

        function cleanup() {
          global.clearTimeout(timer);
          video.removeEventListener("loadedmetadata", onMetadata);
          video.removeEventListener("error", onError);
          video.removeEventListener("progress", reportLoading);
          video.removeEventListener("loadeddata", reportLoading);
        }
        function finish(err) {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) reject(err);
          else resolve();
        }
        function onMetadata() {
          finish(null);
        }
        function onError() {
          finish(new Error(videoErrorMessage(video.error)));
        }

        video.addEventListener("loadedmetadata", onMetadata);
        video.addEventListener("error", onError);
        video.addEventListener("progress", reportLoading);
        video.addEventListener("loadeddata", reportLoading);

        try {
          video.src = url;
          video.load();
        } catch (err) {
          finish(new Error("無法載入影片：" + (err && err.message ? err.message : String(err))));
        }
      });

      var duration = await resolveDuration(video);
      var width = video.videoWidth || 0;
      var height = video.videoHeight || 0;
      if (!width || !height) {
        throw new Error("無法取得影片解析度，檔案可能損毀或使用不支援的編碼。");
      }

      reportLoading();
      return {
        kind: "video",
        name: file.name || "影片",
        file: file,
        video: video,
        url: url,
        width: width,
        height: height,
        duration: duration,
        size: totalBytes
      };
    } catch (err) {
      // 失敗時不要留下懸空的 <video> / object URL
      try {
        video.removeAttribute("src");
        video.load();
      } catch (e) { /* 忽略 */ }
      if (video.parentNode) video.parentNode.removeChild(video);
      try {
        global.URL.revokeObjectURL(url);
      } catch (e) { /* 忽略 */ }
      throw err;
    }
  }

  /** 等 <img> 解碼完成（decode() 優先，失敗再靠 onload）。 */
  function loadImageElement(url) {
    return new Promise(function (resolve, reject) {
      var img = new global.Image();
      var settled = false;
      img.decoding = "async";
      function ok() {
        if (settled) return;
        settled = true;
        resolve(img);
      }
      function fail() {
        if (settled) return;
        settled = true;
        reject(new Error("圖片載入失敗，檔案可能損毀或格式不受支援（支援 PNG / JPG / WebP / BMP / GIF）。"));
      }
      img.onload = ok;
      img.onerror = fail;
      img.src = url;
      if (typeof img.decode === "function") {
        img.decode().then(ok, function () {
          // decode() 失敗時不一定會觸發 onerror → 補一個保險
          if (img.naturalWidth > 0) ok();
        });
      }
    });
  }

  /**
   * 本地圖片 → Source（gif 取第一幀）。
   * @param {File|Blob} file
   * @returns {Promise<object>} Source
   */
  async function createImageSource(file) {
    var state = fileKind(file);
    if (state === "invalid") throw new Error("沒有選擇圖片檔案，請先選擇一個圖片檔。");
    if (state === "empty") throw new Error("圖片檔案是空的（0 位元組），請重新選擇。");

    var type = String(file.type || "").toLowerCase();
    var ext = extensionOf(file.name);
    if (type && type.indexOf("image/") !== 0) {
      throw new Error("「" + (file.name || "未命名檔案") + "」不是圖片檔。請選擇 PNG / JPG / WebP / BMP / GIF。");
    }
    if (!type && ext && IMAGE_EXTENSIONS.indexOf(ext) < 0) {
      throw new Error("「" + (file.name || "未命名檔案") + "」看起來不像圖片檔（." + ext + "）。請選擇 PNG / JPG / WebP / BMP / GIF。");
    }

    var url;
    try {
      url = global.URL.createObjectURL(file);
    } catch (err) {
      throw new Error("無法建立圖片暫存位址（瀏覽器記憶體不足？）。請重新選擇檔案。");
    }

    try {
      var img = await loadImageElement(url);
      // createImageBitmap 對 GIF 會固定解第一幀（<img> 會動），能拿就拿；
      // 但也保留 <img> 以符合契約的 Source.image 形狀。
      var bitmap = null;
      if (typeof global.createImageBitmap === "function") {
        try {
          bitmap = await global.createImageBitmap(file);
        } catch (err) {
          bitmap = null;
        }
      }
      var width = bitmap ? bitmap.width : img.naturalWidth || img.width || 0;
      var height = bitmap ? bitmap.height : img.naturalHeight || img.height || 0;
      if (!width || !height) {
        throw new Error("無法取得圖片尺寸，檔案可能損毀。");
      }
      return {
        kind: "image",
        name: file.name || "圖片",
        file: file,
        image: img,
        bitmap: bitmap,
        url: url,
        width: width,
        height: height,
        duration: 0,
        size: file.size
      };
    } catch (err) {
      try {
        global.URL.revokeObjectURL(url);
      } catch (e) { /* 忽略 */ }
      throw err;
    }
  }

  /* ------------------------------------------------------------------ *
   * 2) 取某一秒的畫面
   * ------------------------------------------------------------------ */

  /** 正規化裁切框（契約：{l,r,t,b} 皆 0..1）。 */
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

  /**
   * 從「已繪製」的元素（video / img / ImageBitmap / canvas）取一塊區域畫到新 canvas。
   * crop 用正規化座標，結果至少 1x1；maxWidth 有給就等比縮到該寬（抽幀省記憶體用）。
   */
  function drawRegionToCanvas(element, sourceWidth, sourceHeight, crop, maxWidth) {
    var sw = Math.max(1, Math.round(sourceWidth));
    var sh = Math.max(1, Math.round(sourceHeight));

    var x1 = Math.round(crop.l * sw);
    var y1 = Math.round(crop.t * sh);
    var x2 = Math.round(crop.r * sw);
    var y2 = Math.round(crop.b * sh);
    x1 = clamp(x1, 0, sw - 1);
    y1 = clamp(y1, 0, sh - 1);
    x2 = clamp(x2, x1 + 1, sw);
    y2 = clamp(y2, y1 + 1, sh);
    var bw = x2 - x1;
    var bh = y2 - y1;

    var limit = toNumber(maxWidth, 0);
    var scale = limit > 0 && bw > limit ? limit / bw : 1;
    var dw = Math.max(1, Math.round(bw * scale));
    var dh = Math.max(1, Math.round(bh * scale));

    var canvas = global.document.createElement("canvas");
    canvas.width = dw;
    canvas.height = dh;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("無法建立 2D 畫布（瀏覽器記憶體不足？）。");
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";

    try {
      ctx.drawImage(element, x1, y1, bw, bh, 0, 0, dw, dh);
    } catch (err) {
      throw new Error("繪製畫面失敗：" + (err && err.message ? err.message : String(err)) +
        "（若是螢幕擷取，可能該分頁已停止分享）");
    }
    return canvas;
  }

  /**
   * 取得某一秒的畫面。
   * - kind==="video"：seek → 等 seeked → 等畫面被呈現 → drawImage
   * - kind==="image"：直接畫（忽略 timeSec）
   * - kind==="screen"：畫 live 的當前幀（不 seek）
   * @param {object} source
   * @param {number} timeSec
   * @param {{crop?: object, maxWidth?: number}} [options]
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function grabFrame(source, timeSec, options) {
    var opts = options || {};
    if (!source || typeof source !== "object") {
      throw new Error("沒有可用的來源，請先匯入影片、圖片，或擷取螢幕。");
    }
    var crop = normalizeCrop(opts.crop);
    var maxWidth = toNumber(opts.maxWidth, 0);
    var kind = source.kind;

    if (kind === "image") {
      var imageSource = source.bitmap || source.image;
      if (!imageSource) throw new Error("圖片來源不完整，請重新匯入圖片。");
      var iw = imageSource.width || imageSource.naturalWidth || source.width || 0;
      var ih = imageSource.height || imageSource.naturalHeight || source.height || 0;
      if (!iw || !ih) throw new Error("無法取得圖片尺寸，請重新匯入圖片。");
      return drawRegionToCanvas(imageSource, iw, ih, crop, maxWidth);
    }

    if (kind === "video" || kind === "screen") {
      var video = source.video || source.element || null;
      if (!video) throw new Error("來源缺少可用的 <video> 元素，請重新匯入或重新擷取。");

      if (kind === "video") {
        await seekVideo(video, timeSec);
        await waitForPresentedFrame(video);
      }
      if (video.readyState < 1) {
        throw new Error("影片畫面還沒準備好（可能正在載入或已中斷）。請稍候再試。");
      }
      var vw = video.videoWidth || source.width || 0;
      var vh = video.videoHeight || source.height || 0;
      if (!vw || !vh) throw new Error("無法取得影片解析度，請重新匯入影片。");
      return drawRegionToCanvas(video, vw, vh, crop, maxWidth);
    }

    throw new Error("不支援的來源類型：「" + String(kind) + "」。");
  }

  /* ------------------------------------------------------------------ *
   * 3) 螢幕 / 分頁擷取（桌面 Chromium）
   * ------------------------------------------------------------------ */

  /**
   * 開啟螢幕/分頁擷取。回傳可停止的即時來源。
   * @param {{audio?: boolean}} [options]
   * @returns {Promise<{stream: MediaStream, video: HTMLVideoElement, stop: function, ended: boolean, onended: function|null}>}
   */
  async function openScreenCapture(options) {
    var opts = options || {};
    var navigatorRef = global.navigator || {};
    var mediaDevices = navigatorRef.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== "function") {
      throw new Error(
        "此瀏覽器不支援螢幕/分頁擷取（getDisplayMedia）。" +
        "請改用「本地影片」匯入，或先用手機/電腦的螢幕錄影錄下來，再匯入影片檔。"
      );
    }

    var constraints = {
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: !!opts.audio
    };
    // 提示使用者選「分頁」而非整個螢幕（不支援的瀏覽器會忽略這兩個欄位）
    if (typeof constraints.video === "object") {
      constraints.video.displaySurface = "browser";
      constraints.video.selfBrowserSurface = "include";
    }

    var stream;
    try {
      stream = await mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      var name = err && err.name ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error("已取消螢幕/分頁擷取，或權限被拒絕。請重新按「擷取螢幕」並在彈出視窗選擇要分享的分頁。");
      }
      if (name === "NotFoundError") {
        throw new Error("找不到可擷取的螢幕或分頁，請確認瀏覽器允許螢幕分享。");
      }
      if (name === "NotReadableError") {
        throw new Error("螢幕擷取裝置無法使用（可能被其他程式佔用）。請關閉其他螢幕錄影/會議軟體後重試。");
      }
      if (name === "AbortError") {
        throw new Error("螢幕擷取被系統中止。");
      }
      if (name === "TypeError") {
        throw new Error("螢幕擷取參數不被這個瀏覽器接受（可能不支援 getDisplayMedia）。");
      }
      throw new Error("螢幕/分頁擷取失敗：" + (err && err.message ? err.message : "未知錯誤"));
    }

    var video = createHiddenVideo();
    video.autoplay = true;
    try {
      video.srcObject = stream;
    } catch (err) {
      try {
        stream.getTracks().forEach(function (track) { track.stop(); });
      } catch (e) { /* 忽略 */ }
      if (video.parentNode) video.parentNode.removeChild(video);
      throw new Error("無法把螢幕擷取畫面接到 video 元素：" + (err && err.message ? err.message : String(err)));
    }

    var endedFlag = false;
    // 回傳物件刻意做成「本身就是一個 Source」：kind/screenStream/video 都有，
    // 這樣 app.js 不論是 { kind:"screen", screenStream: r.stream, video: r.video }
    // 還是直接把 r 當 Source 用，都可以。
    var result = {
      kind: "screen",
      name: "螢幕擷取",
      stream: stream,
      screenStream: stream,
      video: video,
      ended: false,
      onended: null,
      width: 0,
      height: 0,
      duration: 0
    };

    function stop() {
      endedFlag = true;
      result.ended = true;
      try {
        video.pause();
      } catch (e) { /* 忽略 */ }
      try {
        video.srcObject = null;
      } catch (e) { /* 忽略 */ }
      if (video.parentNode) video.parentNode.removeChild(video);
      try {
        stream.getTracks().forEach(function (track) { track.stop(); });
      } catch (e) { /* 忽略 */ }
    }
    result.stop = stop;

    function onTrackEnded() {
      endedFlag = true;
      result.ended = true;
      if (typeof result.onended === "function") {
        try {
          result.onended();
        } catch (e) {
          if (global.console && global.console.error) global.console.error(e);
        }
      }
    }

    var tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
    if (tracks && tracks.length && typeof tracks[0].addEventListener === "function") {
      tracks[0].addEventListener("ended", onTrackEnded);
    } else if (tracks && tracks.length) {
      tracks[0].onended = onTrackEnded;
    }

    try {
      var played = video.play();
      if (played && typeof played.catch === "function") {
        played.catch(function () {
          /* 自動播放被擋時，下面的 readyState 等待會處理 */
        });
      }
      await waitVideoReady(video, LIVE_READY_TIMEOUT_MS, "等待螢幕擷取畫面");
    } catch (err) {
      stop();
      throw err instanceof Error ? err : new Error(String(err));
    }

    result.width = video.videoWidth || 0;
    result.height = video.videoHeight || 0;
    return result;
  }

  /* ------------------------------------------------------------------ *
   * 4) canvas → Blob
   * ------------------------------------------------------------------ */

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string} [type="image/png"]
   * @param {number} [quality=0.95]
   * @returns {Promise<Blob>}
   */
  function canvasToBlob(canvas, type, quality) {
    var mime = typeof type === "string" && type ? type : "image/png";
    var q = typeof quality === "number" && isFinite(quality) ? quality : 0.95;
    return new Promise(function (resolve, reject) {
      if (!canvas || typeof canvas.width !== "number" || canvas.width <= 0 || canvas.height <= 0) {
        reject(new Error("畫布是空的，無法轉成圖片。請先取得畫面。"));
        return;
      }
      if (typeof canvas.toBlob !== "function") {
        reject(new Error("此瀏覽器不支援 canvas.toBlob()，無法匯出圖片。"));
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          if (blob) {
            resolve(blob);
            return;
          }
          reject(new Error(
            "把畫布轉成 " + mime + " 失敗（可能是畫布尺寸過大或記憶體不足）。"
          ));
        }, mime, q);
      } catch (err) {
        var text = String((err && err.name ? err.name : "") + " " + (err && err.message ? err.message : err));
        if (/security|tainted/i.test(text)) {
          reject(new Error("畫布內容無法匯出（畫布已被跨網域內容汙染）。"));
          return;
        }
        reject(new Error("把畫布轉成圖片失敗：" + (err && err.message ? err.message : String(err))));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 額外小工具：釋放來源（app.js 換來源時呼叫，避免 memory leak）
   * ------------------------------------------------------------------ */

  function disposeSource(source) {
    if (!source || typeof source !== "object") return;
    try {
      if (source.video) {
        source.video.pause();
        source.video.removeAttribute("src");
        if (typeof source.video.load === "function") source.video.load();
        source.video.srcObject = null;
        if (source.video.parentNode) source.video.parentNode.removeChild(source.video);
      }
    } catch (err) { /* 忽略 */ }
    try {
      var streams = [source.stream, source.screenStream];
      for (var i = 0; i < streams.length; i++) {
        var st = streams[i];
        if (st && typeof st.getTracks === "function") {
          st.getTracks().forEach(function (track) {
            try { track.stop(); } catch (e) { /* 忽略 */ }
          });
        }
      }
    } catch (err) { /* 忽略 */ }
    try {
      if (source.bitmap && typeof source.bitmap.close === "function") source.bitmap.close();
    } catch (err) { /* 忽略 */ }
    try {
      if (source.url && String(source.url).indexOf("blob:") === 0) {
        global.URL.revokeObjectURL(source.url);
      }
    } catch (err) { /* 忽略 */ }
  }

  global.TabCapMedia = {
    version: API_VERSION,
    createVideoSource: createVideoSource,
    createImageSource: createImageSource,
    grabFrame: grabFrame,
    openScreenCapture: openScreenCapture,
    canvasToBlob: canvasToBlob,
    disposeSource: disposeSource,
    // 內部共用（capture.js 需要同樣的「兩次 rAF / rVFC」語意時可以直接用；
    // 契約沒有要求，屬額外曝光）
    afterNextPaint: afterNextPaint,
    isSeekable: function (source) {
      return !!(source && source.kind === "video" && source.video);
    }
  };
})(typeof window !== "undefined" ? window : this);
