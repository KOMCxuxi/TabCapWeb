/* ==========================================================================
 * TabCap 純前端版 · UI 小工具（window.TabCapUI）
 * --------------------------------------------------------------------------
 * 契約 API（CONTRACT.md）：
 *   toast(text, type = "info", ms = 2600)        type: info | success | error
 *   setBusy(button, busy, busyText = "處理中…")
 *   confirmDialog({ title, message, okText, cancelText }) -> Promise<boolean>
 *   setStage(n)                                  切換四步顯示與 stepper 高亮
 *   showOffline(offline)
 *   setupInstall({ onInstall })                  beforeinstallprompt + iOS 引導
 *   registerServiceWorker()                      只在 https / localhost 註冊
 *
 * 約定：
 * - 本檔不依賴 app.js，也不依賴任何第三方套件；找不到對應 DOM 時全部安靜跳過。
 * - 步驟面板是 `.step[data-step="1..4"]`；stepper 是 `#stepper li[data-step]`。
 * - setupInstall 的 onInstall：當瀏覽器沒有提供原生安裝提示（例如 iOS）時，
 *   改為呼叫 app.js 傳入的 onInstall，讓 app.js 決定要顯示什麼提示。
 * ========================================================================== */

(function () {
  "use strict";

  var doc = document;
  var dialogSeq = 0;
  var openDialogCount = 0;

  function byId(id) {
    return doc.getElementById(id);
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  /* ======================================================================
   * Toast
   * ==================================================================== */

  function toast(text, type, ms) {
    var host = byId("toastHost");
    var message = text == null ? "" : String(text);
    var kind = type === "success" || type === "error" ? type : "info";
    var ttl = isFiniteNumber(ms) && ms > 0 ? ms : 2600;

    if (!host) {
      if (message && typeof console !== "undefined" && console.info) {
        console.info("[TabCap]", message);
      }
      return;
    }

    // 同時最多 4 條，避免大量錯誤時洗版。
    while (host.children.length >= 4) {
      host.removeChild(host.firstElementChild);
    }

    var el = doc.createElement("div");
    el.className = "toast toast-" + kind;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = message;
    host.appendChild(el);

    // 先讓元素進 DOM，再加 class 才會觸發 transition。
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        el.classList.add("is-visible");
      });
    });

    window.setTimeout(function () {
      el.classList.remove("is-visible");
      window.setTimeout(function () {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }, 240);
    }, ttl);
  }

  /* ======================================================================
   * 按鈕 loading 狀態
   * ==================================================================== */

  function setBusy(button, busy, busyText) {
    if (!button || !button.dataset) {
      return;
    }
    var isBusy = busy === undefined ? true : Boolean(busy);
    var label = busyText === undefined ? "處理中…" : String(busyText);

    if (isBusy) {
      // 只在第一次進入 busy 時記住原始內容，避免連續呼叫把「處理中…」存成原字。
      if (button.dataset.tcIdleHtml === undefined) {
        button.dataset.tcIdleHtml = button.innerHTML;
        button.dataset.tcIdleDisabled = button.disabled ? "1" : "0";
        button.dataset.tcHasAriaBusy = button.hasAttribute("aria-busy") ? "1" : "0";
      }
      button.disabled = true;
      button.classList.add("is-loading");
      button.setAttribute("aria-busy", "true");
      if (label) {
        button.textContent = label;
      }
      return;
    }

    if (button.dataset.tcIdleHtml !== undefined) {
      button.innerHTML = button.dataset.tcIdleHtml;
      button.disabled = button.dataset.tcIdleDisabled === "1";
      delete button.dataset.tcIdleHtml;
      delete button.dataset.tcIdleDisabled;
    }
    button.classList.remove("is-loading");
    if (button.dataset.tcHasAriaBusy === "1") {
      button.setAttribute("aria-busy", "false");
    } else {
      button.removeAttribute("aria-busy");
    }
    delete button.dataset.tcHasAriaBusy;
  }

  /* ======================================================================
   * 對話框（confirmDialog 與 iOS 安裝引導共用）
   * ==================================================================== */

  function openDialog(options) {
    var opts = options || {};
    var title = opts.title || "";
    var message = opts.message || "";
    var nodes = Array.isArray(opts.nodes) ? opts.nodes : [];
    var actions = Array.isArray(opts.actions) ? opts.actions : [];
    var dismissible = opts.dismissible !== false;
    var defaultResult = opts.defaultResult === undefined ? null : opts.defaultResult;

    return new Promise(function (resolve) {
      var previouslyFocused = doc.activeElement;
      var previousOverflow = doc.body.style.overflow;
      var closed = false;
      var primaryButton = null;

      var backdrop = doc.createElement("div");
      backdrop.className = "ui-dialog-backdrop";

      var card = doc.createElement("div");
      card.className = "ui-dialog";
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      card.tabIndex = -1;

      if (title) {
        var titleId = "tc-dialog-title-" + ++dialogSeq;
        card.setAttribute("aria-labelledby", titleId);
        var heading = doc.createElement("h2");
        heading.className = "ui-dialog-title";
        heading.id = titleId;
        heading.textContent = title;
        card.appendChild(heading);
      }

      var body = doc.createElement("div");
      body.className = "ui-dialog-body";
      if (message) {
        var p = doc.createElement("p");
        p.className = "ui-dialog-message";
        p.textContent = message;
        body.appendChild(p);
      }
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i]) {
          body.appendChild(nodes[i]);
        }
      }
      if (body.childNodes.length) {
        card.appendChild(body);
      }

      var footer = doc.createElement("div");
      footer.className = "ui-dialog-actions";

      function close(result) {
        if (closed) {
          return;
        }
        closed = true;
        doc.removeEventListener("keydown", onKeydown, true);
        backdrop.classList.remove("is-visible");
        window.setTimeout(function () {
          if (backdrop.parentNode) {
            backdrop.parentNode.removeChild(backdrop);
          }
        }, 180);
        openDialogCount = Math.max(0, openDialogCount - 1);
        if (openDialogCount === 0) {
          doc.body.style.overflow = previousOverflow;
        }
        if (previouslyFocused && typeof previouslyFocused.focus === "function") {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch (err) {
            /* 忽略：元素可能已移除 */
          }
        }
        resolve(result);
      }

      function onKeydown(event) {
        if (event.key === "Escape" && dismissible) {
          event.preventDefault();
          close(defaultResult);
        }
      }

      for (var j = 0; j < actions.length; j += 1) {
        (function (action) {
          var btn = doc.createElement("button");
          btn.type = "button";
          var kind = action.kind === "primary" || action.kind === "danger"
            ? "primary"
            : action.kind === "ghost"
              ? "ghost"
              : "secondary";
          btn.className = "btn btn-" + kind;
          btn.textContent = action.label == null ? "" : String(action.label);
          btn.addEventListener("click", function () {
            close(action.value);
          });
          if (!primaryButton) {
            primaryButton = btn;
          } else if (action.primary) {
            primaryButton = btn;
          }
          footer.appendChild(btn);
        })(actions[j]);
      }

      if (footer.childNodes.length) {
        card.appendChild(footer);
      }
      backdrop.appendChild(card);
      doc.body.appendChild(backdrop);

      openDialogCount += 1;
      doc.body.style.overflow = "hidden";
      doc.addEventListener("keydown", onKeydown, true);

      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop && dismissible) {
          close(defaultResult);
        }
      });

      window.requestAnimationFrame(function () {
        backdrop.classList.add("is-visible");
      });

      var focusTarget = primaryButton || card;
      window.setTimeout(function () {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch (err) {
          /* 忽略 */
        }
      }, 30);
    });
  }

  function confirmDialog(options) {
    var opts = options || {};
    var title = opts.title == null ? "確認" : String(opts.title);
    var message = opts.message == null ? "" : String(opts.message);
    var okText = opts.okText == null ? "確定" : String(opts.okText);
    var cancelText = opts.cancelText == null ? "取消" : String(opts.cancelText);

    return openDialog({
      title: title,
      message: message,
      dismissible: true,
      defaultResult: false,
      actions: [
        { label: cancelText, kind: "ghost", value: false },
        { label: okText, kind: "primary", value: true, primary: true },
      ],
    }).then(function (result) {
      return result === true;
    });
  }

  /* ======================================================================
   * 步驟切換
   * ==================================================================== */

  var lastStage = null;
  var STAGE_COUNT = 4;

  function setStage(n) {
    var raw = Number(n);
    if (!isFinite(raw)) {
      raw = 1;
    }
    var stage = Math.min(STAGE_COUNT, Math.max(1, Math.round(raw)));

    var app = byId("app");
    if (app) {
      app.setAttribute("data-stage", String(stage));
    }

    var sections = doc.querySelectorAll(".step[data-step]");
    for (var i = 0; i < sections.length; i += 1) {
      var section = sections[i];
      var isTarget = Number(section.getAttribute("data-step")) === stage;
      section.classList.toggle("hidden", !isTarget);
      if (isTarget) {
        section.removeAttribute("aria-hidden");
      } else {
        section.setAttribute("aria-hidden", "true");
      }
    }

    var items = doc.querySelectorAll("#stepper li[data-step]");
    for (var j = 0; j < items.length; j += 1) {
      var li = items[j];
      var step = Number(li.getAttribute("data-step"));
      li.classList.toggle("is-active", step === stage);
      li.classList.toggle("is-done", step < stage);
      if (step === stage) {
        li.setAttribute("aria-current", "step");
      } else {
        li.removeAttribute("aria-current");
      }
    }

    if (lastStage !== stage) {
      if (lastStage !== null) {
        try {
          window.scrollTo({ top: 0, behavior: "smooth" });
        } catch (err) {
          window.scrollTo(0, 0);
        }
      }
      lastStage = stage;
    }
  }

  /* ======================================================================
   * 離線提示
   * ==================================================================== */

  function showOffline(offline) {
    var isOffline = Boolean(offline);
    if (doc.body) {
      doc.body.classList.toggle("is-offline", isOffline);
    }
    var banner = byId("offlineBanner");
    if (banner) {
      banner.classList.toggle("hidden", !isOffline);
      banner.setAttribute("aria-hidden", isOffline ? "false" : "true");
    }
  }

  /* ======================================================================
   * 安裝（PWA）
   * ==================================================================== */

  var installState = {
    deferred: null,
    callback: null,
    listenersBound: false,
    installed: false,
  };

  function isStandalone() {
    var media = window.matchMedia ? window.matchMedia("(display-mode: standalone)") : null;
    if (media && media.matches) {
      return true;
    }
    if (window.navigator && window.navigator.standalone === true) {
      return true;
    }
    return false;
  }

  function isIOS() {
    var ua = window.navigator.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua)) {
      return true;
    }
    // iPadOS 13+ 的 Safari 自稱 Macintosh。
    return window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  }

  function hideInstallButton() {
    var btn = byId("installButton");
    if (btn) {
      btn.classList.add("hidden");
    }
  }

  function revealInstallButton() {
    var btn = byId("installButton");
    if (btn && !isStandalone()) {
      btn.classList.remove("hidden");
    }
  }

  function buildIOSInstallNodes() {
    var list = doc.createElement("ol");
    list.className = "ui-dialog-list";
    var steps = [
      "用 Safari 開啟本頁（iPhone／iPad 只有 Safari 支援「加入主畫面」）。",
      "點一下底部工具列的「分享」按鈕（方框加上箭頭）。",
      "在選單中選擇「加入主畫面」，再點右上角「加入」。",
    ];
    for (var i = 0; i < steps.length; i += 1) {
      var li = doc.createElement("li");
      var num = doc.createElement("span");
      num.className = "ui-dialog-step-num";
      num.setAttribute("aria-hidden", "true");
      num.textContent = String(i + 1);
      var label = doc.createElement("span");
      label.textContent = steps[i];
      li.appendChild(num);
      li.appendChild(label);
      list.appendChild(li);
    }
    return list;
  }

  function showIOSInstallGuide() {
    return openDialog({
      title: "加到主畫面",
      message: "安裝後可全螢幕開啟，沒有瀏覽器網址列；離線也能打開頁面殼。",
      nodes: [buildIOSInstallNodes()],
      dismissible: true,
      defaultResult: true,
      actions: [{ label: "知道了", kind: "primary", value: true, primary: true }],
    });
  }

  function handleInstallClick() {
    if (installState.deferred && typeof installState.deferred.prompt === "function") {
      var promptEvent = installState.deferred;
      installState.deferred = null;
      var button = byId("installButton");
      if (button) {
        setBusy(button, true, "安裝中…");
      }
      var finish = function (message, type) {
        if (button) {
          setBusy(button, false);
        }
        toast(message, type);
      };
      Promise.resolve()
        .then(function () {
          promptEvent.prompt();
          return promptEvent.userChoice;
        })
        .then(function (choice) {
          var accepted = choice && choice.outcome === "accepted";
          if (accepted) {
            installState.installed = true;
            hideInstallButton();
            finish("已開始安裝 TabCap", "success");
          } else {
            finish("已取消安裝", "info");
          }
        })
        .catch(function () {
          finish("無法叫用安裝提示，請從瀏覽器選單手動安裝", "error");
        });
      return;
    }

    // 沒有原生提示：優先交給 app.js 自訂處理。
    if (typeof installState.callback === "function") {
      try {
        installState.callback({
          standalone: isStandalone(),
          supported: false,
          platform: isIOS() ? "ios" : "other",
        });
      } catch (err) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[TabCap] onInstall 回呼出錯：", err);
        }
      }
      return;
    }

    if (isIOS()) {
      showIOSInstallGuide();
      return;
    }
    toast("請從瀏覽器選單選擇「安裝應用程式」或「加到主畫面」", "info", 4200);
  }

  function bindInstallListeners() {
    if (installState.listenersBound) {
      return;
    }
    installState.listenersBound = true;

    var btn = byId("installButton");
    if (btn) {
      btn.addEventListener("click", function () {
        handleInstallClick();
      });
    }

    window.addEventListener("beforeinstallprompt", function (event) {
      try {
        event.preventDefault();
      } catch (err) {
        /* 忽略 */
      }
      installState.deferred = event;
      if (!isStandalone()) {
        revealInstallButton();
      }
    });

    window.addEventListener("appinstalled", function () {
      installState.deferred = null;
      installState.installed = true;
      hideInstallButton();
      toast("已安裝到主畫面", "success");
    });
  }

  function setupInstall(options) {
    var opts = options || {};
    if (typeof opts.onInstall === "function") {
      installState.callback = opts.onInstall;
    }
    bindInstallListeners();

    if (isStandalone() || installState.installed) {
      hideInstallButton();
      return;
    }
    // iOS 沒有 beforeinstallprompt，直接顯示按鈕，點了給引導。
    if (isIOS()) {
      revealInstallButton();
    }
  }

  /* ======================================================================
   * Service Worker 註冊
   * ==================================================================== */

  var swRegistrationStarted = false;

  function isServiceWorkerAllowed() {
    var loc = window.location;
    if (loc.protocol === "https:") {
      return true;
    }
    return loc.hostname === "localhost" || loc.hostname === "127.0.0.1" ||
      loc.hostname === "[::1]" || loc.hostname === "0.0.0.0";
  }

  function registerServiceWorker() {
    if (swRegistrationStarted) {
      return;
    }
    if (!("serviceWorker" in navigator)) {
      return;
    }
    if (!isServiceWorkerAllowed()) {
      return;
    }
    swRegistrationStarted = true;

    var start = function () {
      navigator.serviceWorker
        .register("./sw.js", { scope: "./", updateViaCache: "none" })
        .then(function (registration) {
          try {
            registration.update();
          } catch (err) {
            /* 忽略：更新檢查失敗不影響使用 */
          }
        })
        .catch(function (err) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[TabCap] Service Worker 註冊失敗（不影響主流程）：", err);
          }
        });
    };

    if (doc.readyState === "complete") {
      start();
    } else {
      window.addEventListener("load", start, { once: true });
    }
  }

  /* ======================================================================
   * 初始化（ui.js 自己就能跑；app.js 之後呼叫同名函式也安全）
   * ==================================================================== */

  function init() {
    showOffline(window.navigator.onLine === false);

    window.addEventListener("online", function () {
      showOffline(false);
    });
    window.addEventListener("offline", function () {
      showOffline(true);
    });

    setupInstall();
    registerServiceWorker();
  }

  window.TabCapUI = {
    toast: toast,
    setBusy: setBusy,
    confirmDialog: confirmDialog,
    setStage: setStage,
    showOffline: showOffline,
    setupInstall: setupInstall,
    registerServiceWorker: registerServiceWorker,
    // 額外便利函式（非契約必需，app.js 可選用）
    isStandalone: isStandalone,
    showIOSInstallGuide: showIOSInstallGuide,
  };

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
