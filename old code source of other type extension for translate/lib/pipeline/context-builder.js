import { detectDomainHint } from '../xai/translate.js';
import { isTwitchLiveChannelPath, isTwitchHost, isYoutubeHost } from '../media/url-guard.js';

/**
 * Pure live-vs-VOD classifier (unit-testable).
 * Prefer false negatives: wrong "live" forces fragile streaming STT on movies.
 * Exception: authoritative YouTube playerResponse.isLive* must win over finite DVR duration.
 *
 * @param {{
 *   host?: string,
 *   path?: string,
 *   href?: string,
 *   videoTitle?: string,
 *   pageTitle?: string,
 *   duration?: number,
 *   seekableEnd?: number|null,
 *   currentTime?: number,
 *   ytLiveBadgeText?: string|null,
 *   ytLiveBadgeDisabled?: boolean,
 *   twitchLiveViewers?: boolean,
 *   ytIsLiveContent?: boolean,
 *   ytIsLive?: boolean,
 *   ytDomIsLive?: boolean,
 * }} s
 * @returns {boolean}
 */
export function detectMediaIsLive(s = {}) {
  const host = String(s.host || '').replace(/^www\./, '');
  const path = String(s.path || '');
  const href = String(s.href || '');
  const videoTitle = String(s.videoTitle || '');
  const pageTitle = String(s.pageTitle || '');
  // HTMLMediaElement: NaN before metadata, Infinity for live, finite for VOD
  const duration = Number(s.duration);
  const livePath =
    /\/live\b|\/streams?\b/i.test(path + href) ||
    isTwitchLiveChannelPath(host, path);
  const liveTitle = /\b(live|стрим|livestream|прямой\s*эфир)\b/i.test(
    `${videoTitle} ${pageTitle}`,
  );
  const infiniteDur = duration === Infinity;
  const finiteDur = Number.isFinite(duration) && duration > 30;

  // Currently broadcasting (isLive) vs historical livestream archive (isLiveContent).
  // Archives keep isLiveContent=true forever — that alone must NOT force Live pipeline.
  const ytCurrentlyLive = !!s.ytIsLive;
  const ytWasLiveContent = !!s.ytIsLiveContent;
  const ytDomLive = !!s.ytDomIsLive;

  let seekLooksLive = false;
  const seekEnd = s.seekableEnd;
  if (
    seekEnd != null &&
    Number.isFinite(seekEnd) &&
    Number.isFinite(duration) &&
    duration > 120
  ) {
    const ct = Number(s.currentTime) || 0;
    if (seekEnd < duration * 0.5 && seekEnd - ct < 90) seekLooksLive = true;
  }

  const badgeText = String(s.ytLiveBadgeText || '').trim();
  const ytLiveChrome =
    !s.ytLiveBadgeDisabled &&
    badgeText.length > 0 &&
    /live|сейчас|эфир/i.test(badgeText);

  const twitchLiveChrome =
    !!s.twitchLiveViewers && isTwitchLiveChannelPath(host, path);

  const isYoutubeWatch =
    isYoutubeHost(host) &&
    (/[?&]v=/.test(href) || /\/watch\b/.test(path) || /\/live\b/.test(path));

  // Active live / DOM is-live-video
  if (ytCurrentlyLive || ytDomLive) return true;

  // YouTube watch with a full finite timeline and no live chrome → VOD
  // (including former livestream archives where isLiveContent stays true).
  if (isYoutubeWatch && finiteDur && !ytLiveChrome && !livePath && !infiniteDur) {
    // Live DVR still has finite lengthSeconds but seek window hugs the edge.
    if (ytWasLiveContent && seekLooksLive) return true;
    return false;
  }

  // Live content only counts with corroborating live signals
  if (
    ytWasLiveContent &&
    (ytLiveChrome || seekLooksLive || infiniteDur || livePath)
  ) {
    return true;
  }

  return !!(
    ytLiveChrome ||
    twitchLiveChrome ||
    livePath ||
    infiniteDur ||
    (seekLooksLive && !finiteDur) ||
    (liveTitle && (infiniteDur || ytLiveChrome || livePath || twitchLiveChrome))
  );
}

/**
 * Harvest page/video metadata so Grok can disambiguate ASR garbage.
 * @param {HTMLVideoElement|null|undefined} video
 * @param {Document} [doc]
 * @param {{ playerResponse?: object|null }} [opts]
 */
export function buildVideoContext(video, doc = document, opts = {}) {
  const host = location.hostname.replace(/^www\./, '');
  let videoTitle = '';
  let channel = '';
  let description = '';

  // YouTube (classic Polymer + newer watch metadata shells)
  if (isYoutubeHost(host)) {
    videoTitle =
      doc.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
      doc.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim() ||
      doc.querySelector('ytd-watch-metadata h1')?.textContent?.trim() ||
      doc.querySelector('#title h1')?.textContent?.trim() ||
      doc.querySelector('h1.title')?.textContent?.trim() ||
      doc.querySelector('meta[name="title"]')?.content ||
      doc.querySelector('meta[property="og:title"]')?.content ||
      '';
    channel =
      doc.querySelector('#channel-name a')?.textContent?.trim() ||
      doc.querySelector('ytd-channel-name a')?.textContent?.trim() ||
      doc.querySelector('#owner #channel-name a')?.textContent?.trim() ||
      doc.querySelector('ytd-video-owner-renderer a')?.textContent?.trim() ||
      '';
    description =
      doc.querySelector('#description-inline-expander')?.textContent?.trim()?.slice(0, 500) ||
      doc.querySelector('#description-inner')?.textContent?.trim()?.slice(0, 500) ||
      doc.querySelector('meta[name="description"]')?.content ||
      '';
  }

  // Twitch
  if (isTwitchHost(host)) {
    videoTitle =
      doc.querySelector('[data-a-target="stream-title"]')?.textContent?.trim() ||
      doc.querySelector('h2[data-a-target="stream-title"]')?.textContent?.trim() ||
      '';
    channel =
      doc.querySelector('[data-a-target="user-channel-header-name"]')?.textContent?.trim() ||
      location.pathname.split('/').filter(Boolean)[0] ||
      '';
  }

  // VK / Rutube / generic
  if (!videoTitle) {
    videoTitle =
      doc.querySelector('meta[property="og:title"]')?.content ||
      doc.querySelector('h1')?.textContent?.trim() ||
      doc.title ||
      '';
  }
  if (!description) {
    description =
      doc.querySelector('meta[property="og:description"]')?.content ||
      doc.querySelector('meta[name="description"]')?.content ||
      '';
  }

  // aria / media metadata
  if (video) {
    if (!videoTitle && video.getAttribute('aria-label')) {
      videoTitle = video.getAttribute('aria-label');
    }
    if (!videoTitle && video.title) videoTitle = video.title;
  }

  const pageTitle = doc.title || '';
  const path = String(location.pathname || '');
  const href = String(location.href || '');

  let seekableEnd = null;
  try {
    if (video?.seekable && video.seekable.length) {
      seekableEnd = video.seekable.end(video.seekable.length - 1);
    }
  } catch {
    seekableEnd = null;
  }

  let ytLiveBadgeText = null;
  let ytLiveBadgeDisabled = true;
  try {
    const badge =
      doc.querySelector('.ytp-live-badge') ||
      doc.querySelector('.ytp-live') ||
      doc.querySelector('button.ytp-live-badge');
    if (badge) {
      ytLiveBadgeText = (
        badge.textContent ||
        badge.getAttribute('aria-label') ||
        ''
      ).trim();
      const style = badge.getAttribute('style') || '';
      ytLiveBadgeDisabled =
        badge.hasAttribute('disabled') ||
        badge.getAttribute('disabled') === 'true' ||
        badge.getAttribute('aria-disabled') === 'true' ||
        /display:\s*none/i.test(style) ||
        /visibility:\s*hidden/i.test(style);
    }
    // Primary info only — never match LIVE badges on sidebar thumbnails
    if (ytLiveBadgeDisabled) {
      const pageLive =
        doc.querySelector(
          'ytd-watch-metadata .badge-style-type-live-now-alternate, ytd-watch-metadata .badge-style-type-live-now',
        ) ||
        doc.querySelector(
          'ytd-video-primary-info-renderer .badge-style-type-live-now, ytd-video-primary-info-renderer .badge-style-type-live-now-alternate',
        ) ||
        doc.querySelector(
          '#above-the-fold ytd-badge-supported-renderer .badge[aria-label*="LIVE" i]',
        );
      if (pageLive) {
        ytLiveBadgeText = (
          pageLive.textContent ||
          pageLive.getAttribute('aria-label') ||
          'LIVE'
        ).trim();
        ytLiveBadgeDisabled = false;
      }
    }
  } catch {
    /* ignore */
  }

  let twitchLiveViewers = false;
  try {
    twitchLiveViewers = !!doc.querySelector(
      '[data-a-target="animated-channel-viewers-count"]',
    );
  } catch {
    twitchLiveViewers = false;
  }

  const pr = opts.playerResponse || null;
  const vd = pr?.videoDetails || null;
  // isLiveContent = "was/is livestream-shaped" (archives stay true).
  // isLive = currently broadcasting.
  const ytIsLiveContent =
    vd?.isLiveContent === true || vd?.isLiveContent === 'true';
  const ytIsLive =
    vd?.isLive === true ||
    vd?.isLive === 'true' ||
    /LIVE_STREAM/i.test(String(vd?.mediaType || ''));

  let ytDomIsLive = false;
  try {
    const flexy = doc.querySelector('ytd-watch-flexy');
    if (flexy) {
      // is-live-content alone is set on many VOD watch pages — only is-live-video
      // means the player is in an active live/DVR session.
      ytDomIsLive = flexy.hasAttribute('is-live-video');
    }
  } catch {
    ytDomIsLive = false;
  }

  const isLive = detectMediaIsLive({
    host,
    path,
    href,
    videoTitle,
    pageTitle,
    duration: video?.duration,
    seekableEnd,
    currentTime: video?.currentTime,
    ytLiveBadgeText,
    ytLiveBadgeDisabled,
    twitchLiveViewers,
    ytIsLiveContent,
    ytIsLive,
    ytDomIsLive,
  });

  const context = {
    siteHost: host,
    pageTitle,
    videoTitle,
    channel,
    description: String(description || '').slice(0, 600),
    isLive: !!isLive,
    url: location.href,
  };
  context.domainHint = detectDomainHint(context);
  return context;
}

/** Prefer site captions when available (fast path for VOD) */
export async function tryExtractNativeCaptions(video) {
  try {
    if (!video?.textTracks) return null;
    const tracks = [...video.textTracks].filter(
      (t) => t.kind === 'subtitles' || t.kind === 'captions',
    );
    if (!tracks.length) return null;
    // Do not auto-steal tracks without user intent — return metadata only
    return tracks.map((t) => ({
      label: t.label,
      language: t.language,
      mode: t.mode,
    }));
  } catch {
    return null;
  }
}
