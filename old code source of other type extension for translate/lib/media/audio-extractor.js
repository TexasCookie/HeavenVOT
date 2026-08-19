/**
 * Browser yt-dlp analog — resolve + download media audio for VOD prepare.
 * YouTube-first; interface allows more providers later.
 */

import { log } from '../logger.js';
import {
  parseYoutubeVideoId,
  resolveYoutubeAudio,
  streamFromPlayerResponse,
  pickBestAudioFormat,
  collectFormats,
  formatToStream,
} from './youtube-innertube.js';
import { isAllowedMediaStreamUrl } from './url-guard.js';

export {
  parseYoutubeVideoId,
  streamFromPlayerResponse,
  pickBestAudioFormat,
  collectFormats,
  formatToStream,
};

/**
 * @param {{ pageUrl: string, videoId?: string, playerResponse?: object, signal?: AbortSignal }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   provider?: string,
 *   videoId?: string,
 *   durationSec?: number,
 *   title?: string,
 *   mime?: string,
 *   streamUrl?: string,
 *   arrayBuffer?: ArrayBuffer,
 *   byteLength?: number,
 *   error?: string,
 * }>}
 */
export async function extractAudio(opts = {}) {
  const pageUrl = opts.pageUrl || '';
  const videoId = opts.videoId || parseYoutubeVideoId(pageUrl);

  if (!videoId && !/youtube\.com|youtu\.be/i.test(pageUrl)) {
    return {
      ok: false,
      error:
        'Extractor v1: только YouTube (где работает yt-dlp-analog). Для других сайтов — Live.',
    };
  }

  const resolved = await resolveYoutubeAudio({
    pageUrl,
    videoId: videoId || undefined,
    playerResponse: opts.playerResponse,
    signal: opts.signal,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      provider: 'youtube',
      videoId: resolved.videoId || videoId || undefined,
      error: resolved.error || resolved.reason || 'extract failed',
    };
  }

  if (resolved.isLive) {
    return {
      ok: false,
      provider: 'youtube',
      videoId: resolved.videoId,
      error: resolved.reason || 'Live/HLS — используй режим Live',
    };
  }

  const streamUrl = resolved.stream?.url;
  const mime = resolved.stream?.mime || 'audio/mp4';
  if (!streamUrl) {
    return {
      ok: false,
      provider: 'youtube',
      videoId: resolved.videoId,
      error: 'no stream url',
    };
  }

  log.info('yt extract downloading', {
    videoId: resolved.videoId,
    mime,
    source: resolved.source,
    durationSec: resolved.durationSec,
  });

  const ab = await downloadUrl(streamUrl, {
    signal: opts.signal,
    contentLength: resolved.stream?.contentLength,
    onProgress: opts.onProgress,
  });

  return {
    ok: true,
    provider: 'youtube',
    videoId: resolved.videoId,
    durationSec: resolved.durationSec || 0,
    title: resolved.title || '',
    mime,
    streamUrl,
    arrayBuffer: ab,
    byteLength: ab.byteLength,
    source: resolved.source,
  };
}

/**
 * @param {string} url
 * @param {{ signal?: AbortSignal, contentLength?: number|null, onProgress?: (p:{loaded:number,total:number|null})=>void }} opts
 */
export async function downloadUrl(url, opts = {}) {
  if (!isAllowedMediaStreamUrl(url)) {
    throw new Error('audio download: url host not allowed');
  }
  const headers = {
    // googlevideo is picky — Referer helps when SW origin would 403
    Accept: '*/*',
    ...(opts.referer
      ? { Referer: opts.referer }
      : String(url).includes('googlevideo.com')
        ? { Referer: 'https://www.youtube.com/' }
        : {}),
    ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
  };
  const res = await fetch(url, {
    method: 'GET',
    signal: opts.signal,
    headers,
    credentials: opts.credentials || 'omit',
  });
  if (!res.ok) {
    throw new Error(`audio download HTTP ${res.status}`);
  }

  const totalHeader = res.headers.get('content-length');
  const total = totalHeader
    ? Number(totalHeader)
    : opts.contentLength || null;

  if (!res.body || !res.body.getReader) {
    const ab = await res.arrayBuffer();
    opts.onProgress?.({ loaded: ab.byteLength, total: ab.byteLength });
    return ab;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    opts.onProgress?.({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
