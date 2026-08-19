/**
 * Content-script / overlay policy (unit-tested).
 */

export function shouldSkipContentProtocol(protocol, href = '') {
  const proto = String(protocol || '');
  if (
    proto === 'chrome:' ||
    proto === 'chrome-extension:' ||
    proto === 'edge:' ||
    proto === 'devtools:' ||
    proto === 'moz-extension:'
  ) {
    return true;
  }
  if (proto === 'about:') {
    const h = String(href || '');
    return !(h === 'about:blank' || h.startsWith('about:srcdoc'));
  }
  return false;
}

/** Target origin for same-document postMessage (never leak signed URLs to '*'). */
export function sameDocumentPostTarget(origin) {
  const o = String(origin || '');
  if (!o || o === 'null' || o === 'undefined') return 'null';
  try {
    const u = new URL(o);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  } catch {
    /* ignore */
  }
  return 'null';
}

export function settingsFromSetResponse(res, prev) {
  return res?.settings && typeof res.settings === 'object' ? res.settings : prev || null;
}

export function popupAuthGate(settings, res) {
  if (!settings) {
    return {
      allow: false,
      showApiKey: false,
      message: res?.error || 'Service worker не ответил',
    };
  }
  const local = String(settings.providerMode || '') === 'local';
  if (local) return { allow: true, showApiKey: false, message: '' };
  if (String(settings.xaiApiKey || '').trim()) {
    return { allow: true, showApiKey: false, message: '' };
  }
  return { allow: false, showApiKey: true, message: 'Сначала сохрани API ключ' };
}

export function childFrameShouldSkipToggle({ isTop, ownsPlayer, pipelineRunning, topHasVideo }) {
  if (isTop) return false;
  if (pipelineRunning) return false;
  if (!ownsPlayer) return true;
  if (topHasVideo === true) return true;
  return false;
}
