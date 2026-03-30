window.safeClick = function(btn, asyncFn, opts = {}) {
    if (!btn || btn._safeClickBusy) return;
    const label = opts.loadingText || 'Working...';
    const origHtml = btn.innerHTML;
    btn._safeClickBusy = true;
    btn.disabled = true;
    btn.innerHTML = '<svg class="animate-spin inline w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>' + label;
    Promise.resolve().then(() => asyncFn()).catch(e => console.error('[safeClick]', e)).finally(() => {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        btn._safeClickBusy = false;
    });
};

window.debounce = function(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
};
