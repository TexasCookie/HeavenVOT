/**
 * URL / host allowlists for VOD extract + local gateway cache.
 * Pure functions — unit-tested from tools/bug-report-verify.mjs.
 */

/**
 * Strict YouTube host check (no evil-youtube.com suffix match).
 * @param {string} host
 */
export function isYoutubeHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return (
    h === 'youtu.be' ||
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com')
  );
}

/**
 * Strict Twitch host check (no nottwitch.tv / evil-twitch.tv).
 * @param {string} host
 */
export function isTwitchHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return h === 'twitch.tv' || h.endsWith('.twitch.tv');
}

/**
 * Twitch URLs that are VOD/clip — must not force the live pipeline.
 * @param {string} host
 * @param {string} [path]
 */
export function isTwitchLiveChannelPath(host, path = '') {
  if (!isTwitchHost(host)) return false;
  const h = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (h === 'clips.twitch.tv') return false;
  const p = String(path || '');
  if (/\/videos?\//i.test(p) || /\/clip(?:s)?\//i.test(p)) return false;
  return true;
}

/**
 * YouTube video id is 11 chars [A-Za-z0-9_-].
 * @param {string} id
 * @returns {string|null}
 */
export function sanitizeYoutubeVideoId(id) {
  const t = String(id || '');
  return /^[\w-]{11}$/.test(t) ? t : null;
}

/**
 * Hosts we may fetch as VOD audio (googlevideo / YT / local gateway cache).
 * @param {string} url
 */
export function isAllowedMediaStreamUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  const host = String(u.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (u.protocol === 'https:') {
    if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) {
      return true;
    }
    if (isYoutubeHost(host)) return true;
    if (host === 'ytimg.com' || host.endsWith('.ytimg.com')) return true;
    if (host === 'ggpht.com' || host.endsWith('.ggpht.com')) return true;
    return false;
  }
  if (
    u.protocol === 'http:' &&
    (host === '127.0.0.1' || host === 'localhost' || host === '::1')
  ) {
    return /^\/v1\/media\/cache\/[0-9a-fA-F]{8,32}\/?$/.test(u.pathname);
  }
  return false;
}

/**
 * yt-dlp source must be a YouTube watch/embed/shorts/live URL.
 * Host-only allowlists still accepted /redirect?q= http://internal (SSRF).
 * @param {string} url
 */
export function isAllowedYtdlpSourceUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!isYoutubeHost(u.hostname)) return false;
  const host = String(u.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = (u.pathname || '').split('/').filter(Boolean)[0] || '';
    return !!sanitizeYoutubeVideoId(id);
  }
  const v = u.searchParams.get('v');
  if (sanitizeYoutubeVideoId(v || '')) return true;
  if (/^\/(embed|shorts|live|v|clip)\/[\w-]{11}\/?$/i.test(u.pathname || '')) {
    return true;
  }
  if (/^\/live\/?$/i.test(u.pathname || '')) return true;
  return false;
}

/**
 * Media-cache tokens are hex only — blocks glob / path traversal.
 * @param {string} token
 * @returns {string|null}
 */
export function sanitizeMediaCacheToken(token) {
  const t = String(token || '');
  return /^[0-9a-fA-F]{8,32}$/.test(t) ? t : null;
}
