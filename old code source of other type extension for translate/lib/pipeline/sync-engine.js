import { AUDIO } from '../constants.js';
import { log } from '../logger.js';

/**
 * Phrase queue that keeps voice-over aligned with video time.
 * Strategy for continuous, low-latency dubbing:
 * - schedule relative to video.currentTime + adaptive offset
 * - if late: re-anchor + mild speed-up instead of silence
 * - hard-drop only hopelessly old phrases
 * - if ahead: short wait (don't talk about the future)
 * - continuous mode: slight phrase overlap / soft interrupt so gaps die
 */
export class SyncEngine {
  constructor({
    getMediaTime,
    onPlayPhrase,
    onDropPhrase,
    continuous = true,
    isMediaPlaying = null,
  } = {}) {
    this.getMediaTime = getMediaTime || (() => 0);
    this.onPlayPhrase = onPlayPhrase;
    this.onDropPhrase = onDropPhrase;
    /** When false, do not start new phrases (video paused) */
    this.isMediaPlaying = isMediaPlaying;
    this.continuous = continuous !== false;
    this.queue = [];
    this.playing = false;
    this._playToken = 0;
    /** seconds — learned lag compensation */
    this.adaptiveOffset = 0.06;
    /** Late but still useful → re-anchor ASAP */
    this.softBehind = 1.15;
    /** Loop skip / re-anchor while queued */
    this.maxBehind = 6.5;
    /**
     * Hard drop only when completely hopeless.
     * Continuous dubbing prefers re-anchor over silence (REST fallback often
     * arrives 12–20s late after a stream fail — hard-dropping caused mute).
     */
    this.hardDropBehind = 12;
    /** Absolute ceiling even in continuous mode (seconds of media lag) */
    this.extremeDropBehind = 28;
    this.maxAheadWait = 0.85;
    this.raf = null;
    this.enabled = false;
    /** EMA of observed pipeline lag (seconds) */
    this._lagEma = 0;
    /** Wall-clock when current phrase started (for overlap pre-roll) */
    this._playStartedAt = 0;
    /** Estimated duration of current phrase (s) */
    this._playEstDuration = 0;
  }

  start() {
    this.enabled = true;
    this.#loop();
  }

  stop() {
    this.enabled = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.queue = [];
    this.playing = false;
    this._playToken += 1;
    this._playEstDuration = 0;
    this._playStartedAt = 0;
  }

  clear() {
    this.queue = [];
    // Do not kill in-flight audio here — caller may stop audio separately.
    // Soft-free the play slot so continuous mode can accept re-anchored phrases
    // after seek without waiting for an orphaned "playing" flag.
    this.playing = false;
    this._playToken += 1;
    this._playEstDuration = 0;
  }

  /**
   * Soft-stop current playback so a fresher phrase can start (continuous mode).
   * @returns {boolean} whether a play slot was freed
   */
  interruptPlaying() {
    if (!this.playing) return false;
    this._playToken += 1;
    this.playing = false;
    this._playEstDuration = 0;
    return true;
  }

  /**
   * @param {{ id: string, text: string, sourceText: string, start: number, end: number, audioUrl?: string, audioBuffer?: ArrayBuffer, durationHint?: number, playbackRate?: number }} phrase
   */
  enqueue(phrase) {
    if (!phrase?.text) return;
    const now = this.getMediaTime();
    const end = phrase.end ?? phrase.start ?? now;
    const start = phrase.start ?? Math.max(0, end - 2);
    const lag = Math.max(0, now - end);

    if (lag > 0) {
      this._lagEma = this._lagEma ? this._lagEma * 0.7 + lag * 0.3 : lag;
    }

    // Strict timeline: drop hopelessly late. Continuous: re-anchor unless extreme.
    const dropLimit = this.continuous
      ? this.extremeDropBehind || 28
      : this.hardDropBehind;
    if (lag > dropLimit) {
      log.debug('sync drop stale on enqueue', phrase.text.slice(0, 40), {
        lag: +lag.toFixed(2),
        continuous: this.continuous,
      });
      this.onDropPhrase?.(phrase, 'stale');
      return;
    }

    let item = { ...phrase, start, end };

    if (lag > this.softBehind) {
      const dur = Math.max(0.35, (end - start) || phrase.durationHint || 1.6);
      // Under heavy lag (REST fallback), push rate harder so we catch up.
      const rateCap = lag > this.hardDropBehind ? 1.55 : 1.38;
      const rate = Math.min(
        rateCap,
        1 + Math.min(rateCap - 1, (lag - this.softBehind) * 0.08),
      );
      item = {
        ...item,
        start: now,
        end: now + dur / rate,
        late: true,
        lagSec: lag,
        playbackRate: rate,
      };
      log.debug('sync re-anchor late phrase', item.text.slice(0, 40), {
        lag: +lag.toFixed(2),
        rate: +rate.toFixed(2),
      });
      this.adaptiveOffset = Math.max(-0.12, this.adaptiveOffset - 0.05);
    }

    // If something is already playing and we are late with a fresher cue,
    // soft-interrupt so continuous mode doesn't stall on an old sentence.
    if (
      this.continuous &&
      this.playing &&
      lag > this.softBehind * 1.4 &&
      this.queue.length === 0
    ) {
      this.interruptPlaying();
    }

    this.queue.push(item);
    while (this.queue.length > AUDIO.maxTtsQueue) {
      const dropped = this.queue.shift();
      this.onDropPhrase?.(dropped, 'overflow');
    }
    this.queue.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }

  #loop = () => {
    if (!this.enabled) return;
    this.raf = requestAnimationFrame(this.#loop);
    if (!this.queue.length) return;

    // Video paused / not ready — hold queue (caller should clear on pause)
    if (this.isMediaPlaying && !this.isMediaPlaying()) {
      return;
    }

    // Continuous: allow next phrase slightly before previous ends (gapless)
    if (this.playing) {
      if (!this.continuous) return;
      const overlapSec = (AUDIO.phraseOverlapMs || 120) / 1000;
      const elapsed = (performance.now() - this._playStartedAt) / 1000;
      const remaining = this._playEstDuration - elapsed;
      const next = this.queue[0];
      const now = this.getMediaTime();
      const nextLate = next?.late || (next && (next.end ?? next.start) < now - 0.4);
      // Start early only near end of current OR if next is already late
      if (!(remaining <= overlapSec + 0.04 || (nextLate && remaining <= 0.45))) {
        return;
      }
      // Free the slot; previous audio may still trail a bit (overlap)
      this.playing = false;
    }

    const now = this.getMediaTime();
    const next = this.queue[0];
    const target = (next.start ?? now) + (next.late ? 0 : this.adaptiveOffset);

    const end = next.end ?? next.start ?? now;
    if (!next.late && end < now - this.maxBehind) {
      const lag = now - end;
      if (lag <= this.hardDropBehind) {
        this.queue.shift();
        const dur = Math.max(0.35, (end - (next.start ?? end)) || 1.6);
        const rate = Math.min(1.38, 1.12 + Math.min(0.26, lag * 0.035));
        this.queue.unshift({
          ...next,
          start: now,
          end: now + dur / rate,
          late: true,
          lagSec: lag,
          playbackRate: Math.max(next.playbackRate || 1, rate),
        });
        this.adaptiveOffset = Math.max(-0.14, this.adaptiveOffset - 0.05);
        return;
      }
      this.queue.shift();
      this.onDropPhrase?.(next, 'behind');
      this.adaptiveOffset = Math.max(-0.14, this.adaptiveOffset - 0.05);
      return;
    }

    // Wait if early (don't speak about the future)
    if (!next.late && target > now + 0.04) {
      if (target - now > this.maxAheadWait && next.start < now + 0.15) {
        // start soon anyway to avoid dead air
      } else if (target > now + 0.06) {
        return;
      }
    }

    this.queue.shift();
    this.playing = true;
    const token = ++this._playToken;
    const rate = Number(next.playbackRate) || 1;
    const mediaDur = Math.max(
      0.35,
      (next.end ?? now + 1.5) - (next.start ?? now),
    );
    // Wall estimate for gapless handoff
    this._playEstDuration = mediaDur / Math.max(0.85, rate);
    this._playStartedAt = performance.now();

    Promise.resolve(this.onPlayPhrase?.(next))
      .catch((e) => log.warn('play phrase failed', e))
      .finally(() => {
        // Ignore stale completions after interrupt / newer play
        if (token !== this._playToken) return;
        this.playing = false;
        const wall = (performance.now() - this._playStartedAt) / 1000;
        const mediaNow = this.getMediaTime();
        if (next.end && mediaNow > next.end + 1.2) {
          this.adaptiveOffset = Math.max(-0.14, this.adaptiveOffset - 0.03);
        } else if (wall < 0.35 && next.end && mediaNow < next.end) {
          this.adaptiveOffset = Math.min(0.4, this.adaptiveOffset + 0.015);
        }
      });
  };

  getState() {
    return {
      queueLength: this.queue.length,
      playing: this.playing,
      adaptiveOffset: this.adaptiveOffset,
      lagEma: this._lagEma,
      continuous: this.continuous,
    };
  }
}
