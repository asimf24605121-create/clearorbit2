window.safeFetch = async function(url, options = {}) {
    const opts = Object.assign({}, options, { credentials: 'include' });

    if (!opts.headers) opts.headers = {};
    if (typeof opts.headers === 'object' && !(opts.headers instanceof Headers)) {
        const csrf = sessionStorage.getItem('csrf_token');
        if (csrf && !opts.headers['X-CSRF-Token']) {
            opts.headers['X-CSRF-Token'] = csrf;
        }
    }

    try {
        let res = await fetch(url, opts);

        if (res.status === 403) {
            const errData = await res.clone().json().catch(() => ({}));
            if (errData.message && errData.message.toLowerCase().includes('csrf')) {
                const refreshed = await window._refreshCsrfToken();
                if (refreshed) {
                    opts.headers['X-CSRF-Token'] = sessionStorage.getItem('csrf_token');
                    res = await fetch(url, opts);
                }
            }
        }

        if (res.status === 401) {
            console.warn('[safeFetch] 401 from', url);
            sessionStorage.clear();
            window.location.href = 'index.html';
            return { ok: false, status: 401, data: { success: false, message: 'Session expired' }, redirected: true };
        }

        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            console.error('[safeFetch] JSON parse error from', url, parseErr);
            return { ok: false, status: res.status, data: { success: false, message: 'Invalid server response' }, redirected: false };
        }

        if (data.csrf_token) {
            sessionStorage.setItem('csrf_token', data.csrf_token);
        }

        return { ok: res.ok, status: res.status, data, redirected: false };
    } catch (networkErr) {
        console.error('[safeFetch] Network error for', url, networkErr);
        return { ok: false, status: 0, data: { success: false, message: 'Network error. Please check your connection.' }, redirected: false };
    }
};

window._refreshCsrfToken = async function() {
    try {
        const res = await fetch('api/csrf_token', { credentials: 'include' });
        const d = await res.json();
        if (d.csrf_token) {
            sessionStorage.setItem('csrf_token', d.csrf_token);
            if (typeof CSRF_TOKEN !== 'undefined') CSRF_TOKEN = d.csrf_token;
            return true;
        }
    } catch(e) {}
    return false;
};

window.csrfHeaders = function(extra) {
    const csrf = sessionStorage.getItem('csrf_token') || '';
    const base = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    return extra ? Object.assign(base, extra) : base;
};

window.safeFetchGet = async function(url) {
    return window.safeFetch(url);
};

window.safeFetchPost = async function(url, body) {
    return window.safeFetch(url, {
        method: 'POST',
        headers: window.csrfHeaders(),
        body: JSON.stringify(body)
    });
};
