/**
 * VOD prepare pipeline (non-live) — extract path, not page playback scan.
 *
 * 1) yt-dlp browser analog: resolve + download audio (YouTube Innertube)
 * 2) Offscreen decode → fixed 10s timeline slices
 * 3) Parallel xAI/local STT → MT → TTS into a timed cue bank
 * 4) Default: hold Play until FULL bank ready; optional progressive unlock
 *
 * Live streams must NOT use this path (realtime TranslatorPipeline only).
 */

import { MSG } from '../constants.js';
import { sttLanguageParam, ttsLanguageCode } from '../languages.js';
import { log } from '../logger.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../pcm-utils.js';
import { sendMessage } from '../messaging.js';
import { resolveVoiceForGender } from '../voices.js';
import { SyncEngine } from './sync-engine.js';
import { buildVideoContext } from './context-builder.js';
import { parseYoutubeVideoId } from '../media/audio-extractor.js';
import { chunkPriority } from '../media/audio-chunker.js';
import {
  shouldMarkChunkCompleted,
  shouldUnlockFirstChunk,
  shouldMarkCuePlayed,
  shouldAutoResumeAfterHole,
  VOD_CHUNK_MAX_RETRIES,
  outcomeFromChunkError,
  shouldFailEmptyBank,
  isNearDuplicateVodSource,
} from './vod-chunk-policy.js';

/**
 * @typedef {{
 *   id: string,
 *   start: number,
 *   end: number,
 *   sourceText: string,
 *   text: string,
 *   audioBuffer: ArrayBuffer,
 *   contentType: string,
 *   voice_id: string,
 * }} VodCue
 */

export class VodPreparePipeline {
  /**
   * @param {object} opts
   * @param {HTMLMediaElement} opts.video
   * @param {object} opts.settings
   * @param {(ev: object) => void} opts.onEvent
   * @param {(subs: object) => void} opts.onSubtitles
   * @param {string} [opts.pageUrl]
   * @param {object} [opts.playerResponse]
   * @param {string} [opts.videoId]
   * @param {{ streamUrl?: string, mime?: string, durationSec?: number, title?: string, source?: string }} [opts.resolvedAudio]
   */
  constructor({
    video,
    settings,
    onEvent,
    onSubtitles,
    pageUrl,
    playerResponse,
    videoId,
    resolvedAudio,
  }) {
    this.video = video;
    this.settings = settings;
    this.onEvent = onEvent || (() => {});
    this.onSubtitles = onSubtitles || (() => {});
    this.pageUrl = pageUrl || (typeof location !== 'undefined' ? location.href : '');
    this.playerResponse = playerResponse || null;
    this.videoId =
      videoId || parseYoutubeVideoId(this.pageUrl) || null;
    this.resolvedAudio = resolvedAudio || null;

    this.status = 'idle';
    this.running = false;
    this.ready = false;
    this.vodPrepare = true;
    this.context = buildVideoContext(video, document, {
      playerResponse: this.playerResponse,
    });
    this.sync = null;
    /** @type {VodCue[]} */
    this.cues = [];
    this.subtitleCues = [];
    this._epoch = 0;
    this._abort = false;
    this._sessionVoiceId = null;
    this._audioEl = null;
    this._audioElB = null;
    this._useAltAudio = false;
    this._lastTtsUrl = null;
    this._lastTtsUrlB = null;
    this._saved = null;
    this._jobId = null;
    this._chunkCount = 0;
    this._durationSec = 0;
    this._doneChunks = 0;
    this._sttActive = 0;
    this._mtActive = 0;
    this._phase = 'idle';
    this._pending = [];
    this._inflight = new Set();
    this._completed = new Set();
    this._pumpTimer = null;
    this._readyNotified = false;
    this._onSeek = null;
    this._onTimeUpdate = null;
    this._learnCounter = 0;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  getState() {
    return {
      status: this.status,
      running: this.running,
      ready: this.ready,
      phase: this._phase,
      cueCount: this.cues.length,
      context: this.context,
      streamMode: false,
      vodPrepare: true,
      progress: this.#progressPct(),
      jobId: this._jobId,
      chunkCount: this._chunkCount,
      doneChunks: this._doneChunks,
    };
  }

  #progressPct() {
    if (this._phase === 'extracting') return Math.min(12, 4 + this._doneChunks);
    if (this._phase === 'decoding') return 18;
    if (this._phase === 'processing' || this._phase === 'ready') {
      const n = Math.max(1, this._chunkCount || 1);
      const base = 20;
      return Math.min(99, base + Math.round((this._doneChunks / n) * 79));
    }
    if (this.ready && this._doneChunks >= this._chunkCount && this._chunkCount > 0) {
      return 100;
    }
    return 0;
  }

  #setStatus(s) {
    this.status = s;
  }

  #chunkSec() {
    return Number(this.settings?.vodChunkSec) > 0
      ? Number(this.settings.vodChunkSec)
      : 10;
  }

  #overlapSec() {
    const o = Number(this.settings?.vodChunkOverlapSec);
    return Number.isFinite(o) && o >= 0 ? o : 0.35;
  }

  #lookahead() {
    return Number(this.settings?.vodLookaheadSec) > 0
      ? Number(this.settings.vodLookaheadSec)
      : 90;
  }

  #sttConc() {
    return Math.max(1, Number(this.settings?.vodSttConcurrency) || 3);
  }

  #mtConc() {
    return Math.max(1, Number(this.settings?.vodMtTtsConcurrency) || 3);
  }

  /** Progressive unlock: only when vodProgressive===true */
  #isProgressive() {
    return this.settings?.vodProgressive === true;
  }

  #minBufferSec() {
    const n = Number(this.settings?.vodMinBufferSec);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  #pauseOnHole() {
    return this.settings?.vodPauseOnBufferHole !== false;
  }

  /** First timeline chunk covered (cue near 0 or intentional silence) — unlock from t≈0 */
  #firstChunkReady() {
    let earliest = Infinity;
    for (const c of this.cues || []) {
      const s = Number(c.mediaStart ?? c.start);
      if (Number.isFinite(s) && s < earliest) earliest = s;
    }
    return shouldUnlockFirstChunk({
      completedHas0: this._completed?.has(0) === true,
      earliestCueStart: Number.isFinite(earliest) ? earliest : undefined,
      cueCount: this.cues?.length || 0,
    });
  }

  /**
   * How far ahead of playhead we have continuous prepared media coverage.
   * Uses completed chunk indices (ok/silent only) — failed chunks do not count.
   */
  #bufferAheadSec(playhead = 0) {
    const t = Math.max(0, playhead);
    const chunkSec = this.#chunkSec();
    const overlap = this.#overlapSec();
    const step = Math.max(0.5, chunkSec - overlap);
    const dur = this._durationSec || 0;

    // Build prepared intervals from completed chunk indices
    const intervals = [];
    if (this._completed?.size) {
      for (const i of this._completed) {
        const cs = i * step;
        const ce = Math.min(dur || cs + chunkSec, cs + chunkSec);
        intervals.push({ s: cs, e: ce });
      }
    }
    // Also merge cue ranges (have audio)
    for (const c of this.cues || []) {
      intervals.push({
        s: c.mediaStart ?? c.start,
        e: c.mediaEnd ?? c.end,
      });
    }
    intervals.sort((a, b) => a.s - b.s);

    let cursor = t;
    for (const iv of intervals) {
      if (iv.e < t - 0.05) continue;
      if (iv.s > cursor + 0.4) break;
      cursor = Math.max(cursor, iv.e);
    }
    return Math.max(0, cursor - t);
  }

  #allChunksDone() {
    const terminal =
      (this._completed?.size || 0) + (this._failedTerminal?.size || 0);
    return (
      this._chunkCount > 0 &&
      terminal >= this._chunkCount &&
      this._pending?.length === 0 &&
      this._sttActive === 0 &&
      this._mtActive === 0 &&
      (this._inflight?.size || 0) === 0
    );
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.ready = false;
    this._abort = false;
    this._epoch += 1;
    const epoch = this._epoch;
    this.cues = [];
    this.subtitleCues = [];
    this._doneChunks = 0;
    this._chunkCount = 0;
    this._pending = [];
    this._inflight = new Set();
    this._completed = new Set();
    this._chunkRetries = new Map();
    this._failedTerminal = new Set();
    this._readyNotified = false;
    this._learnCounter = 0;
    this.context = buildVideoContext(this.video, document, {
      playerResponse: this.playerResponse,
    });
    this.#setStatus('starting');
    this._phase = 'extracting';

    const stack =
      this.settings?.providerMode === 'local' ? 'local STT/MT/TTS' : 'xAI';
    this.onEvent({
      type: 'started',
      message: `VOD: качаю аудио (extractor) → 10с → ${stack}…`,
      context: this.context,
      vodPrepare: true,
      streamMode: false,
    });
    this.onEvent({
      type: 'vod_progress',
      phase: 'extracting',
      pct: 2,
      message: 'Извлекаю аудиодорожку (yt-dlp analog)…',
    });

    this.sync = new SyncEngine({
      getMediaTime: () => this.video.currentTime || 0,
      onPlayPhrase: (phrase) => this.#playPhrase(phrase),
      onDropPhrase: (p, reason) => {
        log.debug('VOD sync drop', reason, p?.text?.slice?.(0, 40));
        if (p?.id) this._activeCueId = null;
      },
      // One phrase at a time — continuous caused overlap doubles
      continuous: false,
      isMediaPlaying: () => !this.video.paused && !this.video.ended,
    });
    // Strict bank timeline: wait for cue.start, don't spray late re-anchors
    this.sync.softBehind = 1.2;
    this.sync.maxBehind = 10;
    this.sync.hardDropBehind = 16;
    this.sync.extremeDropBehind = 24;
    this.sync.maxAheadWait = 2.5;
    this.sync.adaptiveOffset = 0.04;
    /** @type {Set<string>} cues already voiced this seek-window */
    this._playedCueIds = new Set();
    this._activeCueId = null;
    this._playGate = Promise.resolve();

    this.#savePlayback();
    // Unlock HTMLAudio during user gesture that started VOD (extension click)
    this.#unlockTtsAudio();

    try {
      const ra = this.resolvedAudio || {};
      const extract = await sendMessage(
        {
          type: MSG.MEDIA_EXTRACT,
          pageUrl: this.pageUrl,
          videoId: this.videoId,
          playerResponse: this.playerResponse,
          streamUrl: ra.streamUrl || null,
          mime: ra.mime || null,
          durationSec: ra.durationSec || null,
          title: ra.title || null,
          source: ra.source || null,
          userAgent: ra.userAgent || null,
          chunkSec: this.#chunkSec(),
          overlapSec: this.#overlapSec(),
        },
        { timeoutMs: 900000 },
      );

      if (this._abort || epoch !== this._epoch) return;
      if (!extract?.ok) {
        throw new Error(
          extract?.error ||
            'Не удалось вытащить аудио (extractor). YouTube-only v1 / Live-режим.',
        );
      }

      this._jobId = extract.jobId;
      this._durationSec = Number(extract.durationSec) || 0;
      this._chunkCount = Number(extract.chunkCount) || 0;
      this._phase = 'processing';

      this.onEvent({
        type: 'vod_progress',
        phase: 'processing',
        pct: 20,
        message: `Аудио готово · ${this._chunkCount} чанков по ${this.#chunkSec()}с · xAI STT…`,
        duration: this._durationSec,
        title: extract.title,
      });

      // Build pending indices
      this._pending = [];
      for (let i = 0; i < this._chunkCount; i++) this._pending.push(i);

      // Hard-mute original while preparing + dubbing
      this.#applyMute(true);
      this.#armMuteLock(true);

      const progressive = this.#isProgressive();
      // Hold Play until first chunk (or full bank if !progressive)
      try {
        this.video.pause?.();
      } catch {
        /* ignore */
      }

      this.sync.start();
      this.#armHandlers();
      this.#setStatus('preparing');
      this.ready = false;
      this.#armHoldPlay(true);

      this.onEvent({
        type: 'vod_progress',
        phase: 'processing',
        pct: 20,
        message: progressive
          ? `Готовлю 1-й чанк… после него можно Play (остальное догонит)`
          : `Готовлю ВЕСЬ перевод (${this._chunkCount}×${this.#chunkSec()}с) — жди`,
        progressive,
      });

      const run = this.#processAll(epoch)
        .then(() => {
          if (this._abort || epoch !== this._epoch) return;
          if (
            shouldFailEmptyBank({
              cueCount: this.cues.length,
              failedTerminal: this._failedTerminal?.size || 0,
              chunkCount: this._chunkCount,
            })
          ) {
            throw new Error(
              'VOD: все чанки провалились (STT/MT/TTS) — банк пустой',
            );
          }
          this.cues.sort((a, b) => a.start - b.start);
          this._phase = 'ready';
          this.ready = true;
          this.#setStatus('running');
          this.#armHoldPlay(false);
          this.#resyncCuesToTime(this.video.currentTime || 0, { force: true });
          const msg = `VOD банк полный: ${this.cues.length} фраз · ${this._chunkCount} чанков`;
          this.onEvent({
            type: 'vod_progress',
            phase: 'ready',
            pct: 100,
            message: msg,
            cueCount: this.cues.length,
          });
          // If progressive already notified on first chunk, just info
          if (!this._readyNotified) {
            this.#notifyReady(this.cues.length, msg);
          } else {
            this.onEvent({ type: 'info', message: msg });
          }
        })
        .catch((e) => {
          if (this._abort || epoch !== this._epoch) return;
          this.#setStatus('error');
          this.#armHoldPlay(false);
          this.onEvent({
            type: 'error',
            message: `VOD process failed: ${e?.message || e}`,
          });
        });

      if (progressive) {
        // Don't block start() — unlock when first chunk lands via #maybeProgressiveReady
        void run;
      } else {
        await run;
      }
    } catch (e) {
      if (this._abort) return;
      this.#setStatus('error');
      this.running = false;
      this.#disarmHoldPlay();
      this.#armMuteLock(false);
      this.#applyMute(false);
      this.#restorePlayback(false);
      this.onEvent({
        type: 'error',
        message: `VOD prepare failed: ${e?.message || e}`,
      });
      throw e;
    }
  }

  async stop() {
    this._abort = true;
    this.running = false;
    this.ready = false;
    this._epoch += 1;
    this._phase = 'idle';
    if (this._pumpTimer) {
      clearTimeout(this._pumpTimer);
      this._pumpTimer = null;
    }
    this.#disarmHandlers();
    this.#armMuteLock(false);
    this.sync?.stop();
    if (this._jobId) {
      sendMessage({ type: MSG.MEDIA_JOB_ABORT, jobId: this._jobId }).catch(
        () => {},
      );
      this._jobId = null;
    }
    sendMessage({ type: MSG.STOP_TTS_PLAYBACK }).catch(() => {});
    this.#disarmHoldPlay();
    this.#applyMute(false);
    this.#restorePlayback(false);
    for (const el of [this._audioEl, this._audioElB]) {
      if (!el) continue;
      try {
        el.pause();
        el.removeAttribute('src');
      } catch {
        /* ignore */
      }
    }
    if (this._lastTtsUrl) URL.revokeObjectURL(this._lastTtsUrl);
    if (this._lastTtsUrlB) URL.revokeObjectURL(this._lastTtsUrlB);
    this._lastTtsUrl = null;
    this._lastTtsUrlB = null;
    this.cues = [];
    this.#setStatus('stopped');
    this.onEvent({ type: 'stopped', message: 'VOD перевод остановлен' });
  }

  #savePlayback() {
    this._saved = {
      time: this.video.currentTime || 0,
      paused: !!this.video.paused,
      rate: this.video.playbackRate || 1,
      volume: this.video.volume,
      muted: !!this.video.muted,
    };
  }

  #restorePlayback(keepMutePolicy) {
    if (!this._saved) return;
    try {
      this.video.playbackRate = this._saved.rate || 1;
      if (!keepMutePolicy) {
        this.video.volume = this._saved.volume;
        this.video.muted = this._saved.muted;
      }
    } catch {
      /* ignore */
    }
  }

  #applyMute(on) {
    if (this.settings?.vodMuteOriginal === false) return;
    try {
      if (on) {
        // YouTube often ignores muted alone after user hits play — both knobs
        this.video.muted = true;
        this.video.volume = 0;
        // YT player API if present
        try {
          const p =
            this.video.closest?.('.html5-video-player') ||
            document.getElementById('movie_player');
          if (p && typeof p.mute === 'function') p.mute();
          if (p && typeof p.setVolume === 'function') p.setVolume(0);
        } catch {
          /* ignore */
        }
      } else if (this._saved) {
        this.video.muted = this._saved.muted;
        this.video.volume =
          typeof this._saved.volume === 'number' ? this._saved.volume : 1;
        try {
          const p =
            this.video.closest?.('.html5-video-player') ||
            document.getElementById('movie_player');
          if (p && typeof p.unMute === 'function' && !this._saved.muted) {
            p.unMute();
          }
          if (p && typeof p.setVolume === 'function') {
            p.setVolume(Math.round((this._saved.volume ?? 1) * 100));
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** Re-assert mute — YT UI / play() constantly restores volume */
  #armMuteLock(on) {
    this.#disarmMuteLock();
    if (!on || this.settings?.vodMuteOriginal === false) return;
    this._muteLocked = true;
    this._onVolGuard = () => {
      if (!this._muteLocked || !this.running) return;
      try {
        if (!this.video.muted || (this.video.volume || 0) > 0.001) {
          this.video.muted = true;
          this.video.volume = 0;
        }
      } catch {
        /* ignore */
      }
    };
    this._mutePoll = setInterval(() => this._onVolGuard?.(), 400);
    for (const ev of ['volumechange', 'play', 'playing', 'loadeddata']) {
      this.video.addEventListener(ev, this._onVolGuard);
    }
  }

  #disarmMuteLock() {
    this._muteLocked = false;
    if (this._mutePoll) {
      clearInterval(this._mutePoll);
      this._mutePoll = null;
    }
    if (this._onVolGuard) {
      for (const ev of ['volumechange', 'play', 'playing', 'loadeddata']) {
        try {
          this.video.removeEventListener(ev, this._onVolGuard);
        } catch {
          /* ignore */
        }
      }
      this._onVolGuard = null;
    }
  }

  /** Create Audio elements + silent play during user gesture */
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
      // silent wav data-uri unlock
      const silent =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
      for (const el of [this._audioEl, this._audioElB]) {
        el.src = silent;
        el.volume = 0.01;
        el.play().then(() => {
          try {
            el.pause();
            el.removeAttribute('src');
            el.load?.();
          } catch {
            /* ignore */
          }
        }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  #notifyReady(cueCount, explicitMsg) {
    if (this._readyNotified) return;
    this._readyNotified = true;
    this.ready = true;
    const msg =
      explicitMsg ||
      (this.#isProgressive()
        ? `VOD: буфер готов · ${cueCount} фраз (банк ещё догоняет)`
        : `VOD готов: ${cueCount} фраз · можно смотреть`);
    this.onEvent({
      type: 'vod_ready',
      message: msg,
      cueCount,
      pct: this.#progressPct(),
      progressive: this.#isProgressive(),
      fullBank: !this.#isProgressive() || this.#allChunksDone(),
    });
    this.onEvent({ type: 'info', message: msg });
    sendMessage({
      type: MSG.HEALTH_ALERT,
      level: 'ok',
      kind: 'vod_ready',
      title: 'AetherVox',
      message: msg,
    }).catch(() => {});
  }

  /** While full-bank prepare: force-pause if user hits play (avoid silence) */
  #armHoldPlay(on) {
    this.#disarmHoldPlay();
    if (!on) return;
    this._holdPlay = true;
    this._onHoldPlay = () => {
      if (!this._holdPlay || this.ready) return;
      try {
        this.video.pause();
      } catch {
        /* ignore */
      }
      this.onEvent({
        type: 'info',
        message: `Подожди: готовлю перевод ${this._doneChunks}/${this._chunkCount}…`,
      });
    };
    this.video.addEventListener('play', this._onHoldPlay);
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }
  }

  #disarmHoldPlay() {
    this._holdPlay = false;
    if (this._onHoldPlay) {
      try {
        this.video.removeEventListener('play', this._onHoldPlay);
      } catch {
        /* ignore */
      }
      this._onHoldPlay = null;
    }
  }

  #maybeProgressiveReady() {
    if (!this.#isProgressive() || this._readyNotified) return;
    const need = this.#minBufferSec();
    const fromZero = this.#bufferAheadSec(0);
    // Unlock as soon as first chunk is done (and optional min buffer from 0)
    const firstOk = this.#firstChunkReady();
    if (!firstOk) return;
    if (need > 0 && fromZero < need && !this.#allChunksDone()) return;

    this._phase = 'ready';
    this.ready = true;
    this.#setStatus('running');
    this.#armHoldPlay(false);
    const msg = `VOD: 1-й чанк готов · можно смотреть (остальное догоняет · ${this._doneChunks}/${this._chunkCount})`;
    this.#notifyReady(this.cues.length, msg);
    this.#resyncCuesToTime(this.video.currentTime || 0, { force: true });
  }

  /**
   * If user plays past prepared bank — pause and wait for next chunk
   * (better than silence).
   */
  #guardBufferHole() {
    if (!this.ready || !this.#pauseOnHole()) return;
    if (this.video.paused || this.video.ended) return;
    if (this.#allChunksDone()) return;
    const t = this.video.currentTime || 0;
    const ahead = this.#bufferAheadSec(t);
    // Less than ~0.8s of prepared content ahead → pause
    if (ahead < 0.8) {
      try {
        this.video.pause();
      } catch {
        /* ignore */
      }
      if (!this._holeToastAt || Date.now() - this._holeToastAt > 2500) {
        this._holeToastAt = Date.now();
        this.onEvent({
          type: 'info',
          message: `Пауза: жду следующий чанк… (${this._doneChunks}/${this._chunkCount})`,
        });
      }
      this._waitingHole = true;
    }
  }

  #maybeResumeAfterHole() {
    if (!this._waitingHole || !this.ready) return;
    const t = this.video.currentTime || 0;
    const ahead = this.#bufferAheadSec(t);
    if (ahead >= 2 || this.#allChunksDone()) {
      this._waitingHole = false;
      this.#resyncCuesToTime(t, { force: false });
      this.onEvent({
        type: 'info',
        message: `Чанк готов · буфер ~${ahead.toFixed(0)}с — жми Play`,
      });
      // Do NOT auto video.play() — autoplay policy blocks programmatic resume
      // after our own pause() (see last-result.json cold-strict). User presses Play.
      if (shouldAutoResumeAfterHole()) {
        try {
          void this.video.play?.();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async #processAll(epoch) {
    while (
      !this._abort &&
      epoch === this._epoch &&
      (this._pending.length > 0 ||
        this._sttActive > 0 ||
        this._mtActive > 0 ||
        this._inflight.size > 0)
    ) {
      this.#reorderPending();
      while (
        this._sttActive < this.#sttConc() &&
        this._pending.length > 0 &&
        !this._abort &&
        epoch === this._epoch
      ) {
        const index = this._pending.shift();
        if (
          this._completed.has(index) ||
          this._failedTerminal?.has(index) ||
          this._inflight.has(index)
        )
          continue;
        this._inflight.add(index);
        this._sttActive += 1;
        this.#processChunk(index, epoch)
          .then((status) => {
            if (this._abort || epoch !== this._epoch) return;
            this.#onChunkSettled(index, status);
          })
          .catch((e) => {
            log.warn('VOD chunk', e?.message || e);
            if (this._abort || epoch !== this._epoch) return;
            this.#onChunkSettled(index, outcomeFromChunkError());
          })
          .finally(() => {
            this._sttActive -= 1;
            this._inflight.delete(index);
            this._doneChunks = this._completed.size;
            const ahead = this.#bufferAheadSec(this.video.currentTime || 0);
            this.onEvent({
              type: 'vod_progress',
              phase: this.ready ? 'ready' : 'processing',
              pct: this.#progressPct(),
              message: this.ready
                ? `Смотри · догоняю ${this._doneChunks}/${this._chunkCount} · буфер ~${ahead.toFixed(0)}с · фраз ${this.cues.length}`
                : this.#isProgressive()
                  ? `Жду 1-й чанк… ${this._doneChunks}/${this._chunkCount}`
                  : `Готовлю весь перевод ${this._doneChunks}/${this._chunkCount} · фраз ${this.cues.length}`,
              cueCount: this.cues.length,
              playhead: this.video.currentTime || 0,
              bufferAheadSec: ahead,
            });
            this.#maybeProgressiveReady();
            this.#maybeResumeAfterHole();
            if (this.ready) {
              this.#resyncCuesToTime(this.video.currentTime || 0, {
                force: false,
              });
            }
          });
      }
      await sleep(60);
    }
  }

  #onChunkSettled(index, status) {
    if (shouldMarkChunkCompleted(status)) {
      this._completed.add(index);
    } else if (status === 'failed') {
      const tries = (this._chunkRetries?.get(index) || 0) + 1;
      if (!this._chunkRetries) this._chunkRetries = new Map();
      this._chunkRetries.set(index, tries);
      this.onEvent({
        type: 'vod_chunk_error',
        index,
        tries,
        message: `Чанк ${index + 1}: ошибка STT/MT/TTS (попытка ${tries})`,
      });
      if (tries <= VOD_CHUNK_MAX_RETRIES) {
        this._pending.push(index);
      } else {
        this._failedTerminal.add(index);
        log.warn('VOD chunk permanently failed', index);
      }
    }
  }

  #reorderPending() {
    const t = this.video.currentTime || 0;
    const la = this.#lookahead();
    const chunkSec = this.#chunkSec();
    this._pending.sort((a, b) => {
      const sa = a * (chunkSec - this.#overlapSec());
      const sb = b * (chunkSec - this.#overlapSec());
      return chunkPriority(sa, t, la) - chunkPriority(sb, t, la);
    });
  }

  async #processChunk(index, epoch) {
    if (this._abort || epoch !== this._epoch || !this._jobId) return 'aborted';

    const slice = await sendMessage(
      {
        type: MSG.MEDIA_CHUNK_WAV,
        jobId: this._jobId,
        index,
      },
      { timeoutMs: 60000 },
    );
    if (this._abort || epoch !== this._epoch) return 'aborted';
    if (!slice?.ok) {
      log.debug('chunk slice fail', index, slice?.error);
      return 'failed';
    }
    // Intentional silence / empty WAV — covers timeline, no cue
    if (slice.silent || !slice.wavBase64) return 'silent';

    const sttRes = await sendMessage(
      {
        type: MSG.XAI_STT,
        payload: {
          wavBase64: slice.wavBase64,
          language: sttLanguageParam(this.settings.sourceLang),
          keyterms: (this.settings.keyterms || []).slice(0, 24),
          format: true,
          timeoutMs:
            this.settings?.providerMode === 'local' ? 90000 : 45000,
        },
      },
      {
        timeoutMs:
          this.settings?.providerMode === 'local' ? 95000 : 45000,
      },
    );
    if (this._abort || epoch !== this._epoch) return 'aborted';
    if (!sttRes?.ok) return 'failed';
    const sourceText = String(sttRes.text || '').trim();
    // No speech in this window — treat as silence coverage
    if (!sourceText || sourceText.length < 2) return 'silent';

    const start = Number(slice.start) || index * this.#chunkSec();
    const end = Number(slice.end) || start + this.#chunkSec();
    if (this.#isDuplicate(sourceText, start)) return 'silent';

    await this.#acquireMtSlot();
    if (this._abort || epoch !== this._epoch) {
      this.#releaseMtSlot();
      return 'aborted';
    }
    try {
      const voiceId =
        this._sessionVoiceId ||
        resolveVoiceForGender(this.settings, null, null, null) ||
        this.settings.voiceId ||
        'ara';
      if (!this._sessionVoiceId) this._sessionVoiceId = voiceId;

      const qProfile =
        this.settings.qualityProfile === 'fast'
          ? 'balanced'
          : this.settings.qualityProfile || 'balanced';

      const mtRes = await sendMessage(
        {
          type: MSG.XAI_TRANSLATE,
          payload: {
            text: sourceText,
            sourceLang: this.settings.sourceLang,
            targetLang: this.settings.targetLang,
            context: this.context,
            qualityProfile: qProfile,
            liveLatency: false,
            allowRepair: this.settings.qualityProfile === 'max',
            history: this.subtitleCues.slice(-4).map((c) => ({
              source: c.sourceText,
              target: c.text,
            })),
          },
        },
        { timeoutMs: 60000 },
      );
      if (this._abort || epoch !== this._epoch) return 'aborted';
      if (!mtRes?.ok) return 'failed';
      const text = String(mtRes.text || '').trim();
      if (!text) return 'failed';

      const ttsRes = await sendMessage(
        {
          type: MSG.XAI_TTS,
          payload: {
            text,
            voice_id: voiceId,
            language: ttsLanguageCode(this.settings.targetLang),
            speed: this.settings.ttsSpeed ?? 1.05,
            expressiveSpeech: this.settings.expressiveSpeech !== false,
            optimize_streaming_latency: 0,
          },
        },
        { timeoutMs: 60000 },
      );
      if (this._abort || epoch !== this._epoch) return 'aborted';
      if (!ttsRes?.ok) return 'failed';

      const audioBuffer = base64ToArrayBuffer(ttsRes.audioBase64);
      const cue = {
        id: `vod_${start.toFixed(2)}_${index}`,
        start,
        end: Math.max(end, start + 0.4),
        /** immutable media timeline for sync */
        mediaStart: start,
        mediaEnd: Math.max(end, start + 0.4),
        sourceText,
        text,
        audioBuffer,
        /** compact restore after B23 prune / seek-back (B29) */
        audioBase64: ttsRes.audioBase64,
        contentType: ttsRes.contentType || 'audio/mpeg',
      };
      this.cues.push(cue);
      this.cues.sort(
        (a, b) => (a.mediaStart ?? a.start) - (b.mediaStart ?? b.start),
      );
      this.subtitleCues.push({
        start,
        end: cue.end,
        sourceText,
        text,
      });
      if (this.subtitleCues.length > 500) this.subtitleCues.shift();

      this.#maybeProgressiveReady();
      this.#applyMute(true);
      if (this.ready) {
        this.#offerCueToSync(cue);
      }

      // Self-learning AFTER cue bank entry — never blocks STT/MT/TTS pump
      if (this.settings.selfLearning !== false && sourceText && text) {
        void this.#learnAfterCue(sourceText, text).catch((e) =>
          log.debug('vod learn failed', e?.message || e),
        );
      }

      this.onSubtitles({
        phase: 'translated',
        sourceText,
        text,
        start: cue.start,
        end: cue.end,
        stream: false,
        vod: true,
      });
      this.onEvent({
        type: 'vod_progress',
        phase: this._phase,
        pct: this.#progressPct(),
        message: `Фраз ${this.cues.length} · cue ${start.toFixed(1)}–${end.toFixed(1)}s`,
        cueCount: this.cues.length,
      });
      return 'ok';
    } finally {
      this.#releaseMtSlot();
    }
  }

  /**
   * Phrase memory + optional deep LLM review (local or Grok).
   * Fire-and-forget from the MT path — must not await on the critical path.
   */
  async #learnAfterCue(sourceText, translated) {
    if (this._abort || this.settings.selfLearning === false) return;
    try {
      const learnRes = await sendMessage({
        type: MSG.LEARN_PHRASE,
        payload: {
          sourceText,
          translated,
          sourceLang: this.settings.sourceLang,
          targetLang: this.settings.targetLang,
          domain: this.context?.domainHint || '',
        },
      });
      if (learnRes?.newExceptions?.length) {
        this.settings = {
          ...this.settings,
          exceptions: [
            ...new Set([
              ...(this.settings.exceptions || []),
              ...learnRes.newExceptions,
            ]),
          ],
        };
        this.onEvent({
          type: 'learn',
          message: `Исключения: ${learnRes.newExceptions.slice(0, 3).join(', ')}`,
          exceptions: learnRes.newExceptions,
        });
      }

      this._learnCounter += 1;
      if (this.settings.deepLearning === false) return;
      const every =
        this.settings.qualityProfile === 'fast'
          ? 7
          : this.settings.qualityProfile === 'max'
            ? 3
            : 4;
      if (this._learnCounter % every !== 0) return;
      if (this._abort) return;

      const deep = await sendMessage({
        type: MSG.XAI_LEARN_PASS,
        payload: {
          sourceText,
          translated,
          sourceLang: this.settings.sourceLang,
          targetLang: this.settings.targetLang,
          context: this.context,
        },
      });
      if (deep?.ok && deep.better) {
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
    } catch (e) {
      log.debug('vod learnAfterCue', e?.message || e);
    }
  }

  #mtWaiters = [];
  async #acquireMtSlot() {
    while (this._mtActive >= this.#mtConc()) {
      await new Promise((r) => this.#mtWaiters.push(r));
    }
    this._mtActive += 1;
  }

  #releaseMtSlot() {
    this._mtActive = Math.max(0, this._mtActive - 1);
    const w = this.#mtWaiters.shift();
    if (w) w();
  }

  #isDuplicate(text, start) {
    return isNearDuplicateVodSource(text, start, this.cues);
  }

  #armHandlers() {
    this._onSeek = () => {
      if (!this.running) return;
      this.#applyMute(true);
      // Hard reset voice timeline on seek
      this._playedCueIds?.clear?.();
      this._activeCueId = null;
      sendMessage({ type: MSG.STOP_TTS_PLAYBACK }).catch(() => {});
      this.#resyncCuesToTime(this.video.currentTime || 0, { force: true });
      this.#reorderPending();
    };
    // Debounce play/playing — both fire and used to double-enqueue
    this._onPlay = () => {
      if (!this.running) return;
      const now = performance.now();
      if (this._lastPlayArmAt && now - this._lastPlayArmAt < 400) return;
      this._lastPlayArmAt = now;
      this.#applyMute(true);
      this.#resyncCuesToTime(this.video.currentTime || 0, { force: false });
      this.#reorderPending();
    };
    this._onTimeUpdate = () => {
      if (!this.running) return;
      this._timeTick = (this._timeTick || 0) + 1;
      if (this._timeTick % 5 === 0) this.#applyMute(true);
      if (!this.ready) return;
      // Pause before running into unprepared silence
      if (this._timeTick % 3 === 0) this.#guardBufferHole();
      if (this._timeTick % 40 === 0) {
        const qLen = this.sync?.queue?.length || 0;
        if (!this._activeCueId && qLen === 0) {
          this.#resyncCuesToTime(this.video.currentTime || 0, {
            force: false,
          });
        }
      }
    };
    this.video.addEventListener('seeked', this._onSeek);
    this.video.addEventListener('play', this._onPlay);
    this.video.addEventListener('playing', this._onPlay);
    this.video.addEventListener('timeupdate', this._onTimeUpdate);
  }

  #disarmHandlers() {
    if (this._onSeek) {
      this.video.removeEventListener('seeked', this._onSeek);
      this._onSeek = null;
    }
    if (this._onPlay) {
      this.video.removeEventListener('play', this._onPlay);
      this.video.removeEventListener('playing', this._onPlay);
      this._onPlay = null;
    }
    if (this._onTimeUpdate) {
      this.video.removeEventListener('timeupdate', this._onTimeUpdate);
      this._onTimeUpdate = null;
    }
  }

  /**
   * Schedule cue on media timeline.
   * - Before start → wait until mediaStart
   * - Inside window → play now with offset into TTS (= how far into chunk)
   * - Never re-queue already played cue until seek
   */
  #offerCueToSync(cue) {
    if (!this.sync || !cue) return;
    this.#ensureCueAudio(cue);
    if (!cue.audioBuffer) return;
    const t = this.video.currentTime || 0;
    const mediaStart = cue.mediaStart ?? cue.start;
    const mediaEnd = cue.mediaEnd ?? cue.end;

    if (mediaEnd < t - 0.25) {
      // fully behind — mark played so we don't loop; drop PCM keep base64 (B23/B29)
      this._playedCueIds?.add(cue.id);
      cue.audioBuffer = null;
      return;
    }
    if (mediaStart > t + this.#lookahead()) return;
    if (this._playedCueIds?.has(cue.id)) return;
    if (this._activeCueId === cue.id) return;

    const q = this.sync.queue || [];
    if (q.some((x) => x.id === cue.id)) return;

    const inside = t >= mediaStart - 0.05 && t < mediaEnd;
    const offsetSec = inside ? Math.max(0, t - mediaStart) : 0;
    // Schedule at mediaStart when upcoming; if already inside, start immediately
    const scheduleStart = inside ? t : mediaStart;
    const scheduleEnd = mediaEnd;

    this.sync.enqueue({
      id: cue.id,
      text: cue.text,
      sourceText: cue.sourceText,
      audioBuffer: cue.audioBuffer,
      contentType: cue.contentType,
      mediaStart,
      mediaEnd,
      offsetSec,
      // SyncEngine uses start/end for wait/drop
      start: scheduleStart,
      end: scheduleEnd,
      late: false,
      durationHint: Math.max(0.4, scheduleEnd - scheduleStart),
    });
  }

  #resyncCuesToTime(t, { force = false } = {}) {
    if (!this.sync || !this.cues.length) return;
    if (force) {
      this.sync.clear?.();
      this._playedCueIds = new Set();
      this._activeCueId = null;
    }
    const from = Math.max(0, t - 0.15);
    const to = t + this.#lookahead();
    let n = 0;
    for (const c of this.cues) {
      const ms = c.mediaStart ?? c.start;
      const me = c.mediaEnd ?? c.end;
      if (me < from) continue;
      if (ms > to) break;
      this.#offerCueToSync(c);
      n += 1;
      if (n > 30) break;
    }
  }

  async #playPhrase(phrase) {
    this.#ensureCueAudio(phrase);
    if (!phrase?.audioBuffer) return;
    // Serialize plays — SyncEngine can call again before prior await settles
    const prev = this._playGate || Promise.resolve();
    let release;
    this._playGate = new Promise((r) => {
      release = r;
    });
    await prev.catch(() => {});

    try {
      if (phrase.id && this._playedCueIds?.has(phrase.id)) return;
      if (phrase.id && this._activeCueId === phrase.id) return;

      this.#applyMute(true);
      this._activeCueId = phrase.id || null;

      const vol = this.settings.translationVolume ?? 1;
      const rate = phrase.playbackRate || 1;
      // Recompute offset from live playhead vs mediaStart (best sync)
      const mediaStart = phrase.mediaStart ?? phrase.start ?? 0;
      const t = this.video.currentTime || 0;
      let offsetSec =
        phrase.offsetSec != null
          ? Number(phrase.offsetSec)
          : Math.max(0, t - mediaStart);
      // Don't start audio almost finished
      if (offsetSec > 12) offsetSec = 0;

      let audioBase64;
      try {
        audioBase64 = arrayBufferToBase64(phrase.audioBuffer);
      } catch (e) {
        log.warn('VOD TTS b64', e?.message || e);
        return;
      }

      // ONLY offscreen — local+page doubles caused echo
      let remainSec = Math.max(
        0.6,
        (phrase.mediaEnd ?? phrase.end ?? t + 2) - t,
      );
      let offscreenOk = false;
      let localPlayOk = false;
      let skipped = false;
      try {
        const res = await sendMessage(
          {
            type: MSG.PLAY_TTS_CHUNK,
            audioBase64,
            contentType: phrase.contentType || 'audio/mpeg',
            volume: vol,
            playbackRate: rate,
            offsetSec,
          },
          { timeoutMs: 20000 },
        );
        if (res?.ok && res.skipped) {
          skipped = true;
        } else if (res?.ok) {
          offscreenOk = true;
          if (res.remainSec > 0) remainSec = res.remainSec;
          log.debug(
            'VOD TTS',
            phrase.text?.slice?.(0, 40),
            `off=${offsetSec.toFixed(2)} remain=${remainSec.toFixed(2)}`,
          );
        } else {
          log.warn('VOD TTS offscreen', res?.error || 'fail');
          localPlayOk = await this.#playLocalFallback(
            phrase,
            vol,
            rate,
            offsetSec,
          );
        }
      } catch (e) {
        log.warn('VOD TTS throw', e?.message || e);
        localPlayOk = await this.#playLocalFallback(
          phrase,
          vol,
          rate,
          offsetSec,
        );
      }

      const markPlayed = shouldMarkCuePlayed({
        offscreenOk,
        localPlayOk,
        skipped,
      });
      if (!markPlayed) {
        log.warn('VOD TTS play failed — cue kept for retry', phrase.id);
        return;
      }

      this.onSubtitles({
        phase: 'playing',
        sourceText: phrase.sourceText,
        text: phrase.text,
        start: mediaStart,
        end: phrase.mediaEnd ?? phrase.end,
      });

      // Hold SyncEngine slot until audio roughly finishes (prevents next cue pile-up)
      await sleep(Math.min(20000, Math.max(400, remainSec * 1000)));
      if (phrase.id) this._playedCueIds?.add(phrase.id);
      // B23: drop far-behind PCM after confirmed play
      this.#prunePlayedAudioBuffers();
    } finally {
      if (this._activeCueId === phrase.id) this._activeCueId = null;
      release?.();
    }
  }

  #ensureCueAudio(cue) {
    if (!cue) return false;
    if (cue.audioBuffer) return true;
    if (cue.audioBase64) {
      try {
        cue.audioBuffer = base64ToArrayBuffer(cue.audioBase64);
        return !!cue.audioBuffer;
      } catch {
        return false;
      }
    }
    return false;
  }

  #prunePlayedAudioBuffers() {
    const t = this.video?.currentTime || 0;
    for (const c of this.cues || []) {
      if (!c?.audioBuffer) continue;
      const end = c.mediaEnd ?? c.end ?? 0;
      if (this._playedCueIds?.has(c.id) && end < t - 1.5) {
        c.audioBuffer = null;
        // keep audioBase64 for seek-back restore (B29)
      }
    }
  }

  async #playLocalFallback(phrase, vol, rate, offsetSec) {
    if (!this._audioEl) {
      this._audioEl = new Audio();
      this._audioEl.preload = 'auto';
    }
    const el = this._audioEl;
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    el.volume = Math.max(0, Math.min(1, vol));
    el.playbackRate = rate || 1;
    const blob = new Blob([phrase.audioBuffer], {
      type: phrase.contentType || 'audio/mpeg',
    });
    const url = URL.createObjectURL(blob);
    if (this._lastTtsUrl) URL.revokeObjectURL(this._lastTtsUrl);
    this._lastTtsUrl = url;
    el.src = url;
    try {
      if (offsetSec > 0) {
        await new Promise((r) => {
          const d = () => {
            el.removeEventListener('loadedmetadata', d);
            r();
          };
          el.addEventListener('loadedmetadata', d);
          setTimeout(r, 600);
        });
        if (Number.isFinite(el.duration) && offsetSec < el.duration) {
          el.currentTime = offsetSec;
        }
      }
      await el.play();
      return true;
    } catch (e) {
      log.warn('VOD local fallback', e?.message || e);
      return false;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
