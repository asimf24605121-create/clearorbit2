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
// This file is loaded by admin.html, dashboard.html, and profile.html.
// Any changes here affect ALL pages — test boundaries before editing.

function smartTimeLabel(ms) {
    if (!ms || ms <= 0 || !isFinite(ms)) return 'Expired';
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
    if (s.includes(' ')) return new Date(s.replace(' ', 'T') + 'Z');
    if (s.includes('T')) return new Date(s.endsWith('Z') || s.includes('+') || s.indexOf('-', 11) > -1 ? s : s + 'Z');
    return new Date(s + 'T23:59:59Z');
}
