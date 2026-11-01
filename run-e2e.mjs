// TabCap Web 無頭端到端測試（Edge + CDP）
//
// 用法（先起靜態伺服器）：
//   python -m http.server 8123 --directory .
//   node tests/run-e2e.mjs --url http://127.0.0.1:8123/ --out tests/_shots/desktop --width 1440 --height 900
//
// 會做的事：
//   1) 載入頁面，等 TabCapDebug 出現
//   2) 用 tests/demo.mp4 走完 匯入 → 抽幀去重 → 排版 → 匯出 PDF/PSZ
//   3) 檢查 PDF 檔頭、PSZ 根目錄條目、頁數、console error、橫向溢出
//   4) 截圖並輸出 JSON 結果；失敗時 exit code 1
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333 + (process.pid % 300);

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const URL_ = arg("url", "http://127.0.0.1:8123/");
const OUT = resolve(arg("out", "tests/_shots/shot"));
const WIDTH = Number(arg("width", "1440"));
const HEIGHT = Number(arg("height", "900"));
const MOBILE = args.includes("--mobile");
mkdirSync(dirname(OUT), { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "tabcap-web-cdp-"));
const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  "--remote-allow-origins=*",
  "about:blank",
], { stdio: "ignore" });

let ws;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolve: resolvePromise, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 60000);
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error("eval exception: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

async function waitForDebug(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await evaluate("typeof window.TabCapDebug !== 'undefined'").catch(() => false);
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

const PIPELINE = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = {};
  try {
    // 測試素材：用 canvas + MediaRecorder 現場產生 6 秒 WebM（10fps）。
    // 這樣不依賴 demo 檔的編碼（Edge headless 不支援 OpenCV 的 mp4v / MPEG-4 Part 2）。
    async function makeDemoFile() {
      if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
        throw new Error("此瀏覽器不支援 MediaRecorder/captureStream，無法產生測試影片");
      }
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext("2d");
      const stream = canvas.captureStream(10);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm;codecs=vp8";
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start(120);
      const draw = (i) => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#282828";
        ctx.lineWidth = 2;
        for (let k = 0; k < 6; k += 1) {
          const y = Math.round(canvas.height * (0.32 + k * 0.07));
          ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(canvas.width - 60, y); ctx.stroke();
        }
        ctx.lineWidth = 3;
        for (let n = 0; n < 6; n += 1) {
          const x = ((i * 18 + n * 170) % (canvas.width + 200)) - 100;
          if (x >= 40 && x <= canvas.width - 40) {
            ctx.beginPath();
            ctx.moveTo(x, Math.round(canvas.height * 0.28));
            ctx.lineTo(x, Math.round(canvas.height * 0.76));
            ctx.stroke();
          }
        }
        ctx.fillStyle = "#1e1e1e";
        for (let n = 0; n < 4; n += 1) {
          const x = ((i * 30 + n * 210) % (canvas.width - 160)) + 80;
          const y = Math.round(canvas.height * (0.33 + (n % 3) * 0.07));
          ctx.fillRect(x, y - 5, 16, 10);
        }
      };
      for (let i = 0; i < 60; i += 1) {
        draw(i);
        await sleep(100);
      }
      recorder.stop();
      await stopped;
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      return new File([new Blob(chunks, { type: "video/webm" })], "tabcap-demo.webm", { type: "video/webm" });
    }

    const file = await makeDemoFile();
    res.demoBytes = file.size;
    await TabCapDebug.importFile(file);
    for (let i = 0; i < 100 && TabCapDebug.state.stage < 2; i++) await sleep(200);
    res.stageAfterImport = TabCapDebug.state.stage;
    res.duration = TabCapDebug.state.source && TabCapDebug.state.source.duration;
    res.videoSize = TabCapDebug.state.source
      ? [TabCapDebug.state.source.width, TabCapDebug.state.source.height]
      : null;
    if (res.stageAfterImport < 2) throw new Error("匯入後未進入第 2 步");

    const st = TabCapDebug.state;
    st.params2.start = 0;
    st.params2.end = Math.min(6, st.duration || 6);
    st.params2.sampleEvery = 1;
    st.params2.diffThreshold = 0.004;
    st.params2.bandHalfWidth = 40;
    st.params2.compareWindow = 1;
    await TabCapDebug.runCapture();
    res.captures = st.captures.length;
    res.stageAfterCapture = st.stage;
    res.firstCapture = st.captures[0] ? { w: st.captures[0].w, h: st.captures[0].h, t: st.captures[0].t } : null;
    res.measures = st.captures.map((c) => (c.measures || []).length);

    TabCapDebug.goStage(4);
    await TabCapDebug.renderLayout();
    await sleep(400);
    res.pages = document.querySelectorAll('#pageList .page-preview').length;

    const bytes = await TabCapDebug.exportPdfBytes();
    res.pdfLength = bytes.length;
    res.pdfHeader = Array.from(bytes.slice(0, 5)).map((b) => String.fromCharCode(b)).join('');
    const psz = await TabCapDebug.exportPszBlob();
    res.pszSize = psz.size;
    const zip = await JSZip.loadAsync(psz);
    res.pszEntries = Object.keys(zip.files);
    res.scoreJsonPresent = !!zip.files['score.json'];
    res.scoreJson = res.scoreJsonPresent ? await zip.files['score.json'].async('string') : null;

    res.scrollWidth = document.documentElement.scrollWidth;
    res.innerWidth = window.innerWidth;
    res.offlineBannerHidden = !!(document.getElementById('offlineBanner') || {}).classList?.contains('hidden');
    res.swRegistered = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  } catch (e) {
    res.error = String((e && (e.stack || e.message)) || e);
  }
  return JSON.stringify(res);
})()
`;

async function main() {
  // 等 DevTools
  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch {}
    await sleep(150);
  }
  if (!version) throw new Error("DevTools port not ready");
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: resolv, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolv(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: MOBILE,
  });
  if (MOBILE) {
    await send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
  }

  await send("Page.navigate", { url: URL_ });
  await sleep(1500);
  const ready = await waitForDebug(30000);
  if (!ready) {
    const html = await evaluate("document.body ? document.body.innerText.slice(0, 500) : 'no body'");
    throw new Error("TabCapDebug 未載入。頁面內容：" + html);
  }

  const pipeline = JSON.parse(await evaluate(PIPELINE));
  await sleep(500);

  // 截圖（全頁）
  const metrics = await send("Page.getLayoutMetrics");
  const content = metrics.cssContentSize || metrics.contentSize;
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: 0, y: 0,
      width: Math.max(WIDTH, Math.ceil(content.width)),
      height: Math.max(HEIGHT, Math.ceil(content.height)),
      scale: 1,
    },
    fromSurface: true,
  });
  writeFileSync(`${OUT}.png`, Buffer.from(shot.data, "base64"));

  // 可選：驗證 Service Worker 離線外殼（模擬 GitHub Pages 使用者斷網後重開）
  let offlineCheck = null;
  if (args.includes("--offline-check")) {
    // 先確保 SW 已控制頁面（e2e 的 pipeline 已經載入過一次）
    await sleep(1200);
    await send("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await send("Page.reload", { ignoreCache: true });
    await sleep(2500);
    offlineCheck = JSON.parse(await evaluate(`JSON.stringify({
      title: document.title,
      appLoaded: typeof window.TabCapDebug !== "undefined",
      bodyTextLength: (document.body && document.body.innerText || "").length,
      offlineBannerVisible: !!(document.getElementById("offlineBanner") && !document.getElementById("offlineBanner").classList.contains("hidden"))
    })`));
    await send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
  }

  const result = {
    url: URL_,
    viewport: { width: WIDTH, height: HEIGHT, mobile: MOBILE },
    pipeline,
    offlineCheck,
    consoleErrors,
    pageErrors,
    screenshot: `${OUT}.png`,
  };
  console.log(JSON.stringify(result, null, 2));

  const fail =
    !!pipeline.error ||
    pipeline.stageAfterImport !== 2 ||
    !(pipeline.captures >= 1) ||
    !(pipeline.pages >= 1) ||
    pipeline.pdfHeader !== "%PDF-" ||
    !pipeline.pszEntries?.includes("score.pdf") ||
    pipeline.scrollWidth !== pipeline.innerWidth ||
    consoleErrors.length > 0 ||
    pageErrors.length > 0 ||
    (offlineCheck !== null && (!offlineCheck.appLoaded || offlineCheck.bodyTextLength < 20));
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("E2E FAILED:", err && (err.stack || err.message || err));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { ws && ws.close(); } catch {}
    try { edge.kill(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  });
