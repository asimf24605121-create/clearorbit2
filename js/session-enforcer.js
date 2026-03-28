(function () {
  'use strict';

  const POLL_INTERVAL_MS = 25000;
  const MAX_FAILURES = 2;

  let failureCount = 0;
  let enforcerInterval = null;
  let revokeHandled = false;

  function showSessionExpiredOverlay() {
    if (revokeHandled) return;
    revokeHandled = true;

    const existing = document.getElementById('co-session-expired-overlay');
    if (existing) return;

    const overlay = document.createElement('div');
    overlay.id = 'co-session-expired-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'background:rgba(15,15,26,0.97)', 'backdrop-filter:blur(8px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-family:Inter,-apple-system,sans-serif',
      'opacity:0', 'transition:opacity 0.35s ease'
    ].join(';');

    overlay.innerHTML =
      '<div style="text-align:center;color:#fff;max-width:400px;padding:40px">' +
      '<div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#EF4444,#DC2626);display:flex;align-items:center;justify-content:center;margin:0 auto 20px">' +
      '<svg width="32" height="32" fill="none" stroke="white" viewBox="0 0 24 24">' +
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>' +
      '</svg></div>' +
      '<h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Session Expired</h2>' +
      '<p style="color:#94A3B8;font-size:14px;line-height:1.5;margin:0 0 28px">' +
      'Your ClearOrbit session has ended. Platform access has been revoked.' +
      '</p>' +
      '<a href="/index.html" style="display:inline-block;background:linear-gradient(135deg,#6C5CE7,#4F46E5);color:#fff;text-decoration:none;padding:12px 32px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(108,92,231,0.3)">' +
      'Go to Login' +
      '</a>' +
      '</div>';

    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });
  }

  function handleRevoke(reason) {
    if (revokeHandled) return;
    clearInterval(enforcerInterval);
    try { sessionStorage.clear(); } catch (_) {}
    showSessionExpiredOverlay();
    setTimeout(function () {
      window.location.href = '/index.html?reason=' + encodeURIComponent(reason || 'session_expired');
    }, 3000);
  }

  async function validateSession() {
    try {
      const res = await fetch('/api/check_session', {
        credentials: 'include',
        cache: 'no-store'
      });

      if (res.status === 401 || res.status === 403) {
        failureCount++;
        if (failureCount >= MAX_FAILURES) {
          handleRevoke('session_expired');
        }
        return;
      }

      failureCount = 0;

    } catch (_) {
    }
  }

  function start() {
    enforcerInterval = setInterval(validateSession, POLL_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    setTimeout(start, 3000);
  }

  window.addEventListener('co:session_revoked', function () {
    handleRevoke('website_logout');
  });
})();
