document.addEventListener("DOMContentLoaded", () => {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");

  chrome.runtime.sendMessage({ action: "ping" }, (response) => {
    if (response && response.success) {
      dot.className = "status-dot";
      text.className = "status-text";
      text.textContent = "ClearOrbit Active";
      const ver = response.version || "2.1.0";
      document.getElementById("versionText").textContent = ver;
      document.getElementById("footerVersion").textContent = ver;
    } else {
      dot.className = "status-dot inactive";
      text.className = "status-text inactive";
      text.textContent = "Extension Error";
    }
  });

  chrome.storage.local.get(["lastInjection", "heartbeatStatus", "lastHeartbeat", "clearorbit_update"], (data) => {
    if (data.lastInjection) {
      const info = data.lastInjection;
      document.getElementById("lastInjection").textContent = info.platform || "Unknown";
      const removed = info.oldCookiesRemoved ? " (" + info.oldCookiesRemoved + " old cleared)" : "";
      document.getElementById("cookiesSet").textContent = (info.cookiesSet || "0") + removed;
    }

    const hbStatus = data.heartbeatStatus || "idle";
    const hbEl = document.getElementById("heartbeatStatus");
    hbEl.textContent = hbStatus.charAt(0).toUpperCase() + hbStatus.slice(1);
    if (hbStatus === "active") hbEl.style.color = "#4ade80";
    else if (hbStatus === "inactive" || hbStatus === "error") hbEl.style.color = "#f87171";

    if (data.clearorbit_update && data.clearorbit_update.updateAvailable) {
      const verEl = document.getElementById("versionText");
      verEl.classList.add("update");
      verEl.textContent += " (update: v" + data.clearorbit_update.latestVersion + ")";
    }
  });

  document.getElementById("syncBtn").addEventListener("click", () => {
    const btn = document.getElementById("syncBtn");
    btn.textContent = "Syncing...";
    btn.disabled = true;
    chrome.runtime.sendMessage({ action: "force_sync" }, () => {
      btn.textContent = "Synced!";
      setTimeout(() => { btn.textContent = "Force Sync"; btn.disabled = false; }, 1500);
    });
  });

  const debugToggle = document.getElementById("debugToggle");
  chrome.runtime.sendMessage({ action: "get_debug_mode" }, (response) => {
    if (response && response.enabled) {
      debugToggle.classList.add("active");
    }
  });

  debugToggle.addEventListener("click", () => {
    const willEnable = !debugToggle.classList.contains("active");
    debugToggle.classList.toggle("active", willEnable);
    chrome.runtime.sendMessage({ action: "set_debug_mode", enabled: willEnable });
  });

  let logsVisible = false;
  const logPanel = document.getElementById("logPanel");
  const logActions = document.getElementById("logActions");
  const toggleLogsBtn = document.getElementById("toggleLogsBtn");

  toggleLogsBtn.addEventListener("click", () => {
    logsVisible = !logsVisible;
    logPanel.classList.toggle("visible", logsVisible);
    logActions.style.display = logsVisible ? "flex" : "none";
    toggleLogsBtn.textContent = logsVisible ? "Hide Logs" : "View Logs";
    if (logsVisible) loadLogs();
  });

  document.getElementById("refreshLogsBtn").addEventListener("click", loadLogs);

  document.getElementById("clearLogsBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clear_logs" }, () => {
      loadLogs();
    });
  });

  function loadLogs() {
    chrome.runtime.sendMessage({ action: "get_logs", filter: { limit: 100 } }, (response) => {
      if (!response || !response.logs) return;
      const logs = response.logs;
      const panel = document.getElementById("logPanel");
      const empty = document.getElementById("logEmpty");

      if (logs.length === 0) {
        panel.innerHTML = '<div class="log-empty">No logs recorded</div>';
        return;
      }

      panel.textContent = "";
      const reversed = logs.slice().reverse();
      for (const entry of reversed) {
        const time = entry.time ? entry.time.split("T")[1].split(".")[0] : "";
        const levelClass = entry.level === "warn" ? "warn" : entry.level === "error" ? "error" : "";
        const metaStr = entry.meta ? " " + JSON.stringify(entry.meta) : "";

        const row = document.createElement("div");
        row.className = "log-entry" + (levelClass ? " " + levelClass : "");

        const timeSpan = document.createElement("span");
        timeSpan.className = "log-time";
        timeSpan.textContent = time;

        const catSpan = document.createElement("span");
        catSpan.className = "log-cat";
        catSpan.textContent = "[" + (entry.cat || "") + "]";

        const msgNode = document.createTextNode((entry.msg || "") + metaStr);

        row.appendChild(timeSpan);
        row.appendChild(catSpan);
        row.appendChild(msgNode);
        panel.appendChild(row);
      }
    });
  }


});
