import { AUDIO } from '../constants.js';
import { log } from '../logger.js';

/**
 * Detects silent pipeline death (classic VOT/Yandex-script failure mode)
 * and triggers auto-recover + user-visible alerts.
 *
 * Stall rules (important):
 * - Quiet video segments are NOT stalls — only missing capture samples
 *   while media is playing, or stuck in-flight STT/MT/TTS.
 * - Paused / ended media does not degrade the pipeline.
 */
export class HealthMonitor {
  constructor({
    onDegraded,
    onRecovered,
    onTick,
    isMediaPlaying,
    isRecovering,
    stallTimeoutMs = AUDIO.stallTimeoutMs,
    inflightTimeoutMs = AUDIO.inflightTimeoutMs,
  } = {}) {
    this.onDegraded = onDegraded;
    this.onRecovered = onRecovered;
    this.onTick = onTick;
    this.isMediaPlaying = isMediaPlaying || (() => true);
    /** While true, skip new stall detections (avoid recover thrash). */
    this.isRecovering = isRecovering || (() => false);
    this.stallTimeoutMs = stallTimeoutMs;
    this.inflightTimeoutMs = inflightTimeoutMs;
    this.lastProgressAt = Date.now();
    this.lastCaptureAt = Date.now();
    this.lastStatus = 'idle';
    this.degraded = false;
    this.timer = null;
    this.inflightSince = 0;
    this.stats = {
      sttOk: 0,
      sttFail: 0,
      mtOk: 0,
      mtFail: 0,
      ttsOk: 0,
      ttsFail: 0,
      recoveries: 0,
      lastError: '',
      lastReason: '',
    };
  }

  start() {
    this.stop();
    const now = Date.now();
    this.lastProgressAt = now;
    this.lastCaptureAt = now;
    this.inflightSince = 0;
    this.degraded = false;
    this.timer = setInterval(() => this.#check(), AUDIO.healthIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Audio graph is delivering samples (incl. silence). */
  markCapture() {
    this.lastCaptureAt = Date.now();
    // Only auto-clear capture-silent stalls — not hung STT/MT/TTS
    if (this.degraded && String(this.stats.lastReason || '').startsWith('capture')) {
      this.#clearDegraded('capture');
    }
  }

  markProgress(kind = 'generic') {
    const now = Date.now();
    this.lastProgressAt = now;
    if (kind === 'capture') {
      this.lastCaptureAt = now;
    }
    if (kind === 'stt') this.stats.sttOk += 1;
    if (kind === 'mt') this.stats.mtOk += 1;
    if (kind === 'tts') this.stats.ttsOk += 1;
    if (this.degraded) {
      this.#clearDegraded(kind);
    }
  }

  /**
   * Explicit recover after auto-restart (always clears degraded).
   * Capture restart should refresh timers without claiming "phrase progress".
   */
  clearDegraded(source = 'manual') {
    if (this.degraded) this.#clearDegraded(source);
    else {
      this.lastProgressAt = Date.now();
      this.lastCaptureAt = Date.now();
    }
  }

  #clearDegraded(source) {
    this.degraded = false;
    this.stats.recoveries += 1;
    this.stats.lastReason = '';
    this.lastProgressAt = Date.now();
    // capture-restart / inflight-reset: refresh capture clock so we don't
    // immediately re-stall, but real samples still come from markCapture.
    this.lastCaptureAt = Date.now();
    log.info('Health: recovered', source);
    this.onRecovered?.(this.snapshot());
  }

  markFailure(kind, error) {
    if (kind === 'stt') this.stats.sttFail += 1;
    if (kind === 'mt') this.stats.mtFail += 1;
    if (kind === 'tts') this.stats.ttsFail += 1;
    this.stats.lastError = String(error?.message || error || '');
  }

  /** busyChunks > 0 → call with true; when idle → false. */
  setInflight(active) {
    if (active) {
      if (!this.inflightSince) this.inflightSince = Date.now();
    } else {
      this.inflightSince = 0;
    }
  }

  setStatus(status) {
    this.lastStatus = status;
  }

  #check() {
    const now = Date.now();
    const snap = this.snapshot();
    this.onTick?.(snap);

    const active =
      this.lastStatus === 'running' ||
      this.lastStatus === 'starting' ||
      this.lastStatus === 'degraded';
    // paused / stopped / error / idle — never treat as pipeline death
    if (!active || this.degraded) return;

    // Mid auto-recover — don't stack another degrade
    if (this.isRecovering?.()) return;

    // Paused / ended video — not a pipeline death
    if (!this.isMediaPlaying()) return;

    const captureIdle = now - this.lastCaptureAt;
    const progressIdle = now - this.lastProgressAt;
    // Inflight is only "stuck" if work is open AND no STT/MT/TTS progress
    // (continuous speech keeps busyChunks > 0 without being hung).
    const inflightStuck =
      !!this.inflightSince && progressIdle > this.inflightTimeoutMs;
    const inflightFor = this.inflightSince ? now - this.inflightSince : 0;

    let reason = '';
    if (captureIdle > this.stallTimeoutMs) {
      reason = `capture silent ${captureIdle} ms`;
    } else if (inflightStuck) {
      reason = `inflight stuck ${inflightFor} ms (no progress ${progressIdle} ms)`;
    }

    if (!reason) return;

    this.degraded = true;
    this.stats.lastReason = reason;
    log.warn('Health: pipeline stalled', reason);
    this.onDegraded?.(this.snapshot());
  }

  snapshot() {
    const now = Date.now();
    return {
      ...this.stats,
      degraded: this.degraded,
      status: this.lastStatus,
      idleForMs: now - this.lastProgressAt,
      captureIdleMs: now - this.lastCaptureAt,
      inflightForMs: this.inflightSince ? now - this.inflightSince : 0,
      lastProgressAt: this.lastProgressAt,
      lastCaptureAt: this.lastCaptureAt,
      playing: !!this.isMediaPlaying?.(),
    };
  }
}
