const CLEARORBIT_BASE = window.location.origin;

console.log("[ClearOrbit] Content script loaded on:", window.location.href);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "CLEARORBIT_LOGIN") return;

  console.log("[ClearOrbit] Message received from page:", event.data.type, "| Platform ID:", event.data.platformId);

  const platformId = event.data.platformId;
  const cookieData = event.data.cookieData || null;
  if (!platformId) return;

  if (cookieData && cookieData.success) {
    const hasStorageData = (cookieData.localStorage && Object.keys(cookieData.localStorage).length > 0)
      || (cookieData.sessionStorage && Object.keys(cookieData.sessionStorage).length > 0);
    const loginAction = hasStorageData ? "full_session_login" : "login";

    console.log("[ClearOrbit] Session injection — Platform:", cookieData.platform_name,
      "| Domain:", cookieData.domain,
      "| Redirect:", cookieData.redirect_url,
      "| Cookies:", cookieData.count,
      "| Mode:", loginAction);

    chrome.runtime.sendMessage(
      {
        action: loginAction,
        cookieString: cookieData.cookie_string,
        cookies: cookieData.cookies || null,
        domain: cookieData.domain,
        platformName: cookieData.platform_name,
        platformId: platformId,
        redirectUrl: cookieData.redirect_url || null,
        accountId: cookieData.account_id || null,
        sessionId: cookieData.session_id || null,
        browserSessionId: event.data.browserSessionId || null,
        serverBaseUrl: event.data.serverBaseUrl || CLEARORBIT_BASE,
        localStorage: cookieData.localStorage || null,
        sessionStorage: cookieData.sessionStorage || null,
      },
      (response) => {
        window.postMessage({
          type: "CLEARORBIT_RESPONSE",
          platformId: platformId,
          success: response ? response.success : false,
          message: response ? response.message : "Extension not responding.",
          redirectUrl: response ? response.redirectUrl : null
        }, "*");
      }
    );
    return;
  }

  const slot = event.data.slot || 1;
  console.log("[ClearOrbit] Legacy login request — Platform ID:", platformId, "Slot:", slot);

  fetch(CLEARORBIT_BASE + "/api/get_cookie.php?id=" + platformId + "&slot=" + slot, { credentials: "include" })
    .then(res => {
      if (!res.ok) {
        return res.json().catch(() => ({ success: false, message: "Server error (HTTP " + res.status + ")" }));
      }
      return res.json();
    })
    .then(data => {
      if (!data.success) {
        console.warn("[ClearOrbit] Server error:", data.message);
        window.postMessage({
          type: "CLEARORBIT_RESPONSE",
          platformId: platformId,
          success: false,
          message: data.message || "Failed to fetch cookie.",
          redirectUrl: null
        }, "*");
        return;
      }

      if (!data.platform_id || parseInt(data.platform_id) !== parseInt(platformId)) {
        console.error("[ClearOrbit] Platform ID mismatch! Requested:", platformId, "Got:", data.platform_id);
        window.postMessage({
          type: "CLEARORBIT_RESPONSE",
          platformId: platformId,
          success: false,
          message: "Platform validation failed. Please try again.",
          redirectUrl: null
        }, "*");
        return;
      }

      console.log("[ClearOrbit] Server response — Platform:", data.platform_name,
        "| Domain:", data.domain,
        "| Redirect:", data.redirect_url,
        "| Cookies:", data.count);

      chrome.runtime.sendMessage(
        {
          action: "login",
          cookieString: data.cookie_string,
          cookies: data.cookies || null,
          domain: data.domain,
          platformName: data.platform_name,
          platformId: platformId,
          redirectUrl: data.redirect_url || null,
          localStorage: data.localStorage || null,
          sessionStorage: data.sessionStorage || null,
          authHeaders: data.authHeaders || null,
          authType: data.authType || null,
          accountId: data.account_id || null,
        },
        (response) => {
          window.postMessage({
            type: "CLEARORBIT_RESPONSE",
            platformId: platformId,
            success: response ? response.success : false,
            message: response ? response.message : "Extension not responding.",
            redirectUrl: response ? response.redirectUrl : null
          }, "*");
        }
      );
    })
    .catch(err => {
      console.error("[ClearOrbit] Network error:", err.message);
      window.postMessage({
        type: "CLEARORBIT_RESPONSE",
        platformId: platformId,
        success: false,
        message: "Network error: " + err.message,
        redirectUrl: null
      }, "*");
    });
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "CLEARORBIT_PING") return;

  chrome.runtime.sendMessage({ action: "ping" }, (response) => {
    window.postMessage({
      type: "CLEARORBIT_PONG",
      success: response ? response.success : false,
      version: response ? response.version : null
    }, "*");
  });
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "CLEARORBIT_LOGOUT") return;

  console.log("[ClearOrbit] Logout message received from page, action:", event.data.action);

  if (event.data.action === "FORCE_BROWSER_LOGOUT") {
    chrome.runtime.sendMessage({
      action: "FORCE_BROWSER_LOGOUT",
      platforms: event.data.platforms || []
    }, (response) => {
      console.log("[ClearOrbit] Force browser logout result:", response ? response.success : false);
    });
  } else if (event.data.action === "CLEAR_ALL_COOKIES") {
    chrome.runtime.sendMessage({
      action: "CLEAR_ALL_COOKIES"
    }, (response) => {
      console.log("[ClearOrbit] Full cookie cleanup on logout:", response ? response.success : false);
    });
  } else {
    chrome.runtime.sendMessage({
      action: "clear_injected_cookies"
    }, (response) => {
      console.log("[ClearOrbit] Cookies cleared on logout:", response ? response.success : false);
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "verification_result") {
    console.log("[ClearOrbit] Login verification result:", message.status, "| Platform:", message.platformId, "| Reason:", message.reason);
    window.postMessage({
      type: "CLEARORBIT_VERIFICATION",
      platformId: message.platformId,
      accountId: message.accountId,
      status: message.status,
      reason: message.reason
    }, "*");
    sendResponse({ received: true });
    return false;
  }

  if (message.type === "CLEARORBIT_TAB_CLOSED") {
    window.postMessage({
      type: "CLEARORBIT_TAB_CLOSED",
      platformId: message.platformId,
      sessionId: message.sessionId || null
    }, "*");
    sendResponse({ received: true });
    return false;
  }

  if (message.type === "CLEARORBIT_PLATFORM_REVOKED") {
    console.log("[ClearOrbit] Platform access revoked:", message.platforms);
    window.postMessage({
      type: "CLEARORBIT_LOGOUT",
      action: "FORCE_BROWSER_LOGOUT",
      platforms: message.platforms || []
    }, "*");
    sendResponse({ received: true });
    return false;
  }
});

fetch(CLEARORBIT_BASE + "/api/heartbeat.php", { credentials: "include" })
  .then(res => res.json())
  .then(data => {
    chrome.runtime.sendMessage({
      action: "heartbeat_result",
      active: data.active || false,
      status: data.status || "unknown"
    });
  })
  .catch(() => {});
