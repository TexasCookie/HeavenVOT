import { AUDIO, MSG } from '../constants.js';
import { sttLanguageParam, ttsLanguageCode } from '../languages.js';
import { log } from '../logger.js';
import { isLocalProvider } from '../provider.js';
import {
  pcm16ToWavBlob,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  pcm16ToFloat32,
  rmsLevel,
} from '../pcm-utils.js';
import { sendMessage } from '../messaging.js';
import { resolveVoiceForGender } from '../voices.js';
import {
  SpeakerGenderTracker,
  voiceProfileLabelRu,
} from '../voice-gender.js';
import { VideoAudioCapture } from './audio-capture.js';
import { SyncEngine } from './sync-engine.js';
import { HealthMonitor } from './health-monitor.js';
import { buildVideoContext } from './context-builder.js';
import { findStaleCues } from '../learning.js';
import { splitIntoSpeakableUnits } from '../xai/token-economy.js';
import { peelReadyClauses } from './clause-splitter.js';
import { StreamBridge } from './stream-bridge.js';
import {
  clauseShouldDispatch,
  inflightTimeoutForProvider,
  restChunkSec,
  sttApiTimeoutMs,
} from './live-policy.js';
import { isYoutubeHost } from '../media/url-guard.js';

let phraseSeq = 0;

/**
 * Full live/VOD pipeline living next to the video element:
 * capture → STT (xAI) → Grok translate → TTS (xAI) → sync play + subs
 * + self-learning + stale retranslation while watching
 */
export class TranslatorPipeline {
  /**
   * @param {object} opts
   * @param {HTMLMediaElement} opts.video
   * @param {object} opts.settings
   * @param {(ev: object) => void} opts.onEvent
   * @param {(subs: object) => void} opts.onSubtitles
   * @param {(vol: number) => void} [opts.onOriginalVolume]
   */
  constructor({ video, settings, onEvent, onSubtitles, onOriginalVolume }) {
    this.video = video;
    this.settings = settings;
    this.onEvent = onEvent || (() => {});
    this.onSubtitles = onSubtitles || (() => {});
    this.onOriginalVolume = onOriginalVolume;

    this.status = 'idle';
    this.capture = null;
    this.sync = null;
    this.health = null;
    this.history = [];
    this.context = buildVideoContext(video);
    this.running = false;
    this.busyChunks = 0;
    this.seenHashes = new Set();
    this.subtitleCues = [];
    this._audioEl = null;
    this._recoverTimer = null;
    this._recovering = false;
    this._recoverAttempts = 0;
    this._recoverDeferred = false;
    this._lastRecoverAt = 0;
    this._epoch = 0;
    this._lastTtsUrl = null;
    this._lastTtsUrlB = null;
    this._audioElB = null;
    this._useAltAudio = false;
    this._learnCounter = 0;
    this._learningRevision = 0;
    this._staleTimer = null;
    this._retranslating = false;
    this._mediaListeners = null;
    /** Pitch + spectral voice type → TTS match (anti ♂/♀ mismatch) */
    this._genderTracker = new SpeakerGenderTracker();
    this._sessionVoiceId = null;
    this._sessionSpeakerGender = null;
    this._sessionVoiceType = null;
    /** Voice only switches after lock — avoids early ♂/♀ flip-flop */
    this._voiceLocked = false;
    /**
     * When all STT/MT/TTS slots are busy, keep only the *latest* audio chunk
     * instead of hard-dropping speech (backpressure coalescing).
     * @type {{ float32: Float32Array, meta: object } | null}
     */
    this._pendingChunk = null;
    /** Rolling EMA of end-to-end phrase latency (ms) */
    this._latencyEmaMs = 0;
    /** Streaming STT/TTS path (WS) — target 1.5–3s first-audio */
    this._stream = null;
    this._streamMode = false;
    this._streamFailCount = 0;
    /** Current utterance assembly for clause MT */
    this._utt = this.#freshUtt();
    this._streamBusy = 0;
    this._firstAudioLogged = false;
    /** Last time we got non-empty STT text (stream or REST) */
    this._lastSttTextAt = 0;
    /** Chunks with empty STT while playing (REST path diagnostics) */
    this._emptySttStreak = 0;
    /** Watchdog: streaming open but no transcript → REST fallback */
    this._noSpeechTimer = null;
    this._noSpeechWarned = false;
    /** Soft reopen in-flight (prevents cascade fallback on race) */
    this._streamReopenPromise = null;
    this._streamReopenAt = 0;
    /** After REST fallback: keep only latest chunk without faking lag-shed EMA */
    this._restLatestOnly = false;
    this._lastFallbackAt = 0;
    /**
     * Recent spoken sources for fuzzy anti-repeat (exact hash alone misses
     * "hello world" vs "hello world." / partial clause re-peels).
     * @type {{ norm: string, words: Set<string>, at: number }[]}
     */
    this._recentSpoken = [];
    /** Accumulate stream PCM for reliable F0 (100ms frames are too short alone) */
    this._genderPcmBuf = [];
    this._genderPcmSamples = 0;
  }

  #freshUtt() {
    return {
      text: '',
      consumed: 0,
      mediaStart: 0,
      mediaEnd: 0,
      t0: 0,
      active: false,
    };
  }

  updateSettings(settings) {
    this.settings = settings;
    if (this.capture && settings) {
      this.capture.setOriginalVolume(settings.originalVolume);
      this.#retuneCaptureForLatency();
    }
    if (this.sync && settings) {
      this.sync.continuous = settings.continuousDubbing !== false;
    }
  }

  /**
   * Re-harvest page title/channel after SPA navigation (YouTube etc.)
   * without restarting capture — keeps glossary/domain hints fresh.
   */
  refreshContext() {
    try {
      this.context = buildVideoContext(this.video);
      this.onEvent({
        type: 'context',
        context: this.context,
        message: this.context?.videoTitle
          ? `Контекст: ${String(this.context.videoTitle).slice(0, 80)}`
          : 'Контекст обновлён',
      });
    } catch (e) {
      log.debug('refreshContext', e?.message || e);
    }
  }

  getState() {
    return {
      status: this.status,
      running: this.running,
      health: this.health?.snapshot?.() || null,
      sync: this.sync?.getState?.() || null,
      context: this.context,
      subtitleCount: this.subtitleCues.length,
      busyChunks: this.busyChunks,
      streamMode: this._streamMode,
      streamBusy: this._streamBusy,
      speakerGender: this._sessionSpeakerGender,
      speakerVoiceType: this._sessionVoiceType,
      sessionVoiceId: this._sessionVoiceId,
      gender: this._genderTracker?.snapshot?.() || null,
    };
  }

  #wantStreaming() {
    // Realtime WS path is for live streams only — VOD/page REST chunks otherwise
    if (!this.#isLive()) return false;
    // Local gateway has no xAI WS — REST + native VAD only
    if (isLocalProvider(this.settings)) return false;
    return this.settings?.streamingPipeline !== false && this._streamFailCount < 3;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._epoch += 1;
    this.busyChunks = 0;
    this._pendingChunk = null;
    this._latencyEmaMs = 0;
    this._recoverAttempts = 0;
    this._recovering = false;
    this._recoverDeferred = false;
    this._voiceLocked = false;
    this.#setStatus('starting');
    this.context = buildVideoContext(this.video);
    this.history = [];
    this.subtitleCues = [];
    this.seenHashes.clear();
    this._learnCounter = 0;
    this._learningRevision = 0;
    this._genderTracker.reset();
    this._sessionVoiceId = null;
    this._sessionSpeakerGender = null;
    this._sessionVoiceType = null;
    this._streamFailCount = 0;
    this._streamMode = false;
    this._streamBusy = 0;
    this._firstAudioLogged = false;
    this._ttsWsAuthNoted = false;
    this._restLatestOnly = false;
    this._lastFallbackAt = 0;
    this._recentSpoken = [];
    this._inflightSpoken = new Set();
    this._genderPcmBuf = [];
    this._genderPcmSamples = 0;
    this._utt = this.#freshUtt();
    this._lastSttTextAt = 0;
    this._emptySttStreak = 0;
    this._noSpeechWarned = false;
    this.#clearNoSpeechWatch();
    this.#teardownStream();

    this.health = new HealthMonitor({
      inflightTimeoutMs: inflightTimeoutForProvider(this.settings?.providerMode),
      isMediaPlaying: () => this.#isMediaPlaying(),
      isRecovering: () => this._recovering || !!this._recoverTimer,
      onDegraded: (snap) => {
        this.#setStatus('degraded');
        const reason = snap?.lastReason || 'unknown';
        this.onEvent({
          type: 'health',
          level: 'error',
          message:
            'Перевод завис или пропал. AetherVox перезапускает пайплайн автоматически…',
          snapshot: snap,
          reason,
        });
        this.#autoRecover(reason);
      },
      onRecovered: (snap) => {
        // Only treat real recover as success for UI; do not reset attempts
        // here — a successful phrase resets backoff (see #onAudioChunk).
        if (this.status === 'degraded' || this.status === 'paused') {
          this.#setStatus('running');
        }
        this.onEvent({
          type: 'health',
          level: 'ok',
          message: 'Перевод восстановлен',
          snapshot: snap,
        });
      },
      onTick: (snap) => {
        this.onEvent({ type: 'health_tick', snapshot: snap });
      },
    });

    this.sync = new SyncEngine({
      getMediaTime: () => this.video.currentTime || 0,
      onPlayPhrase: (phrase) => this.#playPhrase(phrase),
      onDropPhrase: (phrase, reason) => {
        log.debug('dropped phrase', reason, phrase?.text?.slice?.(0, 40));
        this.onEvent({ type: 'phrase_dropped', reason, text: phrase?.text });
      },
      continuous: this.settings.continuousDubbing !== false,
      isMediaPlaying: () => this.#isMediaPlaying(),
    });

    this.#bindMediaLifecycle();
    this.#unlockTtsAudio();

    const chunkSec = this.#chunkSec();
    const wantStream = this.#wantStreaming();

    this.capture = new VideoAudioCapture(this.video, {
      chunkSec,
      overlapSec: AUDIO.chunkOverlapSec,
      streamFrameSec: AUDIO.streamFrameSec || 0.1,
      streamOnly: false, // flipped on after STT WS ready
      onPcmChunk: (float32, meta) => this.#onAudioChunk(float32, meta),
      onPcmStream: (pcm16, meta) => this.#onStreamPcm(pcm16, meta),
      onActivity: () => this.health?.markCapture(),
    });

    try {
      // Open streaming WS in parallel with capture graph — cold STT auth/WS
      // used to block first-audio by +3–8s after capture was already ready.
      const streamOpenPromise = wantStream
        ? this.#startStreamingWithRetry().catch((e) => {
            log.warn('Streaming STT failed, REST fallback', e?.message || e);
            this.#fallbackFromStream(e?.message || e);
            return null;
          })
        : Promise.resolve(null);

      await this.capture.start();
      this.capture.setOriginalVolume(this.settings.originalVolume ?? 0.15);
      this.sync.start();
      this.health.start();
      this.health.setStatus('running');
      this.#setStatus('running');
      this.health.markProgress('generic');
      this.health.markCapture();
      this.#retuneCaptureForLatency();

      // Don't block UI/REST forever on slow WS — race with a short budget.
      // After budget, REST chunks already run (hybrid); stream attaches when ready.
      if (wantStream) {
        const budgetMs = 2800;
        await Promise.race([
          streamOpenPromise,
          new Promise((r) => setTimeout(r, budgetMs)),
        ]);
        // Keep waiting in background if still pending (no double-fallback)
        streamOpenPromise.then(() => {
          if (this.running && this._streamMode) {
            this.onEvent({
              type: 'info',
              message: 'Streaming STT подключён (низкая задержка)',
            });
          }
        });
      }

      // Arm "started but mute" watchdog (stream or REST)
      this.#armNoSpeechWatch();

      const isLive = this.#isLive();
      this.onEvent({
        type: 'started',
        message: this._streamMode
          ? isLive
            ? 'Live streaming: STT WS + clause MT + TTS (цель 1.5–3s first-audio)'
            : 'Streaming пайплайн: STT WS + partial MT + TTS'
          : isLive
            ? 'Live-режим: REST чанки (streaming off/fallback)'
            : 'Перевод запущен (VOD/страница, REST)',
        context: this.context,
        streamMode: this._streamMode,
      });
    } catch (e) {
      this.#setStatus('error');
      this.running = false;
      this.#unbindMediaLifecycle();
      const msg = String(e?.message || e);
      const corsHint =
        /cross-origin|CORS|InvalidStateError|already connected/i.test(msg)
          ? ' Возможно, сайт/DRM блокирует Web Audio. Попробуй другой плеер или обнови страницу.'
          : '';
      this.onEvent({
        type: 'error',
        message: `Не удалось захватить аудио: ${msg}.${corsHint}`,
      });
      throw e;
    }
  }

  async stop() {
    this.running = false;
    this._epoch += 1;
    this._recovering = false;
    this._recoverDeferred = false;
    if (this._recoverTimer) {
      clearTimeout(this._recoverTimer);
      this._recoverTimer = null;
    }
    if (this._staleTimer) {
      clearTimeout(this._staleTimer);
      this._staleTimer = null;
    }
    this.#clearNoSpeechWatch();
    this.#teardownStream();
    this.#unbindMediaLifecycle();
    this.health?.stop();
    this.sync?.stop();
    await this.capture?.stop();
    this.capture = null;
    this.busyChunks = 0;
    this._streamBusy = 0;
    this._inflightSpoken = new Set();
    this._pendingChunk = null;
    this.health?.setInflight(false);
    for (const el of [this._audioEl, this._audioElB]) {
      if (!el) continue;
      try {
        el.pause();
        el.removeAttribute('src');
      } catch {
        /* ignore */
      }
    }
    if (this._lastTtsUrl) {
      URL.revokeObjectURL(this._lastTtsUrl);
      this._lastTtsUrl = null;
    }
    if (this._lastTtsUrlB) {
      URL.revokeObjectURL(this._lastTtsUrlB);
      this._lastTtsUrlB = null;
    }
    this.#setStatus('stopped');
    this.onEvent({ type: 'stopped', message: 'Перевод остановлен' });
  }

  #isLive() {
    if (this.settings.mode === 'vod') return false;
    if (this.settings.mode === 'live') return true;
    // auto: only true livestreams use realtime; finite VOD uses prepare / REST
    return !!this.context?.isLive;
  }

  /**
   * Effective quality for THIS phrase (prompt richness only — live model is always fast tier).
   * Under lag shed we force "fast" (tiny MT prompt) regardless of UI.
   * Live hot path prioritizes latency: max still uses compact-ish prompts (see translate.js live).
   */
  #effectiveQualityProfile() {
    const base = this.settings.qualityProfile || 'balanced';
    if (this._latencyEmaMs >= (AUDIO.lagShedLatencyMs || 4500)) return 'fast';
    // max → balanced early so prompts slim before death spiral
    if (this._latencyEmaMs >= (AUDIO.lagBoostLatencyMs || 2800) && base === 'max') {
      return 'balanced';
    }
    return base;
  }

  /** User-selected profile (for UI) vs effective after lag-shed */
  #userQualityProfile() {
    return this.settings.qualityProfile || 'balanced';
  }

  #isLagShed() {
    return this._latencyEmaMs >= (AUDIO.lagShedLatencyMs || 5200);
  }

  #isHardLag() {
    return this._latencyEmaMs >= (AUDIO.lagDropStaleMs || 7500);
  }

  #maxBusy() {
    if (this.#isLagShed() || this._restLatestOnly) return AUDIO.lagShedMaxBusy || 1;
    return AUDIO.maxBusyChunks || 2;
  }

  #chunkSec() {
    const isLive = this.#isLive();
    const profile = this.#effectiveQualityProfile();
    const mildLag =
      this._latencyEmaMs > (AUDIO.lagBoostLatencyMs || 2800) && !this.#isLagShed();
    const hardLag = this.#isLagShed();
    let sec = restChunkSec({ isLive, profile });
    if (mildLag) sec = Math.max(0.95, sec * 0.9);
    if (hardLag) sec = Math.min(isLive ? 2.0 : 2.8, Math.max(sec * 1.1, isLive ? 1.45 : 2.0));
    return sec;
  }

  /** Effective TTS speed: user base + lag boost (continuous catch-up) */
  #effectiveTtsSpeed() {
    const base = Number(this.settings.ttsSpeed) || 1.0;
    if (this.settings.adaptiveTtsSpeed === false) {
      return Math.max(0.85, Math.min(1.35, base));
    }
    const lagMs = this._latencyEmaMs || 0;
    const threshold = AUDIO.lagBoostLatencyMs || 4000;
    const maxSp = AUDIO.maxAdaptiveTtsSpeed || 1.28;
    if (lagMs <= threshold) return Math.max(0.85, Math.min(1.35, base));
    // Linear ramp: at lagShed approach maxSp, beyond that push slightly more
    const shed = AUDIO.lagShedLatencyMs || 6500;
    const t = Math.min(1, (lagMs - threshold) / Math.max(1, shed - threshold));
    const boosted = base + (maxSp - base) * t;
    return Math.max(0.85, Math.min(1.42, boosted));
  }

  /** Hot-retune capture window from latest latency EMA */
  #retuneCaptureForLatency() {
    if (!this.capture?.setChunkSec) return;
    const sec = this.#chunkSec();
    this.capture.setChunkSec(sec);
    if (this.capture.setSilenceFlushSec) {
      let flush = AUDIO.silenceFlushSec;
      if (this.#effectiveQualityProfile() === 'fast') flush = 0.36;
      else if (this.#isLagShed()) flush = 0.42;
      else if (this._latencyEmaMs > (AUDIO.lagBoostLatencyMs || 4000)) flush = 0.4;
      this.capture.setSilenceFlushSec(flush);
    }
  }

  /**
   * Mid-flight: if a fresher chunk is waiting and we are already late,
   * abandon the rest of STT→MT→TTS for this phrase (frees the slot).
   */
  #shouldAbortForFresher(stage = '') {
    if (!this._pendingChunk) return false;
    if (this.#isHardLag()) {
      log.debug('abort stale mid-flight (hard lag)', stage);
      return true;
    }
    // Under lag-shed with a pending chunk: never finish old work after STT
    if (this.#isLagShed() && (stage === 'after-stt' || stage === 'after-mt')) {
      log.debug('abort stale mid-flight (lag shed)', stage);
      return true;
    }
    return false;
  }

  #isMediaPlaying() {
    const v = this.video;
    if (!v) return false;
    if (v.ended) return false;
    if (v.paused) return false;
    // seeking / readyState 0 can look like silence
    if (v.readyState < 2) return false;
    return true;
  }

  #bindMediaLifecycle() {
    this.#unbindMediaLifecycle();
    const v = this.video;
    if (!v) return;
    const onPause = () => {
      if (!this.running) return;
      // Pause is not a failure — health monitor already skips non-playing media.
      // Do NOT fake markCapture/markProgress (that caused running↔degraded thrash).
      // Keep pipeline.status in sync so UI/health snapshots are truthful.
      if (this.status !== 'paused' && this.status !== 'stopped') {
        this.#setStatus('paused');
      }
      // Stop queued/current dub immediately — otherwise next TTS fragment plays
      // over a paused video, then duck restore races and original can stay muted.
      this.#haltPlaybackForMediaPause();
    };
    const onPlay = () => {
      if (!this.running) return;
      // Resume AudioContext only — real capture heartbeats come from the processor.
      this.capture?.ensureLive?.().catch?.(() => {});
      // Deferred recover while paused/buffering, dead capture, or still degraded.
      const captureDead = !this.capture || this.capture.running === false;
      if (
        this._recoverDeferred ||
        this.status === 'degraded' ||
        captureDead
      ) {
        const reason =
          this.health?.stats?.lastReason ||
          (captureDead ? 'capture-dead-on-play' : 'play-resume');
        this._recoverDeferred = false;
        this.#autoRecover(reason);
        return;
      }
      if (this.status === 'paused') {
        this.#setStatus('running');
      }
    };
    const onSeeking = () => {
      if (!this.running) return;
      // Drop in-flight work tied to old timeline; keep capture graph if alive.
      // Seeking must NOT bump epoch while recover is mid-restart (kills capture).
      if (!this._recovering) {
        this._epoch += 1;
      }
      this.busyChunks = 0;
      this._streamBusy = 0;
      this._pendingChunk = null;
      this._utt = this.#freshUtt();
      this.health?.setInflight(false);
      this.sync?.clear?.();
      if (!this.capture || this.capture.running === false) {
        this.#autoRecover('capture-dead-after-seek');
      }
    };
    const onVisible = () => {
      if (!this.running) return;
      if (document.visibilityState === 'visible') {
        this.capture?.ensureLive?.().catch?.(() => {});
        if (!this.capture || this.capture.running === false) {
          this.#autoRecover('capture-dead-on-visible');
        }
      }
    };
    v.addEventListener('pause', onPause);
    v.addEventListener('play', onPlay);
    v.addEventListener('playing', onPlay);
    v.addEventListener('seeking', onSeeking);
    document.addEventListener('visibilitychange', onVisible);
    this._mediaListeners = { v, onPause, onPlay, onSeeking, onVisible };
  }

  #unbindMediaLifecycle() {
    const L = this._mediaListeners;
    if (!L) return;
    try {
      L.v?.removeEventListener('pause', L.onPause);
      L.v?.removeEventListener('play', L.onPlay);
      L.v?.removeEventListener('playing', L.onPlay);
      L.v?.removeEventListener('seeking', L.onSeeking);
      document.removeEventListener('visibilitychange', L.onVisible);
    } catch {
      /* ignore */
    }
    this._mediaListeners = null;
  }

  /**
   * Restart capture + drop hung in-flight STT/MT/TTS (generation epoch).
   * Never leaves capture stopped after a partial recover (epoch/seek race).
   * Backs off if recover thrashing; silence alone no longer triggers this.
   */
  #autoRecover(reason = '') {
    if (!this.running) return;
    if (this._recoverTimer || this._recovering) return;

    const maxAttempts = AUDIO.recoverMaxAttempts || 6;
    if (this._recoverAttempts >= maxAttempts) {
      log.error(
        `Auto-recover thrash limit: ${reason || 'unknown'} | attempts=${this._recoverAttempts}`,
      );
      this.onEvent({
        type: 'error',
        message:
          'Перевод несколько раз сорвался. Нажми «Перевод» чтобы перезапустить пайплайн.',
      });
      // Full stop so the next UI toggle is a clean start (not stop-then-start).
      this.stop().catch((e) => log.warn('stop after thrash limit', e));
      return;
    }

    const attempt = this._recoverAttempts;
    const delay = Math.min(
      AUDIO.recoverMaxDelayMs,
      (AUDIO.recoverMinDelayMs || 800) * 2 ** Math.min(attempt, 4),
    );

    this._recoverTimer = setTimeout(async () => {
      this._recoverTimer = null;
      if (!this.running) return;

      // Don't thrash while user paused / buffering — keep degraded and resume later.
      if (!this.#isMediaPlaying()) {
        this._recoverDeferred = true;
        log.info(`Auto-recover deferred (media not playing): ${reason || 'unknown'}`);
        return;
      }

      this._recovering = true;
      this._recoverDeferred = false;
      this._recoverAttempts += 1;
      this._lastRecoverAt = Date.now();
      // Invalidate all in-flight chunk pipelines (busyChunks / _streamBusy can stick forever otherwise)
      this._epoch += 1;
      this.busyChunks = 0;
      this._streamBusy = 0;
      this._pendingChunk = null;
      this._utt = this.#freshUtt();
      this.health?.setInflight(false);
      this.sync?.clear?.();

      const captureAlive = !!this.capture?.running;
      const inflightOnly =
        String(reason || '').startsWith('inflight') && captureAlive;
      log.warn(
        `Auto-recover: ${reason || 'unknown'} | attempt=${this._recoverAttempts} delay=${delay}ms inflightOnly=${inflightOnly} captureAlive=${captureAlive}`,
      );

      try {
        if (inflightOnly) {
          // Capture is alive — only drop hung API work and resume AudioContext
          await this.capture.ensureLive();
          this.health?.clearDegraded?.('inflight-reset');
          this.#setStatus('running');
          this.onEvent({
            type: 'health',
            level: 'ok',
            message: 'Сброшены зависшие запросы STT/MT/TTS',
          });
        } else {
          // ALWAYS finish restart if still running — never abort after stop()
          // because of a seek epoch bump (classic "translation vanished" bug).
          try {
            await this.capture?.stop();
          } catch {
            /* ignore */
          }
          if (!this.running) return;

          this.capture = new VideoAudioCapture(this.video, {
            chunkSec: this.#chunkSec(),
            overlapSec: AUDIO.chunkOverlapSec,
            streamFrameSec: AUDIO.streamFrameSec || 0.1,
            streamOnly: false,
            onPcmChunk: (f, m) => this.#onAudioChunk(f, m),
            onPcmStream: (pcm16, meta) => this.#onStreamPcm(pcm16, meta),
            onActivity: () => this.health?.markCapture(),
          });
          await this.capture.start();
          await this.capture.ensureLive();
          this.capture.setOriginalVolume(this.settings.originalVolume ?? 0.15);
          // Re-bind streaming STT if still enabled
          if (this.#wantStreaming()) {
            try {
              this.#teardownStream();
              await this.#startStreaming();
            } catch (e) {
              log.warn('stream re-open after recover failed', e?.message || e);
              this._streamMode = false;
              this.capture.setStreamOnly?.(false);
            }
          }
          // Real samples will markCapture; do not fake progress here.
          this.health?.clearDegraded?.('capture-restart');
          this.#setStatus('running');
          this.onEvent({
            type: 'health',
            level: 'ok',
            message: this._streamMode
              ? 'Захват + streaming STT перезапущены'
              : 'Захват аудио перезапущен',
          });
        }
      } catch (e) {
        // Leave degraded so health can re-trigger after backoff; keep flag true.
        if (this.health) {
          this.health.degraded = true;
          this.health.stats.lastReason = `recover-failed: ${e.message || e}`;
        }
        this.#setStatus('degraded');
        this.onEvent({
          type: 'error',
          message: `Авто-восстановление не удалось: ${e.message || e}. Нажми «Перевод» ещё раз.`,
        });
        // Schedule another attempt with backoff if under limit
        this._recovering = false;
        if (this.running && this._recoverAttempts < maxAttempts) {
          this.#autoRecover(`recover-failed: ${e.message || e}`);
        }
        return;
      } finally {
        this._recovering = false;
      }
    }, delay);
  }

  #setStatus(status) {
    this.status = status;
    this.health?.setStatus(status);
    this.onEvent({ type: 'status', status, state: this.getState() });
  }

  #hashText(t) {
    const s = this.#normalizeSpoken(t);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `${h}:${s.slice(0, 48)}`;
  }

  /** Strip punctuation / collapse spaces for anti-repeat matching */
  #normalizeSpoken(t) {
    return String(t || '')
      .toLowerCase()
      // Keep letters (incl. Cyrillic) + digits; drop punctuation that breaks exact hashes
      .replace(/[^\w\u0400-\u04FF\u0500-\u052F\u00C0-\u024F\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  #wordSet(norm) {
    return new Set(norm.split(' ').filter((w) => w.length > 1));
  }

  /**
   * Exact hash OR high word-overlap with a recently spoken phrase.
   * Prevents "word word word" loops when STT revises punctuation/partials.
   */
  #isDuplicateSpeech(sourceText) {
    const norm = this.#normalizeSpoken(sourceText);
    if (!norm || norm.length < 2) return true;
    const hash = this.#hashText(norm);
    if (this.seenHashes.has(hash)) return true;

    const words = this.#wordSet(norm);
    if (words.size === 0) return true;
    const now = Date.now();
    // Drop stale window (>45s)
    this._recentSpoken = (this._recentSpoken || []).filter(
      (x) => now - x.at < 45000,
    );

    for (const prev of this._recentSpoken) {
      if (prev.norm === norm) return true;
      // Containment: new is almost subset of recent (or vice versa)
      if (
        prev.norm.length >= 8 &&
        norm.length >= 8 &&
        (prev.norm.includes(norm) || norm.includes(prev.norm))
      ) {
        // Only treat as dup if lengths are close (avoid "yes" inside long line)
        const ratio =
          Math.min(prev.norm.length, norm.length) /
          Math.max(prev.norm.length, norm.length);
        if (ratio >= 0.72) return true;
      }
      if (!prev.words?.size || words.size === 0) continue;
      let inter = 0;
      for (const w of words) if (prev.words.has(w)) inter += 1;
      const union = prev.words.size + words.size - inter;
      const jaccard = union > 0 ? inter / union : 0;
      if (jaccard >= 0.82 && inter >= 3) return true;
      // Short phrases: 2+ shared content words and similar length
      if (
        words.size <= 6 &&
        prev.words.size <= 6 &&
        inter >= 2 &&
        jaccard >= 0.7
      ) {
        return true;
      }
    }
    return false;
  }

  #spokenNormKey(sourceText) {
    return this.#normalizeSpoken(sourceText);
  }

  #isInflightSpoken(sourceText) {
    const k = this.#spokenNormKey(sourceText);
    return !!(k && this._inflightSpoken?.has(k));
  }

  #markInflightSpoken(sourceText) {
    const k = this.#spokenNormKey(sourceText);
    if (!k) return;
    if (!this._inflightSpoken) this._inflightSpoken = new Set();
    this._inflightSpoken.add(k);
  }

  #clearInflightSpoken(sourceText) {
    const k = this.#spokenNormKey(sourceText);
    if (k) this._inflightSpoken?.delete(k);
  }

  #unlockTtsAudio() {
    try {
      if (!this._audioEl) {
        this._audioEl = new Audio();
        this._audioEl.preload = 'auto';
      }
      if (!this._audioElB) {
        this._audioElB = new Audio();
        this._audioElB.preload = 'auto';
      }
      const silent =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
      for (const el of [this._audioEl, this._audioElB]) {
        el.src = silent;
        el.volume = 0.01;
        el.play()
          .then(() => {
            try {
              el.pause();
              el.removeAttribute('src');
              el.load?.();
            } catch {
              /* ignore */
            }
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  #rememberSpoken(sourceText) {
    const norm = this.#normalizeSpoken(sourceText);
    if (!norm) return;
    const hash = this.#hashText(norm);
    this.seenHashes.add(hash);
    if (this.seenHashes.size > 100) {
      const first = this.seenHashes.values().next().value;
      this.seenHashes.delete(first);
    }
    this._recentSpoken = this._recentSpoken || [];
    this._recentSpoken.push({
      norm,
      words: this.#wordSet(norm),
      at: Date.now(),
    });
    if (this._recentSpoken.length > 24) this._recentSpoken.shift();
  }

  /**
   * Video paused: kill dub queue + both TTS elements and unduck original.
   * Avoids "next fragment plays after pause" and stuck muted original.
   */
  #haltPlaybackForMediaPause() {
    try {
      this.sync?.clear?.();
      this.sync?.interruptPlaying?.();
    } catch {
      /* ignore */
    }
    for (const el of [this._audioEl, this._audioElB]) {
      if (!el) continue;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load?.();
      } catch {
        /* ignore */
      }
    }
    // Restore full user original volume (not duck level)
    try {
      this.capture?.setOriginalVolume?.(this.settings.originalVolume ?? 0.15);
    } catch {
      /* ignore */
    }
  }

  /** Merge short stream frames into ~0.7s buffer for stable F0 / gender lock */
  #pushGenderPcm(float32, sampleRate = 16000) {
    if (!float32?.length) return;
    if (this.settings.autoMatchVoiceGender === false) return;
    this._genderPcmBuf = this._genderPcmBuf || [];
    this._genderPcmSamples = this._genderPcmSamples || 0;
    this._genderPcmBuf.push(float32);
    this._genderPcmSamples += float32.length;
    const need = Math.floor(sampleRate * 0.7);
    if (this._genderPcmSamples < need) return;
    // Concat
    const merged = new Float32Array(this._genderPcmSamples);
    let off = 0;
    for (const c of this._genderPcmBuf) {
      merged.set(c, off);
      off += c.length;
    }
    this._genderPcmBuf = [];
    this._genderPcmSamples = 0;
    this.#observeSpeakerGender(merged, sampleRate);
  }

  #teardownStream() {
    try {
      this._stream?.disconnect?.();
    } catch {
      /* ignore */
    }
    this._stream = null;
    this._streamMode = false;
    this._utt = this.#freshUtt();
  }

  #clearNoSpeechWatch() {
    if (this._noSpeechTimer) {
      clearInterval(this._noSpeechTimer);
      this._noSpeechTimer = null;
    }
  }

  /**
   * If capture is alive and video plays but STT never yields text,
   * stream-only mode used to sit forever with zero UI (classic "похуй").
   * After ~6s stream empty → REST hybrid; ~12s still empty → hard error + recover.
   */
  #armNoSpeechWatch() {
    this.#clearNoSpeechWatch();
    this._lastSttTextAt = 0;
    this._noSpeechWarned = false;
    this._streamEmptyFallbackAt = 0;
    const startedAt = Date.now();
    this._noSpeechTimer = setInterval(() => {
      if (!this.running) {
        this.#clearNoSpeechWatch();
        return;
      }
      if (!this.#isMediaPlaying()) return;
      // Successful phrase already happened
      if (this._lastSttTextAt > 0) {
        this._noSpeechWarned = false;
        return;
      }
      const idleMs = Date.now() - startedAt;

      // Stream path: fail over to REST chunks sooner (native SW stream still
      // counts as streamMode; empty for 6s usually means silent tap / auth).
      if (this._streamMode && idleMs >= 6000 && !this._streamEmptyFallbackAt) {
        this._streamEmptyFallbackAt = Date.now();
        log.warn('No STT text while streaming — forcing REST fallback', {
          idleMs,
        });
        this.#fallbackFromStream(
          `no STT text for ${Math.round(idleMs / 1000)}s (empty stream)`,
        );
        // Keep hybrid REST chunks; do not set streamOnly
        this.capture?.setStreamOnly?.(false);
        this.onEvent({
          type: 'warn',
          message:
            'Streaming STT без текста ~6с — REST чанки. Проверь звук ролика / VPN / ключ xAI.',
        });
        return;
      }

      if (!this._noSpeechWarned && idleMs >= 12000) {
        this._noSpeechWarned = true;
        const captureOk = !!this.capture?.running;
        const peak =
          typeof this.capture?.peakRms === 'number'
            ? this.capture.peakRms
            : null;
        const silentGraph = peak != null && peak < 0.0008;
        this.onEvent({
          type: 'error',
          message: silentGraph
            ? 'Захват тихий (RMS≈0): сайт/DRM/CORS скорее всего отдаёт пустой Web Audio. Live на этом плеере не сработает — попробуй YouTube VOD или другой источник.'
            : captureOk
              ? 'Речь не распознаётся: видео играет, захват жив, но STT пустой. Проверь ключ xAI / VPN / громкость оригинала, или обнови страницу. Для обычных видео поставь режим VOD / Авто.'
              : 'Захват аудио мёртв — нажми «Перевод» ещё раз. Если YouTube/DRM, попробуй другой ролик.',
        });
        this.#setStatus('degraded');
        // YouTube finite VOD stuck on Live → ask content to restart as VOD prepare
        const host = String(this.context?.siteHost || '').toLowerCase();
        const dur = Number(this.video?.duration);
        const finiteVod =
          Number.isFinite(dur) && dur > 30 && dur !== Infinity;
        if (
          captureOk &&
          !silentGraph &&
          isYoutubeHost(host) &&
          (finiteVod || !this.context?.isLive)
        ) {
          this.onEvent({
            type: 'prefer_vod',
            reason: 'empty-stt-on-yt-vod',
          });
        }
        // One recover attempt for dead capture
        if (!captureOk) this.#autoRecover('no-speech-capture-dead');
        else if (this._streamMode) {
          // Last resort: abandon stream entirely and stay on REST
          this.#fallbackFromStream('no STT after 12s');
        }
      }
    }, 2000);
  }

  #noteSttText(source = '') {
    if (!String(source || '').trim()) return;
    this._lastSttTextAt = Date.now();
    this._emptySttStreak = 0;
    this._noSpeechWarned = false;
  }

  /**
   * Open streaming STT with one cold-start retry.
   * SW path is native-first (~instant) or WS under ~5.5s + native; content
   * openStt budget is 12s — two long 16s waits used to burn ~32s before REST.
   */
  async #startStreamingWithRetry() {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.#startStreaming();
        return;
      } catch (e) {
        lastErr = e;
        const m = String(e?.message || e);
        if (/superseded/i.test(m)) return;
        log.warn('Streaming STT open attempt failed', attempt + 1, m);
        if (attempt === 0 && this.running) {
          // Brief pause then retry once (cold SW / port race)
          await new Promise((r) => setTimeout(r, 200));
          if (!this.running) throw lastErr;
          continue;
        }
      }
    }
    throw lastErr || new Error('Streaming STT open failed');
  }

  async #startStreaming() {
    // Reuse bridge if still connected (retry path)
    if (!this._stream) {
      const bridge = new StreamBridge({
        onSttPartial: (ev) => this.#onSttPartial(ev),
        onSttReady: () => {
          this._streamMode = true;
          // Keep hybrid until first real transcript (#onSttPartial flips streamOnly)
          this.capture?.setStreamOnly?.(false);
          this.health?.markProgress('stt');
        },
        onSttError: (err, fatal) => {
          log.warn('stream STT', err, { fatal });
          this.onEvent({ type: 'warn', message: `STT stream: ${err}` });
          const errStr = String(err || '');
          // "STT open superseded" is a race, not a real failure
          if (/superseded/i.test(errStr)) return;
          // Open failures are handled by openStt() rejection + #startStreamingWithRetry.
          // Mid-session fatal still falls back once.
          if (fatal && this._streamMode) {
            this.#fallbackFromStream(err);
            return;
          }
          // Soft server errors (ASR stream timed out) → socket will close;
          // soft-reopen is driven by onSttClosed. Do not fall back here.
        },
        onSttClosed: () => {
          if (this.running && this._streamMode) {
            // Unexpected close (incl. after ASR timeout) — re-open once, else REST
            this.#reopenStreamSoft().catch((e) => {
              const m = String(e?.message || e);
              if (/superseded/i.test(m)) return;
              this.#fallbackFromStream(m);
            });
          }
        },
      });
      this._stream = bridge;
    }
    const qProfile = this.#effectiveQualityProfile();
    const keyterms = [
      ...(this.settings.keyterms || []),
      ...this.#contextKeyterms(),
    ].slice(0, qProfile === 'fast' ? 16 : 40);
    await this._stream.openStt({
      sample_rate: 16000,
      encoding: 'pcm',
      interim_results: true,
      endpointing: AUDIO.streamEndpointingMs ?? 220,
      language: sttLanguageParam(this.settings.sourceLang) || undefined,
      keyterms,
      smart_turn: AUDIO.streamSmartTurn ?? 0.55,
      smart_turn_timeout: AUDIO.streamSmartTurnTimeoutMs ?? 1100,
      vad_threshold: 0.08,
    });
    this._streamMode = true;
    // Hybrid: keep REST chunks as safety net until first stream transcript.
    // Full streamOnly engages only after we actually hear STT text (see #noteSttText path).
    this.capture?.setStreamOnly?.(false);
    this._streamFailCount = 0;
    log.info('Streaming STT ready (hybrid until first transcript)');
  }

  async #reopenStreamSoft() {
    // Coalesce concurrent reopen (timeout error + close both fire)
    if (this._streamReopenPromise) return this._streamReopenPromise;
    // Debounce thrash: max ~1 reopen / 1.5s
    const now = Date.now();
    if (now - (this._streamReopenAt || 0) < 1500 && this._stream?.sttReady) {
      return;
    }
    this._streamReopenAt = now;

    this._streamReopenPromise = this.#doReopenStreamSoft().finally(() => {
      this._streamReopenPromise = null;
    });
    return this._streamReopenPromise;
  }

  async #doReopenStreamSoft() {
    if (!this.running || !this.#wantStreaming()) {
      this.#fallbackFromStream('stream closed');
      return;
    }
    if (!this._stream) {
      this.#fallbackFromStream('stream bridge missing');
      return;
    }
    try {
      this._stream.closeStt?.();
      // Brief yield so background can tear down the previous WS cleanly
      await new Promise((r) => setTimeout(r, 80));
      if (!this.running || !this.#wantStreaming()) return;
      const qProfile = this.#effectiveQualityProfile();
      await this._stream.openStt({
        sample_rate: 16000,
        encoding: 'pcm',
        interim_results: true,
        endpointing: AUDIO.streamEndpointingMs ?? 280,
        language: sttLanguageParam(this.settings.sourceLang) || undefined,
        keyterms: [
          ...(this.settings.keyterms || []),
          ...this.#contextKeyterms(),
        ].slice(0, qProfile === 'fast' ? 16 : 40),
        smart_turn: AUDIO.streamSmartTurn ?? 0.62,
        smart_turn_timeout: AUDIO.streamSmartTurnTimeoutMs ?? 1300,
        vad_threshold: 0.08,
      });
      this._streamMode = true;
      // Hybrid until first transcript (same as #startStreaming)
      this.capture?.setStreamOnly?.(false);
      log.info('Streaming STT soft-reopened');
    } catch (e) {
      const m = String(e?.message || e);
      if (/superseded/i.test(m)) {
        log.debug('STT soft-reopen superseded (another open won)');
        return;
      }
      this.#fallbackFromStream(m);
    }
  }

  #fallbackFromStream(reason) {
    const reasonStr = String(reason || 'error');
    // Never treat open-race as a hard stream failure
    if (/superseded/i.test(reasonStr)) {
      log.debug('Ignoring superseded STT open (not a fallback)', reasonStr);
      return;
    }
    // Debounce: open rejection + mid-session error can race within the same ms
    const now = Date.now();
    if (now - (this._lastFallbackAt || 0) < 800) {
      log.debug('Ignoring duplicate stream fallback', reasonStr);
      return;
    }
    this._lastFallbackAt = now;

    this._streamFailCount += 1;
    this._streamMode = false;
    this.capture?.setStreamOnly?.(false);
    this._utt = this.#freshUtt();
    // Drop in-flight stream clauses so REST path isn't starved by stuck counters
    this._streamBusy = 0;
    try {
      this._stream?.disconnect?.();
    } catch {
      /* ignore */
    }
    this._stream = null;
    // Prefer latest speech only (maxBusy=1) WITHOUT poisoning latency EMA.
    // Seeding lagShed made UI show "profile fast / lag-shed ON" forever and
    // forced ultra-compact MT even when user chose max and APIs were fine.
    this._restLatestOnly = true;
    this._pendingChunk = null;
    this.busyChunks = 0;
    this.health?.setInflight?.(false);
    // Do NOT markProgress('fallback') — that clears a real degraded state and
    // pretends the pipeline is healthy while REST is still catching up.
    this.health?.markCapture?.();
    this.#retuneCaptureForLatency();
    log.warn('Fallback to REST chunks', reasonStr, {
      fails: this._streamFailCount,
    });
    const authFail =
      /auth|credential|no valid|xai-client-secret|401|403/i.test(reasonStr);
    const netHint = authFail
      ? ' WS auth: Chrome не даёт Authorization на WebSocket (DNR на WS не работает). Нужен mint client_secret (protocol) или CF/local relay (tools/xai-relay-*.js).'
      : /WebSocket|WS closed|1006|relay|network|proxy|ready timeout/i.test(reasonStr)
        ? ' Проверь VPN/relay (Network) — streaming даёт 1.5–3s; REST чанки медленнее.'
        : '';
    this.onEvent({
      type: 'warn',
      message: `Streaming → REST fallback (${reasonStr}).${netHint}`,
    });
  }

  #onStreamPcm(pcm16, meta) {
    if (!this.running || !this._streamMode) return;
    if (!this.#isMediaPlaying()) return;
    // Track media time for cue anchors
    if (meta?.mediaTime != null) {
      if (!this._utt.active) {
        this._utt.mediaStart = meta.start ?? meta.mediaTime;
      }
      this._utt.mediaEnd = meta.end ?? meta.mediaTime;
    }
    // Accumulate ~0.7s PCM for F0 (random 100ms frames alone mis-classify gender).
    // Before lock: every frame into buffer. After lock: ~15% for rare re-check.
    if (pcm16 && this.settings.autoMatchVoiceGender !== false) {
      const sample = !this._voiceLocked || Math.random() < 0.15;
      if (sample) {
        try {
          const f32 = pcm16ToFloat32(pcm16);
          if (f32.length >= 160) {
            this.#pushGenderPcm(f32, meta?.sampleRate || 16000);
          }
        } catch (e) {
          log.debug('stream gender observe', e?.message || e);
        }
      }
    }
    this.health?.markCapture();
    this._stream?.sendPcm?.(pcm16, {
      mediaTime: meta?.mediaTime,
      duration: meta?.duration,
    });
  }

  /**
   * STT WS partial / final events → peel clauses → MT → TTS ASAP.
   */
  #onSttPartial(ev) {
    if (!this.running || !this._streamMode) return;
    if (!this.#isMediaPlaying()) return;

    const text = String(ev?.text || '').trim();
    if (!text) return;

    this.#noteSttText(text);
    // First real transcript → prefer stream-only (avoid double STT billing)
    if (this._streamMode && this.capture && !this.capture.streamOnly) {
      this.capture.setStreamOnly?.(true);
      log.info('First stream STT text — streamOnly ON');
    }

    const speechFinal = !!ev.speech_final;
    const isFinal = !!ev.is_final;

    if (!this._utt.active) {
      this._utt.active = true;
      this._utt.t0 = performance.now();
      this._utt.consumed = 0;
      this._utt.mediaStart = this.video?.currentTime || 0;
    }
    this._utt.text = text;
    this._utt.mediaEnd = this.video?.currentTime || this._utt.mediaEnd;

    this.health?.markProgress('stt');
    this.onSubtitles({
      phase: 'source',
      sourceText: text,
      start: this._utt.mediaStart,
      end: this._utt.mediaEnd || this._utt.mediaStart + 1,
      interim: !speechFinal && !isFinal,
    });

    const partialMt = this.settings.partialClauseMt !== false;
    if (partialMt && !speechFinal) {
      // First audio: peel sooner (shorter min + aggressive word-window)
      const firstAudio = !this._firstAudioLogged;
      const peeled = peelReadyClauses(text, this._utt.consumed, {
        minClauseChars: firstAudio
          ? Math.min(8, AUDIO.streamMinClauseChars ?? 12)
          : AUDIO.streamMinClauseChars ?? 12,
        forceAll: false,
        // Snappier provisional peel before first TTS
        minWordsForce: firstAudio ? 4 : 5,
        softWindowChars: firstAudio ? 48 : 72,
        softWindowWords: firstAudio ? 7 : 12,
      });
      if (peeled.clauses.length) {
        this._utt.consumed = peeled.consumedChars;
        for (const clause of peeled.clauses) {
          this.#enqueueClause(clause, {
            speechFinal: false,
            t0: this._utt.t0,
          });
        }
      }
    }

    // Only end-of-utterance (speech_final) flushes the tail — chunk-final
    // (is_final without speech_final) keeps the rolling STT buffer open.
    if (speechFinal) {
      const peeled = peelReadyClauses(text, this._utt.consumed, {
        forceAll: true,
      });
      this._utt.consumed = peeled.consumedChars;
      for (const clause of peeled.clauses) {
        this.#enqueueClause(clause, {
          speechFinal: true,
          t0: this._utt.t0,
        });
      }
      // Reset utterance shell for next turn (STT session stays open)
      this._utt = this.#freshUtt();
    }
  }

  /**
   * Fire-and-forget clause pipeline (MT → TTS → sync).
   * Caps concurrency so we don't explode under lag.
   */
  #enqueueClause(sourceText, { speechFinal = false, t0 = 0 } = {}) {
    const src = String(sourceText || '').trim();
    if (!src || src.length < 2) return;
    // Don't start new dub work while video is paused
    if (!this.#isMediaPlaying()) return;

    // Fuzzy + normalized dedup (stops repeating the same words on STT revisions)
    const maxBusy = Math.max(2, this.#maxBusy() + 1);
    const gate = clauseShouldDispatch({
      duplicate: this.#isDuplicateSpeech(src),
      inflight: this.#isInflightSpoken(src),
      busy: this._streamBusy,
      maxBusy,
    });
    if (!gate.dispatch) {
      log.debug('clause skip', gate.reason, src.slice(0, 48));
      return;
    }
    this.#markInflightSpoken(src);

    const epoch = this._epoch;
    const started = t0 || performance.now();
    this._streamBusy += 1;
    this.busyChunks += 1;
    this.health?.setInflight(true);

    this.#runClausePipeline(src, {
      epoch,
      started,
      speechFinal,
      mediaStart: this._utt.mediaStart || this.video?.currentTime || 0,
      mediaEnd: this._utt.mediaEnd || this.video?.currentTime || 0,
    })
      .catch((e) => {
        log.warn('clause pipeline', e?.message || e);
        this.health?.markFailure('mt', e);
      })
      .finally(() => {
        this.#clearInflightSpoken(src);
        // Old generation must not steal slots from the new one after seek/recover
        // zeroed counters (B85).
        if (epoch === this._epoch) {
          this._streamBusy = Math.max(0, this._streamBusy - 1);
          this.busyChunks = Math.max(0, this.busyChunks - 1);
          this.health?.setInflight(this.busyChunks > 0 || this._streamBusy > 0);
        }
      });
  }

  async #runClausePipeline(sourceText, ctx) {
    const { epoch, started } = ctx;
    if (epoch !== this._epoch || !this.running) return;

    if (
      this.settings.skipIfSourceIsTarget &&
      this.settings.sourceLang !== 'auto' &&
      this.settings.sourceLang === this.settings.targetLang
    ) {
      return;
    }

    // Live quality: keep user profile for prompt richness, force compact only under lag.
    // Model is always live-fast tier (see resolveTranslateModel) — max ≠ 13s flagship.
    let qProfile = this.#effectiveQualityProfile();
    if (this.#isLagShed() || sourceText.length < 64) {
      qProfile = 'fast';
    } else if (this._latencyEmaMs > (AUDIO.lagBoostLatencyMs || 2800) && qProfile === 'max') {
      qProfile = 'balanced';
    }
    const userProfile = this.#userQualityProfile();

    const apiTimeout = sttApiTimeoutMs(this.settings?.providerMode, {
      hardLag: this.#isHardLag(),
      lagShed: this.#isLagShed(),
    });

    // Live hot path: always standard text MT (glyph vision RTT kills first-audio)
    const economy = 'standard';
    // Cap history under lag / short clauses — fewer tokens → lower MT RTT
    const hist =
      qProfile === 'fast' || sourceText.length < 80
        ? this.history.slice(-1)
        : this.history.slice(-3);

    const tMt0 = performance.now();
    const mtRes = await sendMessage(
      {
        type: MSG.XAI_TRANSLATE,
        payload: {
          text: sourceText,
          sourceLang: this.settings.sourceLang,
          targetLang: this.settings.targetLang,
          context: this.context,
          glossary: this.settings.glossary,
          exceptions: this.settings.exceptions,
          history: hist,
          qualityProfile: qProfile,
          allowCache: true,
          liveLatency: true,
          tokenEconomyMode: economy,
        },
      },
      { timeoutMs: apiTimeout },
    );
    const tMt = Math.round(performance.now() - tMt0);
    if (epoch !== this._epoch || !this.running) return;

    if (!mtRes?.ok) {
      this.health?.markFailure('mt', mtRes?.error);
      this.onEvent({
        type: 'warn',
        message: `Перевод (stream): ${mtRes?.error || 'ошибка'}`,
      });
      if (mtRes?.timeout) this.#autoRecover('mt timeout');
      return;
    }

    const translated = String(mtRes.text || '').trim();
    if (!translated) {
      this.health?.markProgress('mt');
      return;
    }

    this.health?.markProgress('mt');
    this.history.push({ source: sourceText, target: translated });
    if (this.history.length > (this.settings.maxHistoryPhrases || 5)) {
      this.history.shift();
    }

    const cue = {
      id: `c${++phraseSeq}`,
      sourceText,
      text: translated,
      start: ctx.mediaStart,
      end: Math.max(ctx.mediaEnd, ctx.mediaStart + 0.4),
      learningRevision: this._learningRevision,
      stream: true,
    };
    this.subtitleCues.push(cue);
    if (this.subtitleCues.length > 200) this.subtitleCues.shift();
    this.onSubtitles({ phase: 'translated', ...cue });

    const voiceId = this.#resolveSessionVoiceId();
    const ttsSpeed = this.#effectiveTtsSpeed();
    const useStreamTts =
      this.settings.streamingTts !== false &&
      this._stream?.connected &&
      !this._stream?.ttsAuthBroken;

    // Partial sentence TTS still helps for long single clauses
    const usePartial =
      this.settings.partialSentenceTts !== false &&
      !this.#isHardLag() &&
      translated.length >= 48;
    const units = usePartial
      ? splitIntoSpeakableUnits(translated)
      : [translated];
    const speakUnits = units.length ? units : [translated];
    const firstUnit = speakUnits[0];

    const tTts0 = performance.now();
    let ttsRes;
    let firstByteMs = null;

    if (useStreamTts) {
      try {
        ttsRes = await this._stream.speakTts({
          text: firstUnit,
          voice_id: voiceId,
          language: ttsLanguageCode(this.settings.targetLang),
          speed: ttsSpeed,
          optimize_streaming_latency: 1,
          timeoutMs: apiTimeout,
          onFirstByte: (info) => {
            firstByteMs = info?.latencyMs ?? null;
          },
        });
        ttsRes = {
          ok: true,
          audioBuffer: ttsRes.audioBuffer,
          contentType: ttsRes.contentType,
          voice_id: ttsRes.voice_id || voiceId,
          firstByteMs: ttsRes.firstByteMs ?? firstByteMs,
        };
      } catch (e) {
        if (e?.authBroken || this._stream?.ttsAuthBroken) {
          // One-time note: avoid per-phrase spam after circuit opens
          if (!this._ttsWsAuthNoted) {
            this._ttsWsAuthNoted = true;
            log.warn(
              'stream TTS auth broken — REST for this session',
              e?.message || e,
            );
            this.onEvent({
              type: 'warn',
              message:
                'TTS WebSocket auth недоступен (Chrome). REST TTS; для streaming задай CF-relay (tools/xai-relay-worker.js).',
            });
          }
        } else {
          log.warn('stream TTS failed, REST', e?.message || e);
        }
        ttsRes = null;
      }
    }

    if (!ttsRes?.ok) {
      // REST TTS fallback
      const rest = await sendMessage(
        {
          type: MSG.XAI_TTS,
          payload: {
            text: firstUnit,
            voice_id: voiceId,
            speaker_gender: this._sessionSpeakerGender || undefined,
            speaker_voice_type: this._sessionVoiceType || undefined,
            language: ttsLanguageCode(this.settings.targetLang),
            speed: ttsSpeed,
            expressiveSpeech:
              this.settings.expressiveSpeech !== false && !this.#isHardLag(),
            optimize_streaming_latency: 1,
          },
        },
        { timeoutMs: apiTimeout },
      );
      if (!rest?.ok) {
        this.health?.markFailure('tts', rest?.error);
        this.onEvent({
          type: 'warn',
          message: `TTS (stream): ${rest?.error || 'ошибка'}`,
        });
        if (rest?.timeout) this.#autoRecover('tts timeout');
        return;
      }
      ttsRes = {
        ok: true,
        audioBuffer: base64ToArrayBuffer(rest.audioBase64),
        contentType: rest.contentType || 'audio/mpeg',
        voice_id: rest.voice_id || voiceId,
      };
    }

    const tTts = Math.round(performance.now() - tTts0);
    if (epoch !== this._epoch || !this.running) return;
    // Drop finished TTS if user paused while we were translating
    if (!this.#isMediaPlaying()) return;

    this.health?.markProgress('tts');
    const audioBuffer =
      ttsRes.audioBuffer ||
      (ttsRes.audioBase64
        ? base64ToArrayBuffer(ttsRes.audioBase64)
        : null);
    if (!audioBuffer) return;
    this.#rememberSpoken(sourceText);

    this.sync.enqueue({
      ...cue,
      id: speakUnits.length > 1 ? `${cue.id}u0` : cue.id,
      text: firstUnit,
      audioBuffer,
      contentType: ttsRes.contentType || 'audio/mpeg',
      voice_id: ttsRes.voice_id || voiceId,
      playbackRate: 1,
    });

    // Tail units fire-and-forget (REST/stream)
    if (speakUnits.length > 1 && epoch === this._epoch) {
      const tail = speakUnits.slice(1);
      const voice = ttsRes.voice_id || voiceId;
      (async () => {
        for (let i = 0; i < tail.length; i++) {
          if (epoch !== this._epoch || !this.running) return;
          try {
            let r = null;
            if (
              useStreamTts &&
              this._stream?.connected &&
              !this._stream?.ttsAuthBroken
            ) {
              try {
                r = await this._stream.speakTts({
                  text: tail[i],
                  voice_id: voice,
                  language: ttsLanguageCode(this.settings.targetLang),
                  speed: ttsSpeed,
                  optimize_streaming_latency: 1,
                });
              } catch {
                r = null;
              }
            }
            if (!r?.audioBuffer) {
              const rest = await sendMessage(
                {
                  type: MSG.XAI_TTS,
                  payload: {
                    text: tail[i],
                    voice_id: voice,
                    language: ttsLanguageCode(this.settings.targetLang),
                    speed: ttsSpeed,
                    optimize_streaming_latency: 1,
                  },
                },
                { timeoutMs: apiTimeout },
              );
              if (!rest?.ok) return;
              r = {
                audioBuffer: base64ToArrayBuffer(rest.audioBase64),
                contentType: rest.contentType || 'audio/mpeg',
                voice_id: rest.voice_id || voice,
              };
            }
            this.sync?.enqueue({
              ...cue,
              id: `${cue.id}u${i + 1}`,
              text: tail[i],
              audioBuffer: r.audioBuffer,
              contentType: r.contentType || 'audio/mpeg',
              voice_id: r.voice_id || voice,
              playbackRate: 1,
            });
          } catch (e) {
            log.debug('stream partial tail', e?.message || e);
            return;
          }
        }
      })().catch(() => {});
    }

    this._recoverAttempts = 0;
    const ms = Math.round(performance.now() - started);
    const alpha = ms < (this._latencyEmaMs || 0) * 0.7 ? 0.45 : 0.35;
    this._latencyEmaMs = this._latencyEmaMs
      ? this._latencyEmaMs * (1 - alpha) + ms * alpha
      : ms;
    this.#retuneCaptureForLatency();

    if (!this._firstAudioLogged) {
      this._firstAudioLogged = true;
      log.info('First-audio (stream clause)', {
        e2eMs: ms,
        mt: tMt,
        tts: tTts,
        ttsFirstByte: ttsRes.firstByteMs,
      });
    }

    // Clear REST "latest-only" after a healthy phrase
    if (ms < (AUDIO.lagBoostLatencyMs || 2800)) this._restLatestOnly = false;

    this.onEvent({
      type: 'phrase',
      latencyMs: ms,
      stages: {
        stt: null,
        mt: tMt,
        tts: tTts,
        ttsFirstByte: ttsRes.firstByteMs ?? null,
        cached: !!mtRes.cached,
        partialUnits: speakUnits.length,
        stream: true,
        clause: true,
      },
      qualityProfile: qProfile,
      userQualityProfile: userProfile,
      lagShed: this.#isLagShed(),
      sourceText,
      text: translated,
      voice_id: ttsRes.voice_id || voiceId,
      speakerGender: this._sessionSpeakerGender,
      speakerVoiceType: this._sessionVoiceType,
      ttsSpeed,
      model: mtRes.model,
      economyMode: mtRes.economyMode || (mtRes.cached ? 'cache' : 'standard'),
      firstAudioTarget: '1.5-3s',
    });
  }

  async #onAudioChunk(float32, meta) {
    if (!this.running) return;
    // Streaming owns STT only after first transcript (streamOnly=true).
    // Hybrid window: stream is open but REST still allowed until we hear text.
    if (this._streamMode && this.capture?.streamOnly) return;
    // Skip while media is paused — keep capture warm without burning API
    if (!this.#isMediaPlaying()) return;

    const maxBusy = this.#maxBusy();
    // Backpressure: don't burn API on a long backlog — keep *latest* speech only
    if (this.busyChunks >= maxBusy) {
      this._pendingChunk = { float32, meta };
      log.debug('backpressure hold latest chunk', this.busyChunks, {
        lagShed: this.#isLagShed(),
        ema: Math.round(this._latencyEmaMs),
      });
      return;
    }

    const epoch = this._epoch;
    this.busyChunks += 1;
    this.health?.setInflight(true);
    const t0 = performance.now();
    let tStt = 0;
    let tMt = 0;
    let tTts = 0;
    let fromCache = false;
    // Shorter timeout when already lagging so slots free faster
    const apiTimeout = sttApiTimeoutMs(this.settings?.providerMode, {
      hardLag: this.#isHardLag(),
      lagShed: this.#isLagShed(),
    });
    const qProfile = this.#effectiveQualityProfile();
    let restSpoken = '';

    try {
      // Detect original speaker gender from PCM (before STT) for TTS voice match
      this.#observeSpeakerGender(float32, meta.sampleRate || 16000);

      const wav = pcm16ToWavBlob(meta.pcm16, meta.sampleRate);
      const tStt0 = performance.now();
      const sttRes = await sendMessage(
        {
          type: MSG.XAI_STT,
          payload: {
            wavBase64: arrayBufferToBase64(await wav.arrayBuffer()),
            language: sttLanguageParam(this.settings.sourceLang),
            keyterms: [
              ...(this.settings.keyterms || []),
              ...this.#contextKeyterms(),
            ].slice(0, qProfile === 'fast' ? 16 : 40),
            format: true,
          },
        },
        { timeoutMs: apiTimeout },
      );
      tStt = Math.round(performance.now() - tStt0);

      if (epoch !== this._epoch || !this.running) return;

      if (!sttRes?.ok) {
        this.health?.markFailure('stt', sttRes?.error);
        this.onEvent({
          type: 'warn',
          message: `STT: ${sttRes?.error || 'ошибка'}`,
        });
        // Timeouts / SW death: force recover instead of silent busy-loop
        if (sttRes?.timeout) this.#autoRecover('stt timeout');
        return;
      }

      const sourceText = String(sttRes.text || '').trim();
      if (!sourceText || sourceText.length < 2) {
        this.health?.markProgress('stt');
        this._emptySttStreak = (this._emptySttStreak || 0) + 1;
        // Visible every ~6 empty chunks so user isn't stuck with zero feedback
        if (this._emptySttStreak === 3 || this._emptySttStreak === 8) {
          let rms = 0;
          try {
            rms = float32?.length ? rmsLevel(float32) : 0;
          } catch {
            rms = 0;
          }
          const playing = this.#isMediaPlaying();
          const vol =
            typeof this.video?.volume === 'number' ? this.video.volume : null;
          const muted = !!this.video?.muted;
          const hint =
            !playing
              ? 'Видео на паузе — нажми Play.'
              : muted || (vol != null && vol < 0.05)
                ? 'Оригинал muted/тише 5% — STT всё равно слышит WebAudio, но проверь дорожку.'
                : rms < 0.008
                  ? `Захват почти тихий (rms=${rms.toFixed(4)}) — DRM/тихий оригинал/нет речи?`
                  : `Аудио есть (rms=${rms.toFixed(4)}), но STT не распознал речь — язык sourceLang / музыка / шум?`;
          this.onEvent({
            type: 'warn',
            message: `STT пустой ×${this._emptySttStreak}. ${hint}`,
          });
        }
        return;
      }
      this.#noteSttText(sourceText);

      if (this.#isDuplicateSpeech(sourceText) || this.#isInflightSpoken(sourceText)) {
        this.health?.markProgress('stt');
        log.debug('REST chunk dedup skip', sourceText.slice(0, 48));
        return;
      }
      restSpoken = sourceText;
      this.#markInflightSpoken(sourceText);

      this.health?.markProgress('stt');
      this.onSubtitles({
        phase: 'source',
        sourceText,
        start: meta.start,
        end: meta.end,
      });

      // Fresher speech waiting + already late → free the slot (don't dub the past)
      if (this.#shouldAbortForFresher('after-stt')) {
        this.onEvent({
          type: 'phrase_dropped',
          reason: 'superseded-after-stt',
          text: sourceText,
          latencyMs: Math.round(performance.now() - t0),
          stages: { stt: tStt },
        });
        return;
      }

      if (
        this.settings.skipIfSourceIsTarget &&
        this.settings.sourceLang !== 'auto' &&
        this.settings.sourceLang === this.settings.targetLang
      ) {
        return;
      }

      // REST hot path: always liveLatency + standard text (no glyph vision RTT)
      const economy = 'standard';
      const userProfile = this.#userQualityProfile();
      const hist =
        qProfile === 'fast' || sourceText.length < 100
          ? this.history.slice(-1)
          : this.history.slice(-3);

      const tMt0 = performance.now();
      const mtRes = await sendMessage(
        {
          type: MSG.XAI_TRANSLATE,
          payload: {
            text: sourceText,
            sourceLang: this.settings.sourceLang,
            targetLang: this.settings.targetLang,
            context: this.context,
            glossary: this.settings.glossary,
            exceptions: this.settings.exceptions,
            history: hist,
            qualityProfile: qProfile,
            allowCache: true,
            liveLatency: true,
            tokenEconomyMode: economy,
          },
        },
        { timeoutMs: apiTimeout },
      );
      tMt = Math.round(performance.now() - tMt0);
      fromCache = !!mtRes?.cached;
      const economyMode = mtRes?.economyMode || (fromCache ? 'cache' : 'standard');
      const economyFallback = !!mtRes?.economyFallback;

      if (epoch !== this._epoch || !this.running) return;

      if (!mtRes?.ok) {
        this.health?.markFailure('mt', mtRes?.error);
        this.onEvent({
          type: 'warn',
          message: `Перевод: ${mtRes?.error || 'ошибка'}`,
        });
        if (mtRes?.timeout) this.#autoRecover('mt timeout');
        return;
      }

      let translated = String(mtRes.text || '').trim();
      if (!translated) {
        this.health?.markProgress('mt');
        return;
      }

      if (mtRes.learningRevision != null) {
        this._learningRevision = mtRes.learningRevision;
      }

      this.health?.markProgress('mt');

      if (this.#shouldAbortForFresher('after-mt')) {
        // Keep history for consistency even if we skip TTS for this line
        this.history.push({ source: sourceText, target: translated });
        if (this.history.length > (this.settings.maxHistoryPhrases || 5)) {
          this.history.shift();
        }
        this.onSubtitles({
          phase: 'translated',
          id: `c${++phraseSeq}`,
          sourceText,
          text: translated,
          start: meta.start,
          end: meta.end,
          learningRevision: this._learningRevision,
        });
        this.onEvent({
          type: 'phrase_dropped',
          reason: 'superseded-after-mt',
          text: translated,
          latencyMs: Math.round(performance.now() - t0),
          stages: { stt: tStt, mt: tMt, cached: fromCache },
        });
        return;
      }

      // History for next phrases (use MT text immediately — learning is async)
      this.history.push({ source: sourceText, target: translated });
      if (this.history.length > (this.settings.maxHistoryPhrases || 5)) {
        this.history.shift();
      }

      const cue = {
        id: `c${++phraseSeq}`,
        sourceText,
        text: translated,
        start: meta.start,
        end: meta.end,
        learningRevision: this._learningRevision,
      };
      this.subtitleCues.push(cue);
      if (this.subtitleCues.length > 200) this.subtitleCues.shift();
      this.onSubtitles({
        phase: 'translated',
        ...cue,
      });

      // TTS ASAP — never block voice-over on self-learning / deep pass
      // Partial sentence TTS: first unit on critical path (first-audio),
      // remaining units fire-and-forget so busy slot frees for next STT.
      const voiceId = this.#resolveSessionVoiceId();
      const ttsSpeed = this.#effectiveTtsSpeed();
      const usePartial =
        this.settings.partialSentenceTts !== false &&
        !this.#isHardLag() &&
        translated.length >= 48;
      const units = usePartial
        ? splitIntoSpeakableUnits(translated)
        : [translated];
      const speakUnits = units.length ? units : [translated];
      const firstUnit = speakUnits[0];
      const tailUnits = speakUnits.slice(1);

      const ttsPayloadBase = {
        voice_id: voiceId,
        speaker_gender: this._sessionSpeakerGender || undefined,
        speaker_voice_type: this._sessionVoiceType || undefined,
        language: ttsLanguageCode(this.settings.targetLang),
        speed: ttsSpeed,
        expressiveSpeech:
          this.settings.expressiveSpeech !== false && !this.#isHardLag(),
      };

      const tTts0 = performance.now();
      // Prefer stream TTS even on REST STT path (same Port; much lower TTFB than full REST TTS)
      let ttsRes = null;
      const tryStreamTts =
        this.settings.streamingTts !== false &&
        this.settings.streamingPipeline !== false &&
        this._streamFailCount < 3 &&
        !this._stream?.ttsAuthBroken;
      if (tryStreamTts) {
        try {
          if (!this._stream) {
            this._stream = new StreamBridge({});
          }
          if (this._stream.ttsAuthBroken) {
            throw Object.assign(new Error('TTS WS auth broken'), {
              authBroken: true,
            });
          }
          const streamOut = await this._stream.speakTts({
            text: firstUnit,
            voice_id: voiceId,
            language: ttsLanguageCode(this.settings.targetLang),
            speed: ttsSpeed,
            optimize_streaming_latency: 1,
            timeoutMs: Math.min(apiTimeout, 12000),
          });
          ttsRes = {
            ok: true,
            audioBuffer: streamOut.audioBuffer,
            contentType: streamOut.contentType,
            voice_id: streamOut.voice_id || voiceId,
            firstByteMs: streamOut.firstByteMs,
          };
        } catch (e) {
          if (e?.authBroken || this._stream?.ttsAuthBroken) {
            if (!this._ttsWsAuthNoted) {
              this._ttsWsAuthNoted = true;
              log.debug(
                'stream TTS → REST fallback (no relay / WS auth)',
                e?.message || e,
              );
            }
          } else {
            log.debug('REST-path stream TTS failed', e?.message || e);
          }
          ttsRes = null;
        }
      }
      if (!ttsRes?.ok) {
        const rest = await sendMessage(
          {
            type: MSG.XAI_TTS,
            payload: {
              ...ttsPayloadBase,
              text: firstUnit,
              optimize_streaming_latency: 1,
            },
          },
          { timeoutMs: apiTimeout },
        );
        ttsRes = rest;
      }
      tTts = Math.round(performance.now() - tTts0);

      if (epoch !== this._epoch || !this.running) return;
      if (!this.#isMediaPlaying()) return;

      if (!ttsRes?.ok) {
        this.health?.markFailure('tts', ttsRes?.error);
        this.onEvent({
          type: 'warn',
          message: `TTS: ${ttsRes?.error || 'ошибка'}`,
        });
        if (ttsRes?.timeout) this.#autoRecover('tts timeout');
        return;
      }

      this.health?.markProgress('tts');
      const firstVoiceId = ttsRes.voice_id || voiceId;
      const audioBuffer =
        ttsRes.audioBuffer ||
        (ttsRes.audioBase64
          ? base64ToArrayBuffer(ttsRes.audioBase64)
          : null);
      if (!audioBuffer) {
        this.health?.markFailure('tts', 'empty audio');
        return;
      }
      const firstCue =
        speakUnits.length > 1
          ? {
              ...cue,
              id: `${cue.id}u0`,
              text: firstUnit,
              partialIndex: 0,
              partialTotal: speakUnits.length,
            }
          : cue;
      this.#rememberSpoken(sourceText);
      this.sync.enqueue({
        ...firstCue,
        audioBuffer,
        contentType: ttsRes.contentType || 'audio/mpeg',
        voice_id: firstVoiceId,
        playbackRate: 1,
      });

      // Tail sentences: don't hold busyChunks / inflight on them
      if (tailUnits.length && epoch === this._epoch && this.running) {
        const tailEpoch = epoch;
        const tailCue = cue;
        const total = speakUnits.length;
        (async () => {
          for (let ui = 0; ui < tailUnits.length; ui++) {
            if (tailEpoch !== this._epoch || !this.running) return;
            if (this.#shouldAbortForFresher('after-mt')) return;
            try {
              const r = await sendMessage(
                {
                  type: MSG.XAI_TTS,
                  payload: {
                    ...ttsPayloadBase,
                    text: tailUnits[ui],
                    optimize_streaming_latency: 1,
                  },
                },
                { timeoutMs: apiTimeout },
              );
              if (!r?.ok || tailEpoch !== this._epoch || !this.running) return;
              const buf = base64ToArrayBuffer(r.audioBase64);
              this.sync?.enqueue({
                ...tailCue,
                id: `${tailCue.id}u${ui + 1}`,
                text: tailUnits[ui],
                partialIndex: ui + 1,
                partialTotal: total,
                audioBuffer: buf,
                contentType: r.contentType || 'audio/mpeg',
                voice_id: r.voice_id || firstVoiceId,
                playbackRate: 1,
              });
            } catch (e) {
              log.debug('partial TTS tail failed', e?.message || e);
              return;
            }
          }
        })().catch((e) => log.debug('partial TTS tail', e?.message || e));
      }

      // Successful phrase → reset recover backoff
      this._recoverAttempts = 0;

      const ms = Math.round(performance.now() - t0);
      // EMA: weight recent more when recovering from extreme lag so shed exits faster
      const alpha = ms < (this._latencyEmaMs || 0) * 0.7 ? 0.5 : 0.38;
      this._latencyEmaMs = this._latencyEmaMs
        ? this._latencyEmaMs * (1 - alpha) + ms * alpha
        : ms;
      if (ms < (AUDIO.lagBoostLatencyMs || 2800)) this._restLatestOnly = false;
      this.#retuneCaptureForLatency();
      this.onEvent({
        type: 'phrase',
        latencyMs: ms,
        stages: {
          stt: tStt,
          mt: tMt,
          tts: tTts,
          cached: fromCache,
          partialUnits: speakUnits.length,
        },
        qualityProfile: qProfile,
        userQualityProfile: userProfile,
        lagShed: this.#isLagShed(),
        sourceText,
        text: translated,
        voice_id: firstVoiceId,
        speakerGender: this._sessionSpeakerGender,
        speakerVoiceType: this._sessionVoiceType,
        ttsSpeed,
        model: mtRes.model,
        economyMode,
        economyFallback,
        economy: mtRes.economy || null,
      });

      // Self-learning AFTER enqueue (background). Never sits on the critical path.
      // Hard lag / lag-shed / any concurrent load: skip — extra LLM fights live MT/TTS.
      if (
        this.settings.selfLearning !== false &&
        epoch === this._epoch &&
        !this.#isLagShed() &&
        !this._restLatestOnly &&
        this.busyChunks <= 1 &&
        (this._latencyEmaMs || 0) < 4500
      ) {
        const lagging =
          this.busyChunks > 1 ||
          this._latencyEmaMs > 3500 ||
          this._pendingChunk != null ||
          qProfile === 'fast';
        // Deep learn only when healthy + idle — never steal tokens from live dubbing
        this.#learnAfterPhrase(sourceText, translated, {
          skipDeep:
            lagging ||
            this.settings.deepLearning === false ||
            qProfile === 'fast' ||
            this._streamBusy > 0,
        })
          .then((better) => {
            if (!better || better === translated) return;
            if (epoch !== this._epoch || !this.running) return;
            // Update last history + on-screen cue if still current
            const last = this.history[this.history.length - 1];
            if (last?.source === sourceText) last.target = better;
            const c = this.subtitleCues.find((x) => x.id === cue.id);
            if (c) {
              c.text = better;
              this.onSubtitles({ phase: 'translated', ...c, refreshed: true });
            }
          })
          .catch((e) => log.debug('bg learn failed', e?.message || e));
      }
    } catch (e) {
      log.error('chunk pipeline', e);
      this.health?.markFailure('stt', e);
      this.onEvent({ type: 'warn', message: String(e.message || e) });
    } finally {
      if (restSpoken) this.#clearInflightSpoken(restSpoken);
      if (epoch === this._epoch) {
        this.busyChunks = Math.max(0, this.busyChunks - 1);
        this.health?.setInflight(this.busyChunks > 0);
        this.#drainPendingChunk();
      }
    }
  }

  /** Process newest held audio after a busy slot frees (coalesced backpressure). */
  #drainPendingChunk() {
    if (!this.running || !this._pendingChunk) return;
    if (this.busyChunks >= this.#maxBusy()) return;
    const next = this._pendingChunk;
    this._pendingChunk = null;
    // Fire-and-forget; #onAudioChunk manages busyChunks itself
    Promise.resolve(this.#onAudioChunk(next.float32, next.meta)).catch((e) =>
      log.debug('pending chunk failed', e?.message || e),
    );
  }

  /**
   * Local learn + every Nth phrase optional deep LLM review (local or Grok).
   * May return improved translation text.
   * @param {{ skipDeep?: boolean }} [opts]
   */
  async #learnAfterPhrase(sourceText, translated, opts = {}) {
    let text = translated;
    try {
      const learnRes = await sendMessage({
        type: MSG.LEARN_PHRASE,
        payload: {
          sourceText,
          translated: text,
          sourceLang: this.settings.sourceLang,
          targetLang: this.settings.targetLang,
          domain: this.context?.domainHint || '',
        },
      });
      if (learnRes?.revision != null) this._learningRevision = learnRes.revision;
      if (learnRes?.newExceptions?.length) {
        this.onEvent({
          type: 'learn',
          message: `Исключения: ${learnRes.newExceptions.slice(0, 3).join(', ')}`,
          exceptions: learnRes.newExceptions,
        });
        // refresh settings exceptions in memory
        this.settings = {
          ...this.settings,
          exceptions: [
            ...new Set([
              ...(this.settings.exceptions || []),
              ...learnRes.newExceptions,
            ]),
          ],
        };
      }
      if (learnRes?.revisionBumped) {
        this.#scheduleStaleRefresh();
      }

      this._learnCounter += 1;
      // Deep pass adds a full extra LLM round-trip — skip under load / fast profile
      if (opts.skipDeep) return text;
      // Deep pass: every 4th phrase in max/balanced, every 7th in fast
      const every =
        this.settings.qualityProfile === 'fast'
          ? 7
          : this.settings.qualityProfile === 'max'
            ? 3
            : 4;
      if (this.settings.deepLearning && this._learnCounter % every === 0) {
        const deep = await sendMessage({
          type: MSG.XAI_LEARN_PASS,
          payload: {
            sourceText,
            translated: text,
            sourceLang: this.settings.sourceLang,
            targetLang: this.settings.targetLang,
            context: this.context,
          },
        });
        if (deep?.ok && deep.better) {
          text = deep.better;
          this.onEvent({
            type: 'learn',
            message: 'Улучшен перевод (self-learn)',
            better: true,
          });
        }
        if (deep?.exceptions?.length) {
          this.settings = {
            ...this.settings,
            exceptions: [
              ...new Set([
                ...(this.settings.exceptions || []),
                ...deep.exceptions,
              ]),
            ],
          };
        }
        if (deep?.revision != null) this._learningRevision = deep.revision;
        if (deep?.revisionBumped) this.#scheduleStaleRefresh();
      }
    } catch (e) {
      log.debug('learn after phrase failed', e.message || e);
    }
    return text;
  }

  /** Debounced realtime retranslate of recent cues after learning */
  #scheduleStaleRefresh() {
    if (this.settings.autoUpdateStaleTranslations === false) return;
    if (!this.running) return;
    if (this._staleTimer) clearTimeout(this._staleTimer);
    this._staleTimer = setTimeout(() => {
      this._staleTimer = null;
      this.#refreshStaleCues().catch((e) =>
        log.debug('stale refresh', e.message || e),
      );
    }, 1800);
  }

  async #refreshStaleCues() {
    if (!this.running || this._retranslating) return;
    if (this.settings.autoUpdateStaleTranslations === false) return;

    const learnRes = await sendMessage({ type: MSG.GET_LEARNING });
    const learning = learnRes?.learning;
    if (!learning) return;

    const mediaTime = this.video?.currentTime || 0;
    // Prefer cues near current playback (watch realtime) + last few
    const recent = this.subtitleCues
      .filter((c) => {
        const end = c.end ?? c.start + 3;
        return end >= mediaTime - 8 && (c.start || 0) <= mediaTime + 30;
      })
      .slice(-8);

    const pool = recent.length ? recent : this.subtitleCues.slice(-6);
    const stale = findStaleCues(pool, learning, this.settings.glossary);
    if (!stale.length) return;

    this._retranslating = true;
    try {
      const res = await sendMessage({
        type: MSG.RETRANSLATE_STALE,
        payload: {
          items: stale.map((c) => ({
            id: c.id,
            sourceText: c.sourceText,
            text: c.text,
            sourceLang: this.settings.sourceLang,
            targetLang: this.settings.targetLang,
            context: this.context,
            history: this.history,
          })),
        },
      });
      if (!res?.ok) return;

      let updated = 0;
      for (const item of res.items || []) {
        if (!item.changed || !item.text) continue;
        const cue = this.subtitleCues.find((c) => c.id === item.id);
        if (!cue) continue;
        cue.text = item.text;
        cue.learningRevision = item.learningRevision ?? this._learningRevision;
        updated += 1;

        // Update on-screen subtitles if near now
        const end = cue.end ?? cue.start + 3;
        if (mediaTime >= (cue.start || 0) - 1 && mediaTime <= end + 2) {
          this.onSubtitles({
            phase: 'translated',
            ...cue,
            refreshed: true,
          });
        }

        // Re-TTS only for upcoming (not far in the past) cues
        if ((cue.start || 0) >= mediaTime - 1.5) {
          const ttsRes = await sendMessage({
            type: MSG.XAI_TTS,
            payload: {
              text: cue.text,
              voice_id: this.#resolveSessionVoiceId(),
              speaker_gender: this._sessionSpeakerGender || undefined,
              speaker_voice_type: this._sessionVoiceType || undefined,
              language: ttsLanguageCode(this.settings.targetLang),
              speed: this.#effectiveTtsSpeed(),
              expressiveSpeech: this.settings.expressiveSpeech !== false,
            },
          });
          if (ttsRes?.ok) {
            const audioBuffer = base64ToArrayBuffer(ttsRes.audioBase64);
            this.sync?.enqueue({
              ...cue,
              audioBuffer,
              contentType: ttsRes.contentType || 'audio/mpeg',
              refreshed: true,
            });
          }
        }
      }

      if (updated) {
        this.onEvent({
          type: 'learn',
          message: `Обновлено устаревших переводов: ${updated}`,
          updated,
        });
      }
      if (res.revision != null) this._learningRevision = res.revision;
    } finally {
      this._retranslating = false;
    }
  }

  /**
   * Update speaker gender + voice type from original PCM; notify UI once locked/changed.
   * TTS voice switches only after tracker lock (or strong locked flip) — no early wrong voice.
   * @param {Float32Array} float32
   * @param {number} sampleRate
   */
  #observeSpeakerGender(float32, sampleRate) {
    if (this.settings.autoMatchVoiceGender === false) return;
    if (!float32?.length) return;

    const result = this._genderTracker.observe(float32, sampleRate);
    // Wait for hysteresis lock before committing session TTS voice
    if (!this._genderTracker.locked && !result.locked) return;

    const profile = this._genderTracker.getReliableProfile();
    if (!profile?.gender) return;

    const reliable = profile.gender;
    const voiceType = profile.voiceType || null;
    const prevGender = this._sessionSpeakerGender;
    const prevType = this._sessionVoiceType;
    const prevVoice = this._sessionVoiceId;
    const nextVoice = resolveVoiceForGender(
      this.settings,
      reliable,
      null,
      voiceType,
    );

    // After first lock, only change if gender flipped with high confidence
    if (
      this._voiceLocked &&
      prevGender &&
      prevGender !== reliable &&
      (result.confidence || 0) < 0.78
    ) {
      return;
    }

    this._sessionSpeakerGender = reliable;
    this._sessionVoiceType = voiceType;
    this._sessionVoiceId = nextVoice;
    this._voiceLocked = true;

    if (
      result.changed ||
      prevGender !== reliable ||
      prevType !== voiceType ||
      prevVoice !== this._sessionVoiceId
    ) {
      const f0 =
        result.f0 != null ? ` · F0≈${Math.round(result.f0)} Hz` : '';
      const conf = Math.round((result.confidence || 0) * 100);
      const label = voiceProfileLabelRu(voiceType, reliable);
      this.onEvent({
        type: 'voice_gender',
        speakerGender: reliable,
        speakerVoiceType: voiceType,
        voice_id: this._sessionVoiceId,
        confidence: result.confidence,
        locked: true,
        f0: result.f0,
        message: `Голос автора: ${label} → TTS «${this._sessionVoiceId}» (${conf}%${f0})`,
      });
      log.info('speaker voice type auto match', {
        gender: reliable,
        voiceType,
        voice: this._sessionVoiceId,
        confidence: result.confidence,
        f0: result.f0,
      });
    }
  }

  /**
   * Session voice: gender/type match only after lock; until then user default.
   */
  #resolveSessionVoiceId() {
    if (this.settings.autoMatchVoiceGender === false) {
      return this.settings.voiceId || 'ara';
    }
    // Stick to locked session voice (may refine type within same gender)
    if (this._voiceLocked && this._sessionSpeakerGender) {
      this._sessionVoiceId = resolveVoiceForGender(
        this.settings,
        this._sessionSpeakerGender,
        null,
        this._sessionVoiceType,
      );
      return this._sessionVoiceId;
    }
    if (this._genderTracker.locked) {
      const profile = this._genderTracker.getReliableProfile();
      if (profile?.gender) {
        this._sessionSpeakerGender = profile.gender;
        this._sessionVoiceType = profile.voiceType || null;
        this._sessionVoiceId = resolveVoiceForGender(
          this.settings,
          profile.gender,
          null,
          profile.voiceType || null,
        );
        this._voiceLocked = true;
        return this._sessionVoiceId;
      }
    }
    // Provisional: if tracker already leans male with any samples, prefer male TTS
    // immediately (default voiceId is female ara — early phrases were always ♀).
    const snap = this._genderTracker?.snapshot?.();
    if (snap?.gender === 'male' && (snap.confidence || 0) >= 0.52) {
      return resolveVoiceForGender(
        this.settings,
        'male',
        null,
        snap.voiceType || null,
      );
    }
    if (snap?.gender === 'female' && (snap.confidence || 0) >= 0.7) {
      return resolveVoiceForGender(
        this.settings,
        'female',
        null,
        snap.voiceType || null,
      );
    }
    // Still unknown: if user explicitly picked a voice, keep it; else prefer male
    // default for auto-match sessions (fewer catastrophic ♀-on-♂ first lines).
    if (this.settings._userPickedVoice) {
      return this._sessionVoiceId || this.settings.voiceId || 'ara';
    }
    return (
      this._sessionVoiceId ||
      this.settings.voiceIdMale ||
      this.settings.voiceId ||
      'orion'
    );
  }

  #contextKeyterms() {
    const terms = [];
    const hint = this.context?.domainHint || '';
    if (/draw|art|рисован|3d form/i.test(hint)) {
      terms.push(
        'cube',
        'sphere',
        'pyramid',
        'cylinder',
        'cone',
        'perspective',
        'gesture',
        'anatomy',
        'куб',
        'сфера',
        'пирамида',
        'цилиндр',
        'конус',
      );
    }
    if (this.context?.videoTitle) {
      // pull capitalized tokens as soft keyterms
      const words = String(this.context.videoTitle).split(/[\s|/,:·—-]+/);
      for (const w of words) {
        if (w.length > 3 && w.length < 40) terms.push(w);
      }
    }
    return terms.slice(0, 25);
  }

  async #playPhrase(phrase) {
    if (!phrase.audioBuffer) return;
    // Never start a new TTS clip while the video is paused/ended
    if (!this.#isMediaPlaying()) {
      try {
        this.capture?.setOriginalVolume?.(this.settings.originalVolume ?? 0.15);
      } catch {
        /* ignore */
      }
      return;
    }
    // Dual-element crossfade handoff for continuous dubbing (no dead air)
    if (!this._audioEl) {
      this._audioEl = new Audio();
      this._audioEl.preload = 'auto';
    }
    if (!this._audioElB) {
      this._audioElB = new Audio();
      this._audioElB.preload = 'auto';
    }
    // Alternate elements so previous can trail briefly during overlap
    this._useAltAudio = !this._useAltAudio;
    const el = this._useAltAudio ? this._audioElB : this._audioEl;
    const other = this._useAltAudio ? this._audioEl : this._audioElB;

    // Soft-duck previous clip if still playing (gapless / interrupt)
    try {
      if (other && !other.paused) {
        // Fade-ish: drop volume then pause shortly
        other.volume = Math.min(other.volume, 0.25);
        if (phrase.late || this.settings.continuousDubbing !== false) {
          setTimeout(() => {
            try {
              other.pause();
            } catch {
              /* ignore */
            }
          }, AUDIO.phraseOverlapMs || 120);
        }
      }
    } catch {
      /* ignore */
    }

    if (this._lastTtsUrl && el === this._audioEl) {
      try {
        URL.revokeObjectURL(this._lastTtsUrl);
      } catch {
        /* ignore */
      }
    }
    if (this._lastTtsUrlB && el === this._audioElB) {
      try {
        URL.revokeObjectURL(this._lastTtsUrlB);
      } catch {
        /* ignore */
      }
    }

    const blob = new Blob([phrase.audioBuffer], {
      type: phrase.contentType || 'audio/mpeg',
    });
    const url = URL.createObjectURL(blob);
    if (el === this._audioElB) this._lastTtsUrlB = url;
    else this._lastTtsUrl = url;

    const vol = this.settings.translationVolume ?? 1;
    el.volume = Math.max(0, Math.min(1, vol));
    // Catch-up when phrase was re-anchored late (see SyncEngine)
    const rate = Number(phrase.playbackRate) || 1;
    el.playbackRate = Math.max(0.85, Math.min(1.42, rate));
    el.src = url;

    // duck original while TTS plays
    if (this.settings.duckOriginal && this.capture) {
      this.capture.setOriginalVolume(
        Math.min(this.settings.originalVolume ?? 0.15, 0.07),
      );
    }

    await new Promise((resolve) => {
      const done = () => {
        el.removeEventListener('ended', done);
        el.removeEventListener('error', done);
        try {
          el.playbackRate = 1;
        } catch {
          /* ignore */
        }
        // Restore original only if nothing else is playing
        const otherPlaying = other && !other.paused && !other.ended;
        if (!otherPlaying && this.settings.duckOriginal && this.capture) {
          this.capture.setOriginalVolume(this.settings.originalVolume ?? 0.15);
        }
        resolve();
      };
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      el.play().catch(async () => {
        try {
          const off = await sendMessage(
            {
              type: MSG.PLAY_TTS_CHUNK,
              payload: {
                audioBase64: arrayBufferToBase64(phrase.audioBuffer),
                contentType: phrase.contentType || 'audio/mpeg',
                volume: vol,
                playbackRate: rate,
              },
            },
            { timeoutMs: 15000 },
          );
          if (off?.ok && off.playing !== false) {
            const remain = Number(off.remainSec) > 0 ? off.remainSec * 1000 : 2500;
            setTimeout(done, remain);
            return;
          }
        } catch {
          /* ignore */
        }
        this.onEvent?.({
          type: 'warn',
          message: 'TTS play() blocked — offscreen fallback failed',
        });
        done();
      });
    });
  }

  exportSubtitles(format = 'srt') {
    const cues = this.subtitleCues.slice();
    if (format === 'json') return JSON.stringify(cues, null, 2);
    if (format === 'vtt') {
      const body = cues
        .map((c, i) => {
          const a = secToVtt(c.start);
          const b = secToVtt(c.end || c.start + 2);
          return `${i + 1}\n${a} --> ${b}\n${c.text}\n`;
        })
        .join('\n');
      return `WEBVTT\n\n${body}`;
    }
    // srt
    return cues
      .map((c, i) => {
        const a = secToSrt(c.start);
        const b = secToSrt(c.end || c.start + 2);
        return `${i + 1}\n${a} --> ${b}\n${c.text}\n`;
      })
      .join('\n');
  }
}

function secToSrt(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secInt = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(secInt)},${String(ms).padStart(3, '0')}`;
}

function secToVtt(sec) {
  return secToSrt(sec).replace(',', '.');
}

function pad(n) {
  return String(n).padStart(2, '0');
}
