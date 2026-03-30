// ═══════════════════════════════════════════════════════════════════════════
// TIME-DISPLAY RULES — single source of truth for the entire frontend.
// Backend equivalent: backend/utils/helpers.js → formatRemainingMs()
//
// Boundaries (all use Math.floor — NEVER Math.ceil for remaining-time display):
//   ≤ 0ms        → "Expired"
//   < 60s        → "<1m"
//   < 1h         → "{M}m"
//   < 24h        → "{H}h {M}m"          (strict <, so exactly 24h → days path)
//   ≥ 24h        → "{D}d {H}h"          (omit hours if exactly 0)
//
// Loaded by: admin.html, dashboard.html, profile.html
// DO NOT duplicate this logic inline — use these functions.
// DO NOT use Math.ceil for remaining-time day display.
// Run regression tests before any change: node backend/tests/timeDisplay.test.js
// ═══════════════════════════════════════════════════════════════════════════

var _timeDisplayVersion = 1;

function smartTimeLabel(ms) {
    if (!ms || ms <= 0 || !isFinite(ms)) {
        if (typeof ms !== 'number' || isNaN(ms) || !isFinite(ms)) {
            if (ms !== 0 && ms !== null && ms !== undefined) {
                _tdWarnEdge('smartTimeLabel', ms);
            }
        }
        return 'Expired';
    }
    if (ms < 60000) return '<1m';
    var totalMins = Math.floor(ms / 60000);
    if (totalMins < 60) return totalMins + 'm';
    var hours = Math.floor(ms / 3600000);
    var mins = Math.floor((ms % 3600000) / 60000);
    if (hours < 24) return mins > 0 ? hours + 'h ' + mins + 'm' : hours + 'h';
    var days = Math.floor(ms / 86400000);
    var remH = Math.floor((ms % 86400000) / 3600000);
    return remH > 0 ? days + 'd ' + remH + 'h' : days + 'd';
}

function smartTimeLabelWithSuffix(ms) {
    var label = smartTimeLabel(ms);
    if (label === 'Expired' || label === '<1m') return label;
    return label + ' left';
}

function parseEndDateFE(d) {
    if (!d) return new Date(0);
    var s = String(d).trim();
    var result;
    if (s.includes(' ')) result = new Date(s.replace(' ', 'T') + 'Z');
    else if (s.includes('T')) result = new Date(s.endsWith('Z') || s.includes('+') || s.indexOf('-', 11) > -1 ? s : s + 'Z');
    else result = new Date(s + 'T23:59:59Z');
    if (isNaN(result.getTime())) {
        _tdWarnEdge('parseEndDateFE', d);
        return new Date(0);
    }
    return result;
}

function _tdWarnEdge(fn, val) {
    if (typeof console !== 'undefined' && console.warn) {
        console.warn('[timeDisplay] ' + fn + ' received invalid input:', val);
    }
}

(function _tdDevGuard() {
    if (typeof window === 'undefined') return;
    var isDev = window.location.hostname === 'localhost' ||
                window.location.hostname.includes('.replit.dev') ||
                window.location.hostname.includes('127.0.0.1');
    if (!isDev) return;

    if (!window._TD_SHARED_LOADED) {
        window._TD_SHARED_LOADED = true;
    }

    if (typeof MutationObserver !== 'undefined') {
        var observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                m.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1 && node.tagName === 'SCRIPT' && node.textContent) {
                        var txt = node.textContent;
                        if (/Math\.ceil\s*\([^)]*\/\s*(86400000|86400)/i.test(txt)) {
                            console.error('[timeDisplay] REGRESSION: Math.ceil used for day calculation. Use shared smartTimeLabel() from js/timeDisplay.js');
                        }
                        if (/function\s+(smartTimeLabel|formatRemainingMs|smartTimeLabelWithSuffix)\s*\(/i.test(txt) && !txt.includes('_timeDisplayVersion')) {
                            console.error('[timeDisplay] REGRESSION: Duplicate time formatter detected. Use shared functions from js/timeDisplay.js — do not reimplement.');
                        }
                        if (/\.toISOString\(\)\.substring\(0,\s*10\)/.test(txt) && /endDate|expir/i.test(txt)) {
                            console.error('[timeDisplay] REGRESSION: Date-only comparison for expiry detected. Use parseEndDateUTC/parseEndDateFE for full datetime comparison.');
                        }
                    }
                });
            });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
