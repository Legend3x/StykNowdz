// Runs first on the web page (a classic script, before the editor's modules): a browser that lacks something the
// editor cannot work without gets a plain explanation instead of a blank page. Nothing here loads the editor.
// build-web.mjs adds this script to the web page only; the desktop app ships its own Chromium.
(() => {
  // The editor is several hundred module files. If one of them fails to arrive (a dropped connection, or Chrome
  // now and then cancelling module requests its service worker has already answered), the whole module graph is
  // abandoned without an error message and the page stays blank. A fresh page loads it again; after two tries in
  // a row the person is told instead. The count lives in this tab's session storage, so it cannot loop.
  const RETRIES = 'styk-boot-retries', MAX_RETRIES = 2, WINDOW = 60000;
  let failed = false;
  const retries = () => {
    try { const saved = JSON.parse(sessionStorage.getItem(RETRIES)); return saved && Date.now() - saved.at < WINDOW ? saved.tries : 0; } catch { return MAX_RETRIES; }
  };
  addEventListener('error', event => {
    const script = event.target;
    if (failed || !(script instanceof HTMLScriptElement) || script.type !== 'module' || !/\/src\/app\.mjs(?:[?#]|$)/.test(script.src)) return;
    failed = true;
    const tries = retries();
    if (tries < MAX_RETRIES) {
      try { sessionStorage.setItem(RETRIES, JSON.stringify({tries: tries + 1, at: Date.now()})); location.reload(); return; } catch { /* no session storage: say so instead of risking a loop */ }
    }
    try { sessionStorage.removeItem(RETRIES); } catch { /* nothing to clear */ }
    explain('StykNowdz could not finish loading', ['Part of the editor did not arrive. Check the connection, then reload the page.'], {action: 'Reload', pageTitle: 'StykNowdz — could not load'});
  }, true);
  addEventListener('load', () => { if (!failed) try { sessionStorage.removeItem(RETRIES); } catch { /* nothing to clear */ } });

  const explain = (heading, paragraphs, {action, pageTitle} = {}) => {
    const show = () => {
      const box = document.createElement('main');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1b2230';
      const title = document.createElement('h1');
      title.style.cssText = 'font-size:1.4rem;margin:0 0 .75rem';
      title.textContent = heading;
      box.append(title, ...paragraphs.map(text => Object.assign(document.createElement('p'), {textContent: text})));
      if (action) {
        const button = Object.assign(document.createElement('button'), {type: 'button', textContent: action});
        button.addEventListener('click', () => location.reload());
        box.append(button);
      }
      document.body.replaceChildren(box);
      document.title = pageTitle;
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  };

  const missing = [];
  const need = (name, present) => { if (!present) missing.push(name); };
  need('OffscreenCanvas (Safari 16.4 or later)', typeof OffscreenCanvas === 'function');
  need('WebAssembly', typeof WebAssembly === 'object');
  need('IndexedDB', !!window.indexedDB);
  need('the Web Crypto API (it needs a secure https page)', !!(window.crypto && window.crypto.subtle));
  need('createImageBitmap', typeof createImageBitmap === 'function');
  need('structuredClone', typeof structuredClone === 'function');
  need('the dialog element', typeof HTMLDialogElement === 'function');
  need('Object.hasOwn and Array.at', typeof Object.hasOwn === 'function' && typeof [].at === 'function');
  need('module workers', typeof Worker === 'function');
  if (!missing.length) return;

  explain('StykNowdz needs a newer browser', [
    `This browser is missing ${missing.join(', ')}.`,
    'Open this page in a current Chrome, Edge, Firefox or Safari (16.4 or later), or download the desktop app from stykanimate.com.',
  ], {pageTitle: 'StykNowdz — browser not supported'});
  // Let a test or the console see why.
  window.stykUnsupported = missing;
})();
