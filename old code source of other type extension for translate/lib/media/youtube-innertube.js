/**
 * YouTube Innertube helpers — browser-side analog of yt-dlp's YouTube extractor.
 * Prefer playerResponse from the page; fall back to player API clients that
 * return plain `url` (no signatureCipher), e.g. modern ANDROID / IOS.
 */

import { log } from '../logger.js';
import { isYoutubeHost } from './url-guard.js';

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${INNERTUBE_KEY}`;
const VISITOR_URL = `https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false&key=${INNERTUBE_KEY}`;

let cachedVisitorData = '';

async function ensureVisitorData(signal) {
  if (cachedVisitorData) return cachedVisitorData;
  try {
    const res = await fetch(VISITOR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Goog-Api-Format-Version': '2',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20240726.00.00',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240726.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
      credentials: 'omit',
      signal,
    });
    if (res.ok) {
      const json = await res.json();
      const vd =
        json?.responseContext?.visitorData || json?.visitorData || '';
      if (vd) {
        cachedVisitorData = String(vd);
        return cachedVisitorData;
      }
    }
  } catch (e) {
    log.debug('visitor_id', e?.message || e);
  }
  return '';
}

/**
 * Clients ordered by likelihood of plain stream URLs + audio formats.
 * Versions verified 2026-07 against public videos (ANDROID 19.x → HTTP 400).
 */
const CLIENTS = [
  {
    name: 'ANDROID_VR',
    context: {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        osName: 'Android',
        osVersion: '12L',
        platform: 'MOBILE',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
    },
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
      },
    },
    headers: {
      'User-Agent':
        'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      'X-YouTube-Client-Name': '28',
      'X-YouTube-Client-Version': '1.65.10',
    },
  },
  {
    name: 'ANDROID',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        platform: 'MOBILE',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
    },
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
      },
    },
    headers: {
      'User-Agent':
        'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '20.10.38',
    },
  },
  {
    name: 'IOS',
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '17.5.1.21F90',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
    },
    headers: {
      'User-Agent':
        'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': '20.10.4',
    },
  },
  {
    name: 'ANDROID_MUSIC',
    context: {
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '7.27.52',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        hl: 'en',
        gl: 'US',
      },
    },
    headers: {
      'User-Agent':
        'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
      'X-YouTube-Client-Name': '21',
      'X-YouTube-Client-Version': '7.27.52',
    },
  },
];

/**
 * @param {string} url
 * @returns {string|null}
 */
export function parseYoutubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (isYoutubeHost(host)) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* ignore */
  }
  try {
    const parsed = new URL(String(url));
    if (!isYoutubeHost(parsed.hostname)) return null;
  } catch {
    /* bare id / relative path — fall through to loose */
  }
  const loose = String(url).match(/(?:v=|\/)([\w-]{11})(?:[&?/]|$)/);
  return loose ? loose[1] : null;
}

/**
 * Collect adaptive + progressive formats from a player response.
 * @param {object} playerResponse
 * @returns {object[]}
 */
export function collectFormats(playerResponse) {
  const sd = playerResponse?.streamingData || {};
  const list = [...(sd.adaptiveFormats || []), ...(sd.formats || [])];
  return list.filter(Boolean);
}

/**
 * Pick best audio-only format with a direct URL (no cipher).
 * Prefers m4a/mp4 audio, then webm/opus, highest bitrate.
 * @param {object[]} formats
 * @returns {object|null}
 */
export function pickBestAudioFormat(formats) {
  const audio = (formats || []).filter((f) => {
    if (!f) return false;
    if (!f.url && !f.signatureCipher && !f.cipher) return false;
    const mime = String(f.mimeType || '');
    const hasAudio =
      mime.startsWith('audio/') ||
      (typeof f.audioQuality === 'string' && f.audioQuality.length > 0) ||
      (f.audioSampleRate && !f.width);
    const hasVideo = f.width > 0 || f.height > 0 || /video\//i.test(mime);
    return hasAudio && (!hasVideo || mime.includes('audio'));
  });

  const withUrl = audio.filter((f) => typeof f.url === 'string' && f.url);
  const pool = withUrl.length ? withUrl : audio;

  if (!pool.length) {
    // Never fall back to muxed video/mp4 — those WEB streams are PO-token gated (HTTP 403).
    return null;
  }

  const pure = pool.filter((f) => {
    const mime = String(f.mimeType || '');
    return mime.startsWith('audio/') || !f.width;
  });
  return pickByBitrate(pure.length ? pure : pool);
}

function pickByBitrate(list) {
  return [...list].sort((a, b) => {
    const br = (x) => Number(x.bitrate || x.averageBitrate || 0);
    const score = (x) => {
      const mime = String(x.mimeType || '');
      let s = br(x);
      if (mime.includes('mp4') || mime.includes('mp4a')) s += 50_000;
      if (mime.startsWith('audio/')) s += 100_000;
      if (x.url) s += 200_000;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

/**
 * @param {object} format
 * @returns {{ url: string, mime: string, bitrate: number, itag: number|null, contentLength: number|null }|null}
 */
export function formatToStream(format) {
  if (!format) return null;
  const url = format.url || null;
  if (!url) {
    // cipher not implemented — caller should try another client
    return null;
  }
  const mime = String(format.mimeType || 'audio/mp4').split(';')[0].trim();
  return {
    url,
    mime,
    bitrate: Number(format.bitrate || format.averageBitrate || 0),
    itag: format.itag ?? null,
    contentLength: format.contentLength
      ? Number(format.contentLength)
      : null,
    audioSampleRate: format.audioSampleRate
      ? Number(format.audioSampleRate)
      : null,
  };
}

/**
 * @param {object} playerResponse
 * @returns {{ ok: boolean, stream?: object, durationSec?: number, title?: string, status?: string, reason?: string, isLive?: boolean }}
 */
export function streamFromPlayerResponse(playerResponse) {
  if (!playerResponse || typeof playerResponse !== 'object') {
    return { ok: false, reason: 'empty playerResponse' };
  }
  const status = playerResponse?.playabilityStatus?.status || 'UNKNOWN';
  const reason =
    playerResponse?.playabilityStatus?.reason ||
    playerResponse?.playabilityStatus?.messages?.[0] ||
    '';
  if (status && status !== 'OK') {
    return { ok: false, status, reason: reason || status };
  }

  const isLive =
    !!playerResponse?.videoDetails?.isLiveContent ||
    !!playerResponse?.videoDetails?.isLive ||
    playerResponse?.videoDetails?.isLive === 'true';

  const durationSec = Number(
    playerResponse?.videoDetails?.lengthSeconds || 0,
  );
  const title = playerResponse?.videoDetails?.title || '';

  const formats = collectFormats(playerResponse);
  if (!formats.length) {
    const hls = playerResponse?.streamingData?.hlsManifestUrl;
    const dash = playerResponse?.streamingData?.dashManifestUrl;
    if (hls || dash) {
      return {
        ok: false,
        status: 'LIVE_OR_HLS',
        reason: 'Только HLS/DASH (live?) — используй Live-режим',
        isLive: true,
        title,
      };
    }
    return { ok: false, reason: 'no streaming formats', title };
  }

  const best = pickBestAudioFormat(formats);
  const stream = formatToStream(best);
  if (!stream) {
    return {
      ok: false,
      reason:
        'Аудио только с signatureCipher (нужен decipher) — innertube fallback',
      title,
      status,
    };
  }

  return {
    ok: true,
    stream,
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    title,
    status,
    isLive: !!isLive && durationSec <= 0,
    itag: best?.itag,
    mimeType: best?.mimeType,
  };
}

/**
 * Fetch player response via Innertube for a video id.
 * @param {string} videoId
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchPlayerResponse(videoId, opts = {}) {
  const errors = [];
  const visitorData = await ensureVisitorData(opts.signal);
  for (const client of CLIENTS) {
    try {
      const clientCtx = {
        ...client.context.client,
        ...(visitorData ? { visitorData } : {}),
      };
      const body = {
        context: { client: clientCtx },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      };
      if (client.playbackContext) {
        body.playbackContext = client.playbackContext;
      }
      const res = await fetch(PLAYER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Goog-Api-Format-Version': '2',
          ...client.headers,
        },
        body: JSON.stringify(body),
        // omit cookies — SAPISID + ANDROID_* UA → LOGIN_REQUIRED bot-check
        credentials: 'omit',
        signal: opts.signal,
      });
      if (!res.ok) {
        errors.push(`${client.name}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const parsed = streamFromPlayerResponse(json);
      if (parsed.ok) {
        log.info('yt extract client ok', client.name, parsed.stream?.mime);
        return { ok: true, playerResponse: json, client: client.name, parsed };
      }
      errors.push(`${client.name}: ${parsed.reason || parsed.status}`);
    } catch (e) {
      errors.push(`${client.name}: ${e?.message || e}`);
    }
  }
  return {
    ok: false,
    error: errors.join(' · ') || 'all innertube clients failed',
  };
}

/**
 * Resolve audio stream for a YouTube URL / id.
 * @param {{ pageUrl?: string, videoId?: string, playerResponse?: object, signal?: AbortSignal }} opts
 */
export async function resolveYoutubeAudio(opts = {}) {
  const videoId =
    opts.videoId || parseYoutubeVideoId(opts.pageUrl || '') || null;
  if (!videoId) {
    return { ok: false, error: 'not a YouTube URL / no video id' };
  }

  // Prefer Innertube clients first — WEB page playerResponse plain URLs are
  // PO-token gated (HTTP 403 from SW/offscreen). ANDROID_VR bypasses that gate.
  const remote = await fetchPlayerResponse(videoId, { signal: opts.signal });
  if (remote.ok) {
    const clientMeta = CLIENTS.find((c) => c.name === remote.client);
    return {
      ok: true,
      provider: 'youtube',
      videoId,
      source: remote.client,
      userAgent: clientMeta?.headers?.['User-Agent'] || '',
      ...remote.parsed,
      playerResponse: remote.playerResponse,
    };
  }

  if (opts.playerResponse) {
    const parsed = streamFromPlayerResponse(opts.playerResponse);
    if (parsed.ok) {
      return {
        ok: true,
        provider: 'youtube',
        videoId,
        source: 'page',
        userAgent: '',
        ...parsed,
      };
    }
    log.debug('page playerResponse unusable', parsed.reason);
  }

  return {
    ok: false,
    provider: 'youtube',
    videoId,
    error: remote.error || 'innertube failed',
  };
}
