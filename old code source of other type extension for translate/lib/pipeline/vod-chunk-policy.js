/**
 * Pure VOD chunk / cue policy helpers (testable without Chrome).
 * Prevents fake-ready unlock and permanent cue holes.
 */

import { isYoutubeHost } from '../media/url-guard.js';

export { isYoutubeHost };

/** @typedef {'ok'|'silent'|'failed'|'aborted'} VodChunkStatus */

/**
 * Only successful speech cues or intentional silence cover the timeline.
 * Failures must NOT unlock progressive play or inflate bufferAhead.
 * @param {VodChunkStatus|string} status
 */
export function shouldMarkChunkCompleted(status) {
  return status === 'ok' || status === 'silent';
}

/**
 * Progressive unlock: timeline from t≈0 must be covered.
 * completed chunk-0 (ok/silent) OR a cue that starts near 0.
 * Any later cue alone must NOT unlock (avoids silence hole at start).
 * @param {{ completedHas0?: boolean, cueCount?: number, earliestCueStart?: number }} s
 */
export function shouldUnlockFirstChunk(s = {}) {
  if (s.completedHas0 === true) return true;
  const start = Number(s.earliestCueStart);
  if (Number.isFinite(start) && start <= 0.35) return true;
  // Legacy cueCount>0 without start → refuse (B22)
  return false;
}

/**
 * Mark cue consumed only after confirmed playback.
 * @param {{ offscreenOk?: boolean, localPlayOk?: boolean, skipped?: boolean }} r
 */
export function shouldMarkCuePlayed(r = {}) {
  if (r.skipped) return true;
  if (r.offscreenOk) return true;
  if (r.localPlayOk) return true;
  return false;
}

/**
 * Auto mode: VOD prepare is YouTube-only (extractor v1) and not for live streams.
 * Forced mode=vod still returns true (caller surfaces extract error).
 * @param {{ mode?: string, pageUrl?: string, hostname?: string, isLive?: boolean }} opts
 */
export function shouldUseVodPrepare(opts = {}) {
  if (opts.mode === 'live') return false;
  if (opts.mode === 'vod') return true;
  // auto: live streams always use realtime pipeline
  if (opts.isLive === true) return false;
  return isYoutubeHost(opts.hostname || hostnameFromUrl(opts.pageUrl));
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || '')).hostname;
  } catch {
    return '';
  }
}

/**
 * After buffer-hole pause, do not call video.play() — autoplay policy blocks it.
 * UI must ask the user to press Play.
 * @returns {false}
 */
export function shouldAutoResumeAfterHole() {
  return false;
}

/**
 * Max automatic requeues for a failed chunk before giving up.
 */
export const VOD_CHUNK_MAX_RETRIES = 2;

/**
 * Live empty-STT fallback (prefer_vod) must not be overwritten by a later
 * auto-detect that flips back to Live (infinite Live↔VOD loop).
 * @param {boolean} forced
 * @param {boolean} recomputedVod
 */
export function keepForcedVod(forced, recomputedVod) {
  if (forced) return true;
  return !!recomputedVod;
}

/**
 * Thrown #processChunk must enter the same failed/retry path as a returned
 * 'failed' status — otherwise the index vanishes and full-bank never unlocks.
 * @returns {'failed'}
 */
export function outcomeFromChunkError() {
  return 'failed';
}

/**
 * After the pump finishes: all-terminal + zero cues means hard error, not "ready".
 * @param {{ cueCount?: number, failedTerminal?: number, chunkCount?: number }} s
 */
export function shouldFailEmptyBank(s = {}) {
  const cues = Number(s.cueCount) || 0;
  const failed = Number(s.failedTerminal) || 0;
  const n = Number(s.chunkCount) || 0;
  return cues === 0 && n > 0 && failed >= n;
}

/**
 * Overlapping VOD windows share a prefix — containment must NOT mark the
 * later chunk silent (that punches a hole and still unlocks the timeline).
 * @param {string} text
 * @param {number} start
 * @param {Array<{ start?: number, sourceText?: string }>} cues
 */
export function isNearDuplicateVodSource(text, start, cues = []) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return true;
  for (const c of cues) {
    if (Math.abs(Number(c.start) - start) > 6) continue;
    const n2 = String(c.sourceText || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (n2 === norm) return true;
    const shorter = n2.length <= norm.length ? n2 : norm;
    const longer = n2.length <= norm.length ? norm : n2;
    if (shorter.length < 16) continue;
    const ratio = shorter.length / Math.max(1, longer.length);
    if (ratio >= 0.88 && longer.includes(shorter)) return true;
  }
  return false;
}
