/* ==========================================================================
 * TabCap 純前端版 · Service Worker
 * --------------------------------------------------------------------------
 * - 版本號：改靜態資源後請遞增 CACHE_VERSION，否則使用者裝置會沿用舊殼。
 * - 全部使用相對路徑：放在 GitHub Pages 的 /<repo>/ 子路徑也能運作。
 * - 導航請求 network-first；靜態資源 cache-first；/api/ 一律不快取（本版沒有 API）。
 * ========================================================================== */

const CACHE_VERSION = "tabcap-web-v1";
const CACHE_PREFIX = "tabcap-web-";

// 以 SW 檔案位置為基準解析相對路徑（GitHub Pages 子路徑安全）。
const BASE_URL = new URL("./", self.location.href);

function resolveUrl(path) {
  return new URL(path, BASE_URL).href;
}

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./js/ui.js",
  "./js/media.js",
  "./js/capture.js",
  "./js/image.js",
  "./js/layout.js",
  "./js/export.js",
  "./vendor/jszip.min.js",
  "./vendor/pdf-lib.min.js",
  "./manifest.webmanifest",
  "./assets/favicon-32.png",
  "./assets/apple-touch-icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
];

const SHELL_URL = resolveUrl("./index.html");
const ROOT_URL = resolveUrl("./");

const OFFLINE_JSON = JSON.stringify({ error: "offline", message: "目前離線，此版本沒有需要連線的 API。" });

/* ---------------------------------------------------------------- install */

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      // 逐檔預快取：任何單一資源缺席（例如尚未整合的模組）都不該讓整個安裝失敗。
      await Promise.all(
        PRECACHE_URLS.map(async (path) => {
          const url = resolveUrl(path);
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response && response.ok) {
              await cache.put(url, response);
            }
          } catch (err) {
            // 忽略單一資源的失敗（離線或 404）
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

/* --------------------------------------------------------------- activate */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

/* ------------------------------------------------------------- strategies */

function isApiRequest(url) {
  return url.pathname.indexOf("/api/") !== -1;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) ||
      (await cache.match(SHELL_URL)) ||
      (await cache.match(ROOT_URL));
    if (cached) {
      return cached;
    }
    return new Response("目前離線，且找不到已快取的頁面。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    return new Response("目前離線，資源尚未快取。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/* ----------------------------------------------------------------- fetch */

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }
  // 只處理同源請求；跨網域（例如使用者自行貼上的圖片網址）直接放行。
  if (url.origin !== self.location.origin) {
    return;
  }

  // 本版沒有後端 API；即使未來有人加了 /api/ 也絕不快取，離線時直接回 503。
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_JSON, {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          })
      )
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/* --------------------------------------------------------------- message */

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
