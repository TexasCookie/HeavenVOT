/**
 * Download YouTube audio via local gateway yt-dlp
 * (extension-exported cookies + android_vr) — bypasses Innertube bot-check.
 */

import { ensureLocalGateway } from '../local-gateway-host.js';
import { log } from '../logger.js';
import { exportYoutubeCookiesNetscape } from './youtube-cookies.js';
import { isAllowedYtdlpSourceUrl } from './url-guard.js';

/**
 * @param {{ pageUrl?: string, videoId?: string, baseUrl?: string }} opts
 */
export async function downloadYoutubeAudioViaYtdlp(opts = {}) {
  const pageUrl = opts.pageUrl || '';
  const videoId = opts.videoId || '';
  if (!pageUrl && !videoId) {
    return { ok: false, error: 'yt-dlp: no url/videoId' };
  }
  if (pageUrl && !isAllowedYtdlpSourceUrl(pageUrl)) {
    return { ok: false, error: 'yt-dlp: url must be YouTube' };
  }

  const gw = await ensureLocalGateway({
    baseUrl: opts.baseUrl || 'http://127.0.0.1:8788/v1',
  });
  if (!gw?.ok) {
    return {
      ok: false,
      error:
        gw?.error ||
        'local gateway down — запусти tools/local-voice-gateway (нужен yt-dlp)',
    };
  }

  let cookiesTxt = '';
  try {
    cookiesTxt = await exportYoutubeCookiesNetscape();
  } catch (e) {
    log.debug('cookie export', e?.message || e);
  }

  const base = String(opts.baseUrl || 'http://127.0.0.1:8788/v1').replace(
    /\/+$/,
    '',
  );
  const endpoint = `${base}/media/youtube-audio`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        url: pageUrl || undefined,
        videoId: videoId || undefined,
        cookiesTxt: cookiesTxt || undefined,
      }),
      signal: AbortSignal.timeout(600000),
    });
  } catch (e) {
    return { ok: false, error: `yt-dlp fetch: ${e?.message || e}` };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || !data?.ok || !data?.streamUrl) {
    const detail =
      (typeof data?.detail === 'string' && data.detail) ||
      data?.error ||
      `HTTP ${res.status}`;
    log.warn('yt-dlp gateway', detail);
    return { ok: false, error: `yt-dlp: ${detail}` };
  }

  return {
    ok: true,
    streamUrl: data.streamUrl,
    mime: data.mime || 'audio/mp4',
    durationSec: Number(data.durationSec) || 0,
    title: data.title || '',
    source: data.source || 'yt-dlp-local',
    byteLength: Number(data.byteLength) || 0,
    userAgent: '',
  };
}
