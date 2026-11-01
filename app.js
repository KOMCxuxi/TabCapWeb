/**
 * TabCap Web（純靜態 PWA）— 主控制器
 *
 * 為什麼會有這個檔案：原本的 TabCap 是 Flask 後端 + 前端；這個版本把「後端」換成
 * 瀏覽器內的模組（media / capture / image / layout / export），由本檔案負責
 * 狀態機、四步流程與 UI 綁定。所有處理都在本機完成，沒有任何網路請求（除了載入靜態檔）。
 *
 * 依賴（index.html 會依序載入）：
 *   window.TabCapUI       → js/ui.js
 *   window.TabCapMedia    → js/media.js
 *   window.TabCapCapture   → js/capture.js
 *   window.TabCapImage     → js/image.js
 *   window.TabCapLayout    → js/layout.js
 *   window.TabCapExport    → js/export.js
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- DOM 工具
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const fmtSec = (s) => {
    const total = Math.max(0, Math.round(s));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const ui = () => window.TabCapUI || {};
  const toast = (text, type, ms) => (ui().toast ? ui().toast(text, type, ms) : console.log(text));
  const setStage = (n) => {
    state.stage = n;
    if (ui().setStage) {
      ui().setStage(n);
      return;
    }
    // ui.js 尚未載入時的保底：用 #step1..#step4 與 stepper 切換
    for (let i = 1; i <= 4; i += 1) {
      const section = $(`step${i}`);
      if (section) section.classList.toggle("hidden", i !== n);
    }
    document.querySelectorAll("#stepper li[data-step]").forEach((li) => {
      li.classList.toggle("is-active", Number(li.dataset.step) === n);
    });
  };
  const setBusy = (btn, busy, text) => (ui().setBusy ? ui().setBusy(btn, busy, text) : (btn && (btn.disabled = !!busy)));

  function setStatus(node, text, mode) {
    if (!node) return;
    node.textContent = text || "";
    node.dataset.mode = mode || "";
  }

  function setProgress(node, frac, text) {
    if (!node) return;
    const value = clamp(frac || 0, 0, 1);
    if (node.tagName === "PROGRESS") {
      node.max = 100;
      node.value = Math.round(value * 100);
    } else {
      node.textContent = text || `${Math.round(value * 100)}%`;
    }
    // index.html 的 <progress> 旁邊有獨立的文字節點：#<id>Text
    const textNode = node.id ? $(`${node.id}Text`) : null;
    if (textNode) textNode.textContent = text || `${Math.round(value * 100)}%`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function safeName(base, ext) {
    const name = (base || "TabCap").replace(/[\\/:*?"<>|]+/g, "_").trim() || "TabCap";
    return `${name}.${ext}`;
  }

  // ---------------------------------------------------------------- 全域狀態
  const state = {
    stage: 1,
    source: null,
    params2: {
      start: 0,
      end: 10,
      sampleEvery: 2,
      diffThreshold: 0.01,
      bandHalfWidth: 90,
      compareWindow: 1,
      crop: { l: 0, r: 1, t: 0, b: 1 },
    },
    captures: [],
    layout: {
      titleLines: ["", ""],
      margin: 40,
      spacing: 25,
      scale: 1,
      orientation: "portrait",
      align: "left",
      valign: "top",
      bgColor: "#ffffff",
      textColor: "#111111",
      binarize: false,
      invert: false,
    },
    busy: false,
    cancelRequested: false,
  };

  // ---------------------------------------------------------------- 第 1 步：匯入
  function stopScreenStream() {
    if (state.source && state.source.screenStream) {
      try {
        state.source.screenStream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    }
  }

  function resetSource() {
    stopScreenStream();
    if (state.source && state.source.url) {
      try {
        URL.revokeObjectURL(state.source.url);
      } catch (_) {}
    }
    state.source = null;
    state.captures.forEach((c) => c.url && URL.revokeObjectURL(c.url));
    state.captures = [];
    state.cancelRequested = true;
  }

  function describeSource(source) {
    if (!source) return "";
    if (source.kind === "screen") return `螢幕/分頁擷取（${source.width}×${source.height}）`;
    if (source.kind === "image") return `圖片：${source.name}（${source.width}×${source.height}）`;
    return `影片：${source.name}（${source.width}×${source.height}，${fmtSec(source.duration)}）`;
  }

  async function acceptSource(source) {
    resetSource();
    state.source = source;
    if ($("sourceInfo")) $("sourceInfo").textContent = describeSource(source);
    setStatus($("importStatus"), "已載入，請設定擷取範圍。", "success");

    // 預設時間範圍：整段（最長 10 分鐘，避免一次抽太多）；圖片不做區間。
    const duration = source.kind === "video" ? num(source.duration, 0) : 0;
    state.params2.start = 0;
    state.params2.end = source.kind === "screen"
      ? 60
      : duration > 0
        ? Math.min(duration, 600)
        : 10;
    syncStep2Inputs();
    setStage(2);
    await renderPreview(source.kind === "screen" ? 0 : state.params2.start);
    if (source.kind === "screen") startLivePreview();
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      setBusy($("importButton"), true, "載入中…");
      setStatus($("importStatus"), "正在讀取檔案…");
      const source = /^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name)
        ? await window.TabCapMedia.createImageSource(file)
        : await window.TabCapMedia.createVideoSource(file);
      await acceptSource(source);
    } catch (err) {
      console.error(err);
      setStatus($("importStatus"), err && err.message ? err.message : "檔案載入失敗。", "error");
      toast(err && err.message ? err.message : "檔案載入失敗。", "error");
    } finally {
      setBusy($("importButton"), false);
    }
  }

  async function handleScreenCapture() {
    if (!window.TabCapMedia || !window.TabCapMedia.openScreenCapture) {
      toast("此版本缺少媒體模組。", "error");
      return;
    }
    try {
      setBusy($("screenCaptureButton"), true, "等待選擇…");
      const screen = await window.TabCapMedia.openScreenCapture({ audio: false });
      const source = {
        kind: "screen",
        name: "螢幕擷取",
        video: screen.video,
        screenStream: screen.stream,
        stop: screen.stop,
        width: screen.video.videoWidth || 1280,
        height: screen.video.videoHeight || 720,
        duration: 0,
      };
      await acceptSource(source);
      setStatus($("importStatus"), "螢幕擷取已開始：請切回影片分頁播放，完成後按「生成圖片」。", "success");
    } catch (err) {
      console.error(err);
      setStatus($("importStatus"), err && err.message ? err.message : "無法開始螢幕擷取。", "error");
    } finally {
      setBusy($("screenCaptureButton"), false);
    }
  }

  // ---------------------------------------------------------------- 第 2 步：預覽與擷取
  let livePreviewTimer = null;

  function stopLivePreview() {
    if (livePreviewTimer) {
      cancelAnimationFrame(livePreviewTimer);
      livePreviewTimer = null;
    }
  }

  function startLivePreview() {
    stopLivePreview();
    const canvas = $("previewCanvas");
    const video = state.source && state.source.video;
    if (!canvas || !video) return;
    const draw = () => {
      if (!state.source || state.source.kind !== "screen" || state.stage !== 2) return;
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      try {
        canvas.getContext("2d").drawImage(video, 0, 0, w, h);
      } catch (_) {}
      livePreviewTimer = requestAnimationFrame(draw);
    };
    draw();
  }

  function cropParams() {
    return { ...state.params2.crop };
  }

  async function renderPreview(timeSec) {
    const canvas = $("previewCanvas");
    const source = state.source;
    if (!canvas || !source) return;
    if (source.kind === "screen") {
      startLivePreview();
      return;
    }
    try {
      const frame = await window.TabCapMedia.grabFrame(source, timeSec, { crop: cropParams() });
      const scale = Math.min(1, 1100 / Math.max(1, frame.width));
      canvas.width = Math.max(1, Math.round(frame.width * scale));
      canvas.height = Math.max(1, Math.round(frame.height * scale));
      canvas.getContext("2d").drawImage(frame, 0, 0, canvas.width, canvas.height);
      if ($("previewHint")) $("previewHint").textContent = `預覽時間：${fmtSec(timeSec)}`;
    } catch (err) {
      console.error(err);
      if ($("previewHint")) $("previewHint").textContent = "預覽失敗：" + (err.message || err);
    }
  }

  function syncStep2Inputs() {
    const p = state.params2;
    setTimeInputs("start", p.start);
    setTimeInputs("end", p.end);
    if ($("sampleEveryInput")) $("sampleEveryInput").value = p.sampleEvery;
    if ($("diffThresholdInput")) $("diffThresholdInput").value = p.diffThreshold;
    if ($("bandHalfWidthInput")) $("bandHalfWidthInput").value = p.bandHalfWidth;
    if ($("compareWindowInput")) $("compareWindowInput").value = p.compareWindow;
    if ($("cropLeftInput")) $("cropLeftInput").value = Math.round(p.crop.l * 100);
    if ($("cropRightInput")) $("cropRightInput").value = Math.round(p.crop.r * 100);
    if ($("cropTopInput")) $("cropTopInput").value = Math.round(p.crop.t * 100);
    if ($("cropBottomInput")) $("cropBottomInput").value = Math.round(p.crop.b * 100);
    updateRangeLabels();
  }

  function setTimeInputs(which, sec) {
    const m = $(`${which}MinInput`);
    const s = $(`${which}SecInput`);
    if (!m || !s) return;
    const total = Math.max(0, Math.floor(sec));
    m.value = String(Math.floor(total / 60));
    s.value = String(total % 60);
  }

  function getTimeInputs(which) {
    const m = num($(`${which}MinInput`) && $(`${which}MinInput`).value, 0);
    const s = num($(`${which}SecInput`) && $(`${which}SecInput`).value, 0);
    return Math.max(0, m * 60 + s);
  }

  function updateRangeLabels() {
    const left = $("cropLeftInput");
    const right = $("cropRightInput");
    const top = $("cropTopInput");
    const bottom = $("cropBottomInput");
    [
      [left, "cropLeftValue"], [right, "cropRightValue"],
      [top, "cropTopValue"], [bottom, "cropBottomValue"],
    ].forEach(([input, labelId]) => {
      const label = $(labelId);
      if (input && label) label.textContent = `${input.value}%`;
    });
  }

  function readStep2FromUI() {
    const p = state.params2;
    p.start = getTimeInputs("start");
    p.end = getTimeInputs("end");
    p.sampleEvery = Math.max(0.2, num($("sampleEveryInput") && $("sampleEveryInput").value, 2));
    p.diffThreshold = clamp(num($("diffThresholdInput") && $("diffThresholdInput").value, 0.01), 0, 1);
    p.bandHalfWidth = Math.max(0, Math.round(num($("bandHalfWidthInput") && $("bandHalfWidthInput").value, 90)));
    p.compareWindow = Math.max(1, Math.round(num($("compareWindowInput") && $("compareWindowInput").value, 1)));
    const readPct = (id, fallback) => {
      const node = $(id);
      return node ? clamp(num(node.value, fallback) / 100, 0, 1) : fallback;
    };
    const l = readPct("cropLeftInput", 0);
    const r = Math.max(l + 0.01, readPct("cropRightInput", 1));
    const t = readPct("cropTopInput", 0);
    const b = Math.max(t + 0.01, readPct("cropBottomInput", 1));
    p.crop = { l, r: Math.min(r, 1), t, b: Math.min(b, 1) };
    return p;
  }

  async function generateCaptures() {
    const source = state.source;
    if (!source || state.busy) return;
    readStep2FromUI();
    const p = state.params2;
    if (source.kind !== "image" && p.end <= p.start) {
      toast("結束時間必須大於開始時間。", "error");
      return;
    }
    state.busy = true;
    state.cancelRequested = false;
    setBusy($("generateButton"), true, "擷取中…");
    const progress = $("captureProgress");

    try {
      let frames = [];
      if (source.kind === "image") {
        const canvas = await window.TabCapMedia.grabFrame(source, 0, { crop: p.crop });
        frames = [{ t: 0, canvas }];
      } else if (source.kind === "screen") {
        setProgress(progress, 0, "正在即時取樣（請讓影片保持播放）…");
        frames = await window.TabCapCapture.sampleLive(source, p, {
          onProgress: ({ done, total }) => setProgress(progress, total ? done / total : 0, `即時取樣 ${done}/${total}`),
          shouldStop: () => state.cancelRequested,
        });
      } else {
        frames = await window.TabCapCapture.sampleVideo(source, p, {
          onProgress: ({ done, total }) => setProgress(progress, total ? done / total : 0, `抽幀 ${done}/${total}`),
          shouldStop: () => state.cancelRequested,
        });
      }
      if (!frames.length) throw new Error("沒有取到任何畫面，請調整範圍或參數。");

      let kept = frames;
      if (frames.length > 1) {
        setProgress(progress, 0, "正在去重…");
        const result = window.TabCapCapture.dedupe(frames, p, {
          onProgress: ({ done, total }) => setProgress(progress, total ? done / total : 0, `去重 ${done}/${total}`),
        });
        kept = result.kept && result.kept.length ? result.kept : frames;
      }

      setProgress(progress, 1, "整理截圖…");
      const captures = [];
      for (let i = 0; i < kept.length; i += 1) {
        const frame = kept[i];
        const blob = await window.TabCapMedia.canvasToBlob(frame.canvas, "image/png");
        const url = URL.createObjectURL(blob);
        captures.push({
          id: `c${Date.now().toString(36)}_${i}`,
          blob,
          url,
          t: frame.t || 0,
          w: frame.canvas.width,
          h: frame.canvas.height,
          crop: { l: 0, r: 1, t: 0, b: 1 },
          measures: [],
          hidden: false,
          _canvas: frame.canvas,
        });
      }
      state.captures = captures;
      state.params2.crop = { l: 0, r: 1, t: 0, b: 1 };

      // 進入第 3 步前先自動偵測小節線（失敗不影響流程）。
      if (window.TabCapImage && window.TabCapImage.detectMeasures) {
        for (let i = 0; i < captures.length; i += 1) {
          setProgress(progress, i / captures.length, `偵測小節線 ${i + 1}/${captures.length}`);
          try {
            const cropped = window.TabCapImage.cropCanvas(captures[i]._canvas, captures[i].crop);
            captures[i].measures = window.TabCapImage.detectMeasures(cropped) || [];
          } catch (_) {
            captures[i].measures = [];
          }
          if (i % 3 === 2) await new Promise((r) => setTimeout(r));
        }
      }

      setStage(3);
      renderCards();
      setProgress(progress, 1, `完成：保留 ${captures.length} 張（原始 ${frames.length} 張）`);
      toast(`已產生 ${captures.length} 張截圖。`, "success");
    } catch (err) {
      console.error(err);
      setProgress(progress, 0, "");
      toast(err && err.message ? err.message : "擷取失敗。", "error");
    } finally {
      state.busy = false;
      setBusy($("generateButton"), false);
    }
  }

  // ---------------------------------------------------------------- 第 3 步：卡片調整
  function showHidden() {
    const node = $("showHiddenCheckbox");
    return !!(node && node.checked);
  }

  function visibleCaptures() {
    return state.captures.filter((c) => showHidden() || !c.hidden);
  }

  async function renderCards() {
    const host = $("cards");
    if (!host) return;
    host.textContent = "";
    const list = visibleCaptures();
    if (!list.length) {
      host.appendChild(el("p", { className: "empty-hint" }, "沒有可顯示的截圖。"));
      return;
    }
    for (const cap of list) {
      host.appendChild(await buildCard(cap));
    }
  }

  async function captureCanvas(cap) {
    if (cap._canvas) return cap._canvas;
    const bitmap = await createImageBitmap(cap.blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    try { bitmap.close(); } catch (_) {}
    cap._canvas = canvas;
    return canvas;
  }

  async function buildCard(cap) {
    const card = el("article", { className: "card" });
    card.dataset.id = cap.id;
    if (cap.hidden) card.classList.add("is-hidden");

    const head = el("div", { className: "card-head" }, [
      el("span", { className: "badge" }, cap.t ? fmtSec(cap.t) : "圖片"),
      el("span", { className: "badge subtle" }, `${cap.w}×${cap.h}`),
    ]);
    const img = el("img", { className: "thumb", alt: "截圖預覽" });
    const thumbWrap = el("div", { className: "thumb-wrap" }, [img]);

    const measuresLayer = el("div", { className: "measures-layer", title: "點擊圖片可新增小節線" });
    thumbWrap.appendChild(measuresLayer);

    // 裁切滑桿
    const sliders = el("div", { className: "crop-grid" });
    const mkRange = (key, label) => {
      const input = el("input", {
        type: "range", min: "0", max: "100", step: "1", value: String(Math.round(cap.crop[key] * 100)),
        className: `crop-${key}`,
      });
      const value = el("span", { className: "crop-value" });
      const row = el("label", { className: "crop-row" }, [
        el("span", { className: "crop-label" }, label), input, value,
      ]);
      input.addEventListener("input", async () => {
        const v = clamp(num(input.value, 0) / 100, 0, 1);
        cap.crop[key] = v;
        value.textContent = `${input.value}%`;
        // 保證 l<r、t<b
        if (cap.crop.l >= cap.crop.r - 0.01) cap.crop.r = Math.min(1, cap.crop.l + 0.01);
        if (cap.crop.t >= cap.crop.b - 0.01) cap.crop.b = Math.min(1, cap.crop.t + 0.01);
        clearTimeout(card._thumbTimer);
        card._thumbTimer = setTimeout(() => refreshCardThumb(card, cap), 160);
      });
      value.textContent = `${input.value}%`;
      return row;
    };
    sliders.append(mkRange("l", "左"), mkRange("r", "右"), mkRange("t", "上"), mkRange("b", "下"));

    const actions = el("div", { className: "card-actions" });
    const hideBtn = el("button", { type: "button", className: "secondary-button hide-btn" },
      cap.hidden ? "取消隱藏" : "隱藏");
    hideBtn.addEventListener("click", async () => {
      cap.hidden = !cap.hidden;
      await renderCards();
    });
    const delBtn = el("button", { type: "button", className: "danger-button delete-btn" }, "刪除");
    delBtn.addEventListener("click", async () => {
      state.captures = state.captures.filter((c) => c.id !== cap.id);
      try { URL.revokeObjectURL(cap.url); } catch (_) {}
      await renderCards();
    });
    const measureBtn = el("button", { type: "button", className: "secondary-button auto-measure-btn" }, "重偵測小節線");
    measureBtn.addEventListener("click", async () => {
      try {
        const canvas = await captureCanvas(cap);
        const cropped = window.TabCapImage.cropCanvas(canvas, cap.crop);
        cap.measures = window.TabCapImage.detectMeasures(cropped) || [];
        drawMeasures(measuresLayer, cap);
      } catch (err) {
        toast(err.message || "小節線偵測失敗。", "error");
      }
    });
    actions.append(hideBtn, measureBtn, delBtn);

    card.append(head, thumbWrap);
    if (cap.measures && cap.measures.length) {
      const barInfo = el("div", { className: "measure-count" }, `小節線：${cap.measures.length}`);
      card.appendChild(barInfo);
    }
    card.append(sliders, actions);

    thumbWrap.addEventListener("click", async (event) => {
      if (!window.TabCapImage) return;
      const rect = thumbWrap.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      let croppedCan = null;
      try {
        const canvas = await captureCanvas(cap);
        croppedCan = window.TabCapImage.cropCanvas(canvas, cap.crop);
      } catch (err) {
        console.error(err);
      }
      if (!croppedCan) return;
      // 點在既有小節線附近 → 移除；否則新增
      const threshold = 0.02;
      const existing = (cap.measures || []).findIndex((m) => Math.abs(m - ratio) < threshold);
      if (existing >= 0) cap.measures.splice(existing, 1);
      else cap.measures = [...(cap.measures || []), ratio].sort((a, b) => a - b);
      drawMeasures(measuresLayer, cap);
    });

    refreshCardThumb(card, cap);
    drawMeasures(measuresLayer, cap);
    return card;
  }

  async function refreshCardThumb(card, cap) {
    const img = card.querySelector("img.thumb");
    if (!img || !window.TabCapImage) return;
    try {
      const canvas = await captureCanvas(cap);
      const cropped = window.TabCapImage.cropCanvas(canvas, cap.crop);
      const blob = await window.TabCapMedia.canvasToBlob(cropped, "image/jpeg", 0.85);
      const url = URL.createObjectURL(blob);
      const old = img.dataset.url;
      img.onload = () => {
        if (old) URL.revokeObjectURL(old);
      };
      img.src = url;
      img.dataset.url = url;
    } catch (err) {
      console.error(err);
    }
  }

  function drawMeasures(layer, cap) {
    if (!layer) return;
    layer.textContent = "";
    for (const m of cap.measures || []) {
      const tick = el("span", { className: "measure-tick" });
      tick.style.left = `${clamp(m, 0, 1) * 100}%`;
      layer.appendChild(tick);
    }
  }

  // ---------------------------------------------------------------- 第 4 步：排版與匯出
  let layoutTimer = null;
  let lastLayout = null;

  function readLayoutFromUI() {
    const L = state.layout;
    if ($("titleArea")) {
      const lines = $("titleArea").value.split("\n").map((s) => s.trim()).filter(Boolean);
      L.titleLines = lines.slice(0, 2);
    }
    L.margin = clamp(Math.round(num($("marginInput") && $("marginInput").value, 40)), 0, 300);
    L.spacing = clamp(Math.round(num($("spacingInput") && $("spacingInput").value, 25)), 0, 300);
    L.scale = clamp(num($("scaleInput") && $("scaleInput").value, 100) / 100, 0.1, 2);
    if ($("orientationPortrait") && $("orientationPortrait").getAttribute("aria-pressed") === "true") L.orientation = "portrait";
    if ($("orientationLandscape") && $("orientationLandscape").getAttribute("aria-pressed") === "true") L.orientation = "landscape";
    if ($("alignSelect")) L.align = $("alignSelect").value || "left";
    if ($("valignSelect")) L.valign = $("valignSelect").value || "top";
    if ($("bgColorInput")) L.bgColor = $("bgColorInput").value || "#ffffff";
    if ($("textColorInput")) L.textColor = $("textColorInput").value || "#111111";
    if ($("binarizeCheckbox")) L.binarize = !!$("binarizeCheckbox").checked;
    if ($("invertCheckbox")) L.invert = !!$("invertCheckbox").checked;
    return L;
  }

  function syncLayoutInputs() {
    const L = state.layout;
    if ($("titleArea")) $("titleArea").value = L.titleLines.join("\n");
    if ($("marginInput")) $("marginInput").value = L.margin;
    if ($("spacingInput")) $("spacingInput").value = L.spacing;
    if ($("scaleInput")) $("scaleInput").value = Math.round(L.scale * 100);
    if ($("alignSelect")) $("alignSelect").value = L.align;
    if ($("valignSelect")) $("valignSelect").value = L.valign;
    if ($("bgColorInput")) $("bgColorInput").value = L.bgColor;
    if ($("textColorInput")) $("textColorInput").value = L.textColor;
    if ($("binarizeCheckbox")) $("binarizeCheckbox").checked = L.binarize;
    if ($("invertCheckbox")) $("invertCheckbox").checked = L.invert;
    const portrait = $("orientationPortrait");
    const landscape = $("orientationLandscape");
    if (portrait && landscape) {
      const setPressed = () => {
        portrait.setAttribute("aria-pressed", String(L.orientation === "portrait"));
        landscape.setAttribute("aria-pressed", String(L.orientation === "landscape"));
      };
      setPressed();
      portrait.addEventListener("click", () => { L.orientation = "portrait"; setPressed(); scheduleLayout(); });
      landscape.addEventListener("click", () => { L.orientation = "landscape"; setPressed(); scheduleLayout(); });
    }
  }

  async function prepareLayoutItems() {
    const captures = state.captures.filter((c) => !c.hidden);
    const items = [];
    for (const cap of captures) {
      try {
        const canvas = await captureCanvas(cap);
        const cropped = window.TabCapImage.cropCanvas(canvas, cap.crop);
        const prepared = window.TabCapImage.drawPrepared(cropped, {
          binarize: state.layout.binarize,
          invert: state.layout.invert,
          bgColor: state.layout.bgColor,
        });
        const working = window.TabCapImage.toWorkingCanvas(prepared, 1600);
        items.push({ canvas: working.canvas, measures: cap.measures || [], scale: working.scale });
      } catch (err) {
        console.error("準備圖片失敗", err);
      }
    }
    return items;
  }

  function scheduleLayout() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => { renderLayout(); }, 220);
  }

  async function renderLayout() {
    if (!window.TabCapLayout || !window.TabCapImage) return;
    const host = $("pageList");
    if (!host) return;
    readLayoutFromUI();
    const items = await prepareLayoutItems();
    if (!items.length) {
      host.textContent = "";
      host.appendChild(el("p", { className: "empty-hint" }, "沒有可排版的截圖。"));
      lastLayout = null;
      return;
    }
    try {
      const opts = { ...state.layout };
      opts.titleLines = state.layout.titleLines.slice();
      const result = window.TabCapLayout.layoutPages(items, opts);
      const canvases = window.TabCapLayout.renderPages(result.pages, opts);
      lastLayout = { result, opts, canvases, items };
      host.textContent = "";
      canvases.forEach((canvas, index) => {
        const holder = el("figure", { className: "page-preview" });
        const scaled = document.createElement("canvas");
        const maxW = 640;
        const ratio = Math.min(1, maxW / canvas.width);
        scaled.width = Math.round(canvas.width * ratio);
        scaled.height = Math.round(canvas.height * ratio);
        scaled.getContext("2d").drawImage(canvas, 0, 0, scaled.width, scaled.height);
        holder.appendChild(scaled);
        holder.appendChild(el("figcaption", {}, `第 ${index + 1} / ${canvases.length} 頁`));
        host.appendChild(holder);
      });
      if ($("layoutProgress")) setProgress($("layoutProgress"), 1, `共 ${canvases.length} 頁`);
    } catch (err) {
      console.error(err);
      host.textContent = "";
      host.appendChild(el("p", { className: "empty-hint" }, "排版失敗：" + (err.message || err)));
    }
  }

  async function ensureLayout() {
    if (!lastLayout) await renderLayout();
    if (!lastLayout) throw new Error("沒有可匯出的頁面。");
    return lastLayout;
  }

  async function exportPdf() {
    if (state.busy) return;
    state.busy = true;
    setBusy($("downloadPdfButton"), true, "匯出中…");
    try {
      const { canvases, opts, result } = await ensureLayout();
      const { blob } = await window.TabCapExport.exportPdf(canvases, {
        title: (state.layout.titleLines[0] || "TabCap"),
        pageWidth: result.pages[0] && result.pages[0].width,
        pageHeight: result.pages[0] && result.pages[0].height,
      });
      downloadBlob(blob, safeName(state.layout.titleLines[0] || "TabCap", "pdf"));
      toast("PDF 已匯出。", "success");
    } catch (err) {
      console.error(err);
      toast(err.message || "PDF 匯出失敗。", "error");
    } finally {
      state.busy = false;
      setBusy($("downloadPdfButton"), false);
    }
  }

  async function exportLongImage() {
    if (state.busy) return;
    state.busy = true;
    setBusy($("downloadLongButton"), true, "匯出中…");
    try {
      const { canvases } = await ensureLayout();
      const blob = await window.TabCapExport.exportLongImage(canvases);
      downloadBlob(blob, safeName(state.layout.titleLines[0] || "TabCap", "png"));
      toast("長圖已匯出。", "success");
    } catch (err) {
      console.error(err);
      toast(err.message || "長圖匯出失敗。", "error");
    } finally {
      state.busy = false;
      setBusy($("downloadLongButton"), false);
    }
  }

  async function exportPsz() {
    if (state.busy) return;
    state.busy = true;
    setBusy($("downloadPszButton"), true, "匯出中…");
    try {
      const { canvases, opts, result } = await ensureLayout();
      const { bytes } = await window.TabCapExport.exportPdf(canvases, {
        title: state.layout.titleLines[0] || "TabCap",
      });
      const blob = await window.TabCapExport.exportPsz({
        pdfBytes: bytes,
        geometry: result.geometry,
        title: state.layout.titleLines[0] || "TabCap",
      });
      downloadBlob(blob, safeName(state.layout.titleLines[0] || "TabCap", "psz"));
      toast("PSZ 已匯出（可匯入 PDF Score）。", "success");
    } catch (err) {
      console.error(err);
      toast(err.message || "PSZ 匯出失敗。", "error");
    } finally {
      state.busy = false;
      setBusy($("downloadPszButton"), false);
    }
  }

  // ---------------------------------------------------------------- 事件綁定
  function bindEvents() {
    // 第 1 步
    const drop = $("dropZone");
    const fileInput = $("fileInput");
    if (drop && fileInput) {
      drop.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (file) handleFile(file);
      });
      ["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add("is-dragover");
      }));
      ["dragleave", "dragend"].forEach((name) => drop.addEventListener(name, (e) => {
        e.preventDefault();
        drop.classList.remove("is-dragover");
      }));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove("is-dragover");
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleFile(file);
      });
    }
    if ($("importButton")) $("importButton").addEventListener("click", () => fileInput && fileInput.click());
    if ($("screenCaptureButton")) $("screenCaptureButton").addEventListener("click", handleScreenCapture);

    // 第 2 步
    ["startMinInput", "startSecInput"].forEach((id) => {
      const node = $(id);
      if (node) node.addEventListener("change", () => {
        readStep2FromUI();
        if (state.source && state.source.kind !== "screen") renderPreview(state.params2.start);
      });
    });
    ["endMinInput", "endSecInput"].forEach((id) => {
      const node = $(id);
      if (node) node.addEventListener("change", readStep2FromUI);
    });
    ["cropLeftInput", "cropRightInput", "cropTopInput", "cropBottomInput"].forEach((id) => {
      const node = $(id);
      if (node) node.addEventListener("input", () => {
        updateRangeLabels();
        readStep2FromUI();
        clearTimeout(node._previewTimer);
        node._previewTimer = setTimeout(() => {
          if (state.source && state.source.kind !== "screen") renderPreview(state.params2.start);
        }, 200);
      });
    });
    if ($("generateButton")) $("generateButton").addEventListener("click", generateCaptures);
    if ($("backToStep2Button")) $("backToStep2Button").addEventListener("click", () => setStage(2));

    // 第 3 步
    if ($("toLayoutButton")) $("toLayoutButton").addEventListener("click", () => {
      setStage(4);
      syncLayoutInputs();
      scheduleLayout();
    });
    if ($("showHiddenCheckbox")) $("showHiddenCheckbox").addEventListener("change", () => renderCards());
    if ($("autoMeasuresButton")) $("autoMeasuresButton").addEventListener("click", async () => {
      setBusy($("autoMeasuresButton"), true, "偵測中…");
      try {
        for (const cap of state.captures) {
          const canvas = await captureCanvas(cap);
          const cropped = window.TabCapImage.cropCanvas(canvas, cap.crop);
          cap.measures = window.TabCapImage.detectMeasures(cropped) || [];
        }
        await renderCards();
        toast("小節線偵測完成。", "success");
      } catch (err) {
        toast(err.message || "小節線偵測失敗。", "error");
      } finally {
        setBusy($("autoMeasuresButton"), false);
      }
    });

    // 第 4 步：任何調整都重排
    ["marginInput", "spacingInput", "scaleInput", "alignSelect", "valignSelect",
      "bgColorInput", "textColorInput", "binarizeCheckbox", "invertCheckbox", "titleArea"].forEach((id) => {
      const node = $(id);
      if (!node) return;
      node.addEventListener("input", scheduleLayout);
      node.addEventListener("change", scheduleLayout);
    });
    if ($("downloadPdfButton")) $("downloadPdfButton").addEventListener("click", exportPdf);
    if ($("downloadLongButton")) $("downloadLongButton").addEventListener("click", exportLongImage);
    if ($("downloadPszButton")) $("downloadPszButton").addEventListener("click", exportPsz);
    if ($("backToStep3Button")) $("backToStep3Button").addEventListener("click", () => {
      setStage(3);
      renderCards();
    });
  }

  // ---------------------------------------------------------------- 初始化
  function checkModules() {
    const missing = [];
    if (!window.TabCapUI) missing.push("ui.js");
    if (!window.TabCapMedia) missing.push("media.js");
    if (!window.TabCapCapture) missing.push("capture.js");
    if (!window.TabCapImage) missing.push("image.js");
    if (!window.TabCapLayout) missing.push("layout.js");
    if (!window.TabCapExport) missing.push("export.js");
    if (missing.length) {
      console.error("缺少模組：", missing);
      const banner = $("offlineBanner");
      if (banner) {
        banner.textContent = "頁面載入不完整，缺少：" + missing.join("、");
        banner.classList.remove("hidden");
      }
      return false;
    }
    return true;
  }

  function exposeDebugApi() {
    // 給無頭測試用；不影響一般使用者。
    window.TabCapDebug = {
      get state() { return state; },
      async importFile(file) { await handleFile(file); },
      async runCapture() { await generateCaptures(); },
      goStage(n) { setStage(n); },
      async renderLayout() { await renderLayout(); },
      async exportPdfBytes() {
        const { canvases, result } = await ensureLayout();
        const out = await window.TabCapExport.exportPdf(canvases, {
          title: state.layout.titleLines[0] || "TabCap",
          pageWidth: result.pages[0] && result.pages[0].width,
          pageHeight: result.pages[0] && result.pages[0].height,
        });
        return out.bytes;
      },
      async exportPszBlob() {
        const { canvases, result } = await ensureLayout();
        const { bytes } = await window.TabCapExport.exportPdf(canvases, {
          title: state.layout.titleLines[0] || "TabCap",
        });
        return window.TabCapExport.exportPsz({
          pdfBytes: bytes, geometry: result.geometry,
          title: state.layout.titleLines[0] || "TabCap",
        });
      },
    };
  }

  function init() {
    bindEvents();
    syncStep2Inputs();
    syncLayoutInputs();
    setStage(1);
    if (ui().registerServiceWorker) ui().registerServiceWorker();
    if (ui().setupInstall) ui().setupInstall({});
    exposeDebugApi();
    if (checkModules()) {
      setStatus($("importStatus"), "可以拖入影片/圖片，或按「螢幕擷取」抓取正在播放的影片。");
    }
    // 離線提示
    const updateOnline = () => {
      if (ui().showOffline) ui().showOffline(!navigator.onLine);
      else {
        const banner = $("offlineBanner");
        if (banner) banner.classList.toggle("hidden", navigator.onLine);
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    updateOnline();
    // 沒選檔案時點 generate 給提示
    if ($("generateButton") && !state.source) {
      $("generateButton").addEventListener("click", () => {
        if (!state.source) toast("請先匯入影片或圖片。", "error");
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
