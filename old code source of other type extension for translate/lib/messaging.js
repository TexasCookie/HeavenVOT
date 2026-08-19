/** Thin wrappers around chrome.runtime messaging */

/** Default budget for GET_SETTINGS / boot (SW mid-start used to hang forever). */
export const SETTINGS_FETCH_TIMEOUT_MS = 8000;

/**
 * @param {object|null|undefined} res
 * @returns {object|null}
 */
export function settingsFromResponse(res) {
  return res?.settings && typeof res.settings === 'object' ? res.settings : null;
}

/**
 * @param {object} message
 * @param {{ timeoutMs?: number }} [opts]
 *        timeoutMs — if set, resolve with ok:false when SW never answers
 *        (classic hang: service worker killed mid-request, no lastError).
 */
export function sendMessage(message, opts = {}) {
  const timeoutMs = opts.timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({
          ok: false,
          error: `timeout ${timeoutMs}ms waiting for ${message?.type || 'message'}`,
          timeout: true,
        });
      }, timeoutMs);
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        finish(interpretExtensionResponse(response));
      });
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}

/**
 * Missing sendResponse is failure — inventing {ok:true} marked empty MT as success.
 * @param {object|null|undefined} response
 */
export function interpretExtensionResponse(response) {
  if (response == null) return { ok: false, error: 'empty extension response' };
  return response;
}

export function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(interpretExtensionResponse(response));
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

export function onMessage(handler) {
  const wrapped = (message, sender, sendResponse) => {
    const result = handler(message, sender);
    if (result && typeof result.then === 'function') {
      result
        .then((value) => sendResponse(value ?? { ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (result !== undefined) {
      sendResponse(result);
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(wrapped);
  return () => chrome.runtime.onMessage.removeListener(wrapped);
}
