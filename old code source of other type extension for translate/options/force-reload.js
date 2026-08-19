/**
 * Classic (non-module) boot — runs even when SW failed to register.
 * Reloads unpacked extension when installed manifest is behind disk.
 */
(function () {
  var TARGET = '1.9.11';
  var man = null;
  try {
    man = chrome.runtime.getManifest();
  } catch (e) {
    return;
  }
  var version = (man && man.version) || '?';
  var swPath =
    (man && man.background && man.background.service_worker) || '';
  var stale =
    version !== TARGET || String(swPath).indexOf('av-sw.js') === -1;
  if (!stale) return;

  var key = '_avForceReload1911';
  try {
    if (sessionStorage.getItem(key) === '1') return;
    sessionStorage.setItem(key, '1');
  } catch (e2) {}

  try {
    chrome.runtime.reload();
  } catch (e3) {}
})();
