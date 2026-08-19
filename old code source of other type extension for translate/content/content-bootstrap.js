/* Bootstrap in content-script isolated world (keeps chrome.* APIs). */
(function () {
  if (window.__AETHERVOX_BOOTSTRAPPED__) return;
  window.__AETHERVOX_BOOTSTRAPPED__ = true;

  // Never run on extension/browser chrome pages
  try {
    const proto = location.protocol || '';
    if (
      proto === 'chrome:' ||
      proto === 'chrome-extension:' ||
      proto === 'edge:' ||
      proto === 'devtools:' ||
      proto === 'moz-extension:'
    ) {
      return;
    }
    // about:blank / about:srcdoc often host the real <video> player
    if (proto === 'about:') {
      const href = String(location.href || '');
      if (href !== 'about:blank' && href.indexOf('about:srcdoc') !== 0) return;
    }
  } catch {
    return;
  }

  // Auth / account shells never host a watchable player — skip noise in console
  // (user logs showed "Content main ready on accounts.youtube.com" spam).
  try {
    const host = (location.hostname || '').toLowerCase();
    if (
      host === 'accounts.youtube.com' ||
      host === 'accounts.google.com' ||
      host === 'login.live.com' ||
      /^(accounts|login|signin|auth)\./i.test(host)
    ) {
      return;
    }
  } catch {
    /* ignore */
  }

  const url = chrome.runtime.getURL('content/content-main.js');
  const isTop = (() => {
    try {
      return window === window.top;
    } catch {
      // cross-origin frame access throws — treat as nested
      return false;
    }
  })();

  function loadMain() {
    if (window.__AETHERVOX_MAIN_LOADING__ || window.__AETHERVOX_MAIN__) return;
    window.__AETHERVOX_MAIN_LOADING__ = true;
    import(url).catch((err) => {
      window.__AETHERVOX_MAIN_LOADING__ = false;
      console.error('[AetherVox] failed to load content-main', err);
    });
  }

  // Top frame: always load (video may appear later via SPA).
  if (isTop) {
    loadMain();
    return;
  }

  // Nested iframes: only boot when a <video> exists or appears.
  // Avoids empty about:blank / ads / widgets waking full pipeline modules.
  if (document.querySelector('video')) {
    loadMain();
    return;
  }

  let mo = null;
  let iv = null;
  const tryBoot = () => {
    if (document.querySelector('video')) {
      if (mo) mo.disconnect();
      if (iv) clearInterval(iv);
      loadMain();
      return true;
    }
    return false;
  };

  try {
    mo = new MutationObserver(() => {
      tryBoot();
    });
    mo.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  } catch {
    /* ignore */
  }
  // Cap wait so abandoned iframes don't keep observers forever
  iv = setInterval(() => {
    if (tryBoot()) return;
  }, 2000);
  setTimeout(() => {
    if (iv) {
      clearInterval(iv);
      iv = null;
    }
  }, 120000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tryBoot();
  });
})();
