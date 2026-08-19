/**
 * Auth / probe / DNR policy helpers (unit-tested).
 */

/** Reachable xAI-like HTTP — not 404 (typo’d relay). */
export function probeStatusMeansReachable(status) {
  const s = Number(status);
  return s === 200 || s === 401 || s === 403;
}

export function looksLikeXaiRelay(status, body) {
  if (!probeStatusMeansReachable(status)) return false;
  const raw = body && typeof body === 'object' ? body : {};
  const svc = String(raw.service || raw.name || raw.id || '');
  if (/aethervox|xai-relay|xai_relay/i.test(svc)) return true;
  if (status === 200 && Array.isArray(raw.voices)) return true;
  if (status === 200 && raw.object === 'list' && Array.isArray(raw.data)) return true;
  return false;
}

export function looksLikeLocalGateway(status, body) {
  if (Number(status) !== 200) return false;
  const raw = body && typeof body === 'object' ? body : {};
  if (raw.ok !== true) return false;
  const svc = String(raw.service || '');
  return !svc || /aethervox/i.test(svc);
}

export function ttsMessageMatchesUtterance(msg, cur) {
  if (!cur) return false;
  const mid = msg?.id ?? msg?.item_id ?? msg?.utterance_id ?? msg?.utteranceId;
  if (mid == null || cur.id == null) return true;
  return String(mid) === String(cur.id);
}

export function isLoopbackHttpUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}
