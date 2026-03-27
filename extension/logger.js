const ClearOrbitLogger = (() => {
  const MAX_LOGS = 500;
  const LOG_KEY = "clearorbit_logs";
  const DEBUG_KEY = "clearorbit_debug_mode";

  let debugMode = false;
  let logBuffer = [];
  let flushTimer = null;

  async function init() {
    try {
      const data = await chrome.storage.local.get([DEBUG_KEY]);
      debugMode = data[DEBUG_KEY] === true;
    } catch (e) {
      debugMode = false;
    }
  }

  function log(level, category, message, meta) {
    const entry = {
      ts: Date.now(),
      time: new Date().toISOString(),
      level: level,
      cat: category,
      msg: message
    };
    if (meta) entry.meta = meta;

    if (debugMode || level === "error" || level === "warn") {
      logBuffer.push(entry);
      scheduleFlush();
    }

    const prefix = "[ClearOrbit:" + category + "]";
    if (level === "error") {
      console.error(prefix, message, meta || "");
    } else if (level === "warn") {
      console.warn(prefix, message, meta || "");
    } else if (debugMode) {
      console.log(prefix, message, meta || "");
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushLogs();
    }, 2000);
  }

  async function flushLogs() {
    if (logBuffer.length === 0) return;
    try {
      const data = await chrome.storage.local.get([LOG_KEY]);
      let existing = data[LOG_KEY] || [];
      existing = existing.concat(logBuffer);
      if (existing.length > MAX_LOGS) {
        existing = existing.slice(existing.length - MAX_LOGS);
      }
      await chrome.storage.local.set({ [LOG_KEY]: existing });
      logBuffer = [];
    } catch (e) {
      console.error("[ClearOrbit:Logger] Flush failed", e);
    }
  }

  async function getLogs(filter) {
    const data = await chrome.storage.local.get([LOG_KEY]);
    let logs = data[LOG_KEY] || [];
    if (filter) {
      if (filter.level) logs = logs.filter(l => l.level === filter.level);
      if (filter.category) logs = logs.filter(l => l.cat === filter.category);
      if (filter.since) logs = logs.filter(l => l.ts >= filter.since);
      if (filter.limit) logs = logs.slice(-filter.limit);
    }
    return logs;
  }

  async function clearLogs() {
    logBuffer = [];
    await chrome.storage.local.set({ [LOG_KEY]: [] });
  }

  async function setDebugMode(enabled) {
    debugMode = enabled;
    await chrome.storage.local.set({ [DEBUG_KEY]: enabled });
    log("info", "logger", "Debug mode " + (enabled ? "enabled" : "disabled"));
  }

  async function isDebugMode() {
    const data = await chrome.storage.local.get([DEBUG_KEY]);
    return data[DEBUG_KEY] === true;
  }

  init();

  return {
    info: (cat, msg, meta) => log("info", cat, msg, meta),
    warn: (cat, msg, meta) => log("warn", cat, msg, meta),
    error: (cat, msg, meta) => log("error", cat, msg, meta),
    debug: (cat, msg, meta) => log("debug", cat, msg, meta),
    getLogs,
    clearLogs,
    setDebugMode,
    isDebugMode,
    flush: flushLogs
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ClearOrbitLogger = ClearOrbitLogger;
}
