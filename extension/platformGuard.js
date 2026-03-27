(() => {
  "use strict";

  const GUARD_VERSION = "2.1.0";
  const GUARD_SIGNATURE = "__clearorbit_guard_" + Math.random().toString(36).slice(2);
  const RECHECK_INTERVAL = 3000;
  const MAX_REINJECT_RETRIES = 3;

  const LOGOUT_SELECTORS = [
    '[href*="logout"]', '[href*="signout"]', '[href*="sign-out"]', '[href*="log-out"]',
    '[data-action*="logout"]', '[data-action*="signout"]',
    'button[aria-label*="Sign Out" i]', 'button[aria-label*="Log Out" i]',
    'a[aria-label*="Sign Out" i]', 'a[aria-label*="Log Out" i]',
    '[class*="logout" i]', '[class*="signout" i]',
    '[id*="logout" i]', '[id*="signout" i]'
  ];

  const RESTRICTED_KEYWORDS = [
    "logout", "sign out", "log out", "signout",
    "الخروج", "تسجيل الخروج", "cerrar sesión", "déconnexion",
    "settings", "account", "billing", "password", "profile",
    "الحساب", "الإعدادات"
  ];

  const RESTRICTED_URL_PATTERNS = [
    /\/account/i, /\/settings/i, /\/billing/i, /\/password/i,
    /\/profile\/edit/i, /\/YourAccount/i, /\/subscription/i,
    /\/cancel/i, /\/delete-account/i, /\/premium/i, /\/redeem/i
  ];

  const LOGOUT_URL_PATTERNS = [
    /\/logout/i, /\/signout/i, /\/sign-out/i, /\/log-out/i,
    /\/api\/logout/i, /\/auth\/logout/i, /\/session\/end/i
  ];

  let protectionsActive = true;
  let bannerElement = null;
  let toastContainer = null;
  let overlayElement = null;
  let observerInstance = null;
  let guardCheckInterval = null;
  let fetchOriginal = null;
  let xhrOpenOriginal = null;
  let pushStateOriginal = null;
  let replaceStateOriginal = null;

  function debugLog(msg, data) {
    try {
      chrome.runtime.sendMessage({
        action: "guard_log",
        level: "debug",
        category: "guard",
        message: msg,
        meta: data
      });
    } catch (e) {}
  }

  function warnLog(msg, data) {
    try {
      chrome.runtime.sendMessage({
        action: "guard_log",
        level: "warn",
        category: "guard",
        message: msg,
        meta: data
      });
    } catch (e) {}
  }

  function createToastContainer() {
    if (toastContainer && document.body.contains(toastContainer)) return;
    toastContainer = document.createElement("div");
    toastContainer.id = "clearorbit-toast-container";
    Object.assign(toastContainer.style, {
      position: "fixed", top: "20px", right: "20px", zIndex: "2147483646",
      display: "flex", flexDirection: "column", gap: "8px", pointerEvents: "none"
    });
    document.body.appendChild(toastContainer);
  }

  function showToast(message, type) {
    createToastContainer();
    const toast = document.createElement("div");
    const colors = { warn: "#F59E0B", error: "#EF4444", info: "#6C5CE7" };
    const bg = colors[type] || colors.info;
    Object.assign(toast.style, {
      background: bg, color: "#fff", padding: "12px 20px",
      borderRadius: "10px", fontSize: "13px", fontWeight: "600",
      fontFamily: "Inter, -apple-system, sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,0.2)", opacity: "0",
      transform: "translateX(40px)", transition: "all 0.3s ease",
      pointerEvents: "auto", maxWidth: "340px"
    });
    toast.textContent = message;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(0)";
    });
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(40px)";
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function showBanner() {
    if (bannerElement && document.body.contains(bannerElement)) return;
    bannerElement = document.createElement("div");
    bannerElement.id = "clearorbit-banner";
    bannerElement.setAttribute("data-guard", GUARD_SIGNATURE);
    Object.assign(bannerElement.style, {
      position: "fixed", bottom: "0", left: "0", right: "0", zIndex: "2147483645",
      background: "linear-gradient(135deg, #6C5CE7, #4F46E5)", color: "#fff",
      textAlign: "center", padding: "10px 16px", fontSize: "13px",
      fontWeight: "600", fontFamily: "Inter, -apple-system, sans-serif",
      boxShadow: "0 -4px 20px rgba(108,92,231,0.3)",
      display: "flex", alignItems: "center", justifyContent: "center", gap: "8px"
    });
    bannerElement.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg> This is a shared account. Do not modify settings.';
    document.body.appendChild(bannerElement);
  }

  function showOverlay(reason) {
    if (overlayElement && document.body.contains(overlayElement)) return;
    overlayElement = document.createElement("div");
    overlayElement.id = "clearorbit-overlay";
    overlayElement.setAttribute("data-guard", GUARD_SIGNATURE);
    Object.assign(overlayElement.style, {
      position: "fixed", inset: "0", zIndex: "2147483647",
      background: "rgba(15,15,26,0.92)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "Inter, -apple-system, sans-serif", opacity: "0",
      transition: "opacity 0.3s ease"
    });
    overlayElement.innerHTML = '<div style="text-align:center;color:#fff;max-width:400px;padding:40px">' +
      '<div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#EF4444,#DC2626);display:flex;align-items:center;justify-content:center;margin:0 auto 20px">' +
      '<svg width="32" height="32" fill="none" stroke="white" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg></div>' +
      '<h2 style="font-size:22px;font-weight:800;margin-bottom:8px">Access Restricted</h2>' +
      '<p id="clearorbit-overlay-reason" style="color:#94A3B8;font-size:14px;line-height:1.5;margin-bottom:24px"></p>' +
      '<button id="clearorbit-overlay-back" style="background:linear-gradient(135deg,#6C5CE7,#4F46E5);color:#fff;border:none;padding:12px 32px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(108,92,231,0.3)">Go Back</button></div>';
    const reasonEl = overlayElement.querySelector("#clearorbit-overlay-reason");
    if (reasonEl) reasonEl.textContent = reason || "This page is restricted on shared accounts.";
    document.body.appendChild(overlayElement);
    requestAnimationFrame(() => { overlayElement.style.opacity = "1"; });
    const backBtn = document.getElementById("clearorbit-overlay-back");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (overlayElement) {
          overlayElement.style.opacity = "0";
          setTimeout(() => { overlayElement.remove(); overlayElement = null; }, 300);
        }
        history.back();
      });
    }
    warnLog("Overlay shown", { reason });
  }

  function blockClickHandler(e) {
    if (!protectionsActive) return;
    const target = e.target.closest("a, button, [role='button'], [role='menuitem']");
    if (!target) return;

    const text = (target.textContent || "").trim().toLowerCase();
    const href = (target.getAttribute("href") || "").toLowerCase();

    const isLogout = RESTRICTED_KEYWORDS.some(kw => text.includes(kw) || href.includes(kw));
    if (!isLogout) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    showToast("Action blocked — shared account protection active", "warn");
    warnLog("Click blocked", { text, href });
  }

  function setupClickInterception() {
    document.addEventListener("click", blockClickHandler, true);
    debugLog("Click interception installed");
  }

  function setupMutationObserver() {
    if (observerInstance) observerInstance.disconnect();

    observerInstance = new MutationObserver((mutations) => {
      if (!protectionsActive) return;
      let needsScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) { needsScan = true; break; }
      }
      if (needsScan) scanAndBlockElements();
    });

    observerInstance.observe(document.documentElement, {
      childList: true, subtree: true
    });
    debugLog("MutationObserver installed");
  }

  function scanAndBlockElements() {
    const selector = LOGOUT_SELECTORS.join(", ");
    try {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        if (el.dataset.clearorbitBlocked) return;
        el.dataset.clearorbitBlocked = "1";
        el.style.pointerEvents = "none";
        el.style.opacity = "0.3";
        el.style.cursor = "not-allowed";
        el.removeAttribute("href");
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          showToast("Logout blocked — shared account", "warn");
        }, true);
      });
      if (elements.length > 0) {
        debugLog("Blocked " + elements.length + " element(s)");
      }
    } catch (e) {}
  }

  function setupNavigationGuard() {
    pushStateOriginal = history.pushState.bind(history);
    replaceStateOriginal = history.replaceState.bind(history);

    history.pushState = function(state, title, url) {
      if (url && isRestrictedUrl(url)) {
        warnLog("pushState blocked", { url });
        showToast("Navigation blocked — restricted page", "warn");
        return;
      }
      return pushStateOriginal(state, title, url);
    };

    history.replaceState = function(state, title, url) {
      if (url && isRestrictedUrl(url)) {
        warnLog("replaceState blocked", { url });
        showToast("Navigation blocked — restricted page", "warn");
        return;
      }
      return replaceStateOriginal(state, title, url);
    };

    window.addEventListener("popstate", () => {
      if (isRestrictedUrl(location.href)) {
        warnLog("popstate to restricted URL", { url: location.href });
        showOverlay("You cannot access account settings on a shared account.");
      }
    });

    debugLog("Navigation guard installed");
  }

  function setupNetworkInterception() {
    fetchOriginal = window.fetch;
    window.fetch = function(input, init) {
      const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      if (isLogoutRequest(url)) {
        warnLog("Fetch blocked", { url });
        showToast("Logout request blocked", "error");
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return fetchOriginal.apply(this, arguments);
    };

    xhrOpenOriginal = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (isLogoutRequest(url)) {
        warnLog("XHR blocked", { method, url });
        showToast("Logout request blocked", "error");
        this._blocked = true;
      }
      return xhrOpenOriginal.apply(this, arguments);
    };

    const xhrSendOriginal = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
      if (this._blocked) {
        Object.defineProperty(this, "status", { value: 200 });
        Object.defineProperty(this, "responseText", { value: "{}" });
        const event = new Event("load");
        setTimeout(() => this.dispatchEvent(event), 10);
        return;
      }
      return xhrSendOriginal.apply(this, arguments);
    };

    debugLog("Network interception installed");
  }

  function isRestrictedUrl(url) {
    try {
      const pathname = new URL(url, location.origin).pathname;
      return RESTRICTED_URL_PATTERNS.some(p => p.test(pathname));
    } catch (e) { return false; }
  }

  function isLogoutRequest(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return LOGOUT_URL_PATTERNS.some(p => p.test(lower)) ||
      lower.includes("logout") || lower.includes("signout") || lower.includes("session/end");
  }

  function checkProtectionsIntegrity() {
    let reapplied = false;

    if (!document.getElementById("clearorbit-banner")) {
      showBanner();
      reapplied = true;
    }

    if (history.pushState === pushStateOriginal || !history.pushState.toString().includes("isRestrictedUrl")) {
      setupNavigationGuard();
      reapplied = true;
    }

    if (window.fetch === fetchOriginal) {
      setupNetworkInterception();
      reapplied = true;
    }

    scanAndBlockElements();

    if (isRestrictedUrl(location.href)) {
      showOverlay("You cannot access account settings on a shared account.");
      reapplied = true;
    }

    if (reapplied) {
      warnLog("Protections re-applied (bypass detected)");
    }
  }

  function startIntegrityMonitor() {
    if (guardCheckInterval) clearInterval(guardCheckInterval);
    guardCheckInterval = setInterval(checkProtectionsIntegrity, RECHECK_INTERVAL);
    debugLog("Integrity monitor started", { interval: RECHECK_INTERVAL });
  }

  function detectDevToolsTampering() {
    let devtoolsOpen = false;
    const threshold = 160;
    const check = () => {
      const widthDiff = window.outerWidth - window.innerWidth > threshold;
      const heightDiff = window.outerHeight - window.innerHeight > threshold;
      if ((widthDiff || heightDiff) && !devtoolsOpen) {
        devtoolsOpen = true;
        warnLog("DevTools may be open");
        showToast("Developer tools detected — protections are active", "info");
      } else if (!widthDiff && !heightDiff) {
        devtoolsOpen = false;
      }
    };
    setInterval(check, 5000);
  }

  function setupSessionWatcher() {
    let retryCount = 0;
    const checkSession = () => {
      try {
        chrome.runtime.sendMessage({ action: "ping" }, (response) => {
          if (chrome.runtime.lastError || !response || !response.success) {
            if (retryCount < MAX_REINJECT_RETRIES) {
              retryCount++;
              warnLog("Extension connection lost, retry " + retryCount);
            }
          } else {
            retryCount = 0;
          }
        });
      } catch (e) {}
    };
    setInterval(checkSession, 30000);
  }

  function init() {
    debugLog("PlatformGuard initializing", { version: GUARD_VERSION, url: location.href });

    setupClickInterception();
    setupMutationObserver();
    setupNavigationGuard();
    setupNetworkInterception();
    showBanner();
    scanAndBlockElements();
    startIntegrityMonitor();
    detectDevToolsTampering();
    setupSessionWatcher();

    if (isRestrictedUrl(location.href)) {
      showOverlay("You cannot access account settings on a shared account.");
    }

    debugLog("PlatformGuard fully initialized");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
