import { AUDIO } from '../constants.js';
import { downsampleTo16k, floatTo16BitPCM, mergeFloat32, rmsLevel } from '../pcm-utils.js';
import { log } from '../logger.js';

/** One MediaElementSource per <video> for lifetime of page */
const graphByMedia = new WeakMap();

/** AudioContexts that already loaded the capture worklet module */
const workletReady = new WeakSet();

const WORKLET_NAME = 'pcm-capture-processor';

function workletModuleUrl() {
  try {
    return chrome.runtime.getURL('lib/pipeline/pcm-capture-worklet.js');
  } catch {
    // Fallback if chrome.runtime is unavailable (tests / non-extension)
    return new URL('./pcm-capture-worklet.js', import.meta.url).href;
  }
}

async function ensureCaptureWorklet(ctx) {
  if (workletReady.has(ctx)) return;
  await ctx.audioWorklet.addModule(workletModuleUrl());
  workletReady.add(ctx);
}

/**
 * Capture mono PCM from an HTMLMediaElement without breaking playback.
 * Uses AudioWorkletNode (ScriptProcessorNode is deprecated).
 */
export class VideoAudioCapture {
  /**
   * @param {HTMLMediaElement} media
   * @param {{
   *   onPcmChunk: (float32: Float32Array, meta: object) => void,
   *   onPcmStream?: (pcm16: Uint8Array, meta: object) => void,
   *   onActivity?: () => void,
   *   chunkSec?: number,
   *   overlapSec?: number,
   *   streamFrameSec?: number,
   *   streamOnly?: boolean,
   * }} opts
   */
  constructor(media, opts = {}) {
    this.media = media;
    this.onPcmChunk = opts.onPcmChunk;
    /** Low-latency frames for STT WebSocket (~100ms PCM16 @16k) */
    this.onPcmStream = opts.onPcmStream || null;
    this.onActivity = opts.onActivity;
    this.chunkSec = opts.chunkSec ?? AUDIO.liveChunkSec;
    this.overlapSec = opts.overlapSec ?? AUDIO.chunkOverlapSec;
    this.silenceFlushSec = opts.silenceFlushSec ?? AUDIO.silenceFlushSec;
    this.minSpeechSecBeforeFlush =
      opts.minSpeechSecBeforeFlush ?? AUDIO.minSpeechSecBeforeFlush ?? 0.55;
    this.speechThreshold = opts.speechThreshold ?? 0.012;
    this.streamFrameSec = opts.streamFrameSec ?? AUDIO.streamFrameSec ?? 0.1;
    /**
     * When true, skip REST-style rolling chunks (streaming STT only).
     * When false/hybrid, still emit onPcmChunk for REST fallback.
     */
    this.streamOnly = !!opts.streamOnly;

    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.gain = null;
    this.running = false;
    this.buffer = [];
    this.bufferedSamples = 0;
    this.overlapTail = new Float32Array(0);
    this.silentSamples = 0;
    this._lastActivityEmit = 0;
    this._onWorkletMessage = null;
    /** @type {Float32Array[]} */
    this._streamBuf = [];
    this._streamSamples = 0;
    /** Peak RMS since start — detects silent CORS graphs */
    this.peakRms = 0;
  }

  async start() {
    if (this.running) return;
    // Serialize concurrent start() (auto-recover + user toggle race)
    if (this._startLock) {
      await this._startLock;
      if (this.running) return;
    }
    let releaseLock = () => {};
    this._startLock = new Promise((r) => {
      releaseLock = r;
    });
    try {
      await this.#startInner();
    } finally {
      this._startLock = null;
      releaseLock();
    }
  }

  async #startInner() {
    if (this.running) return;

    let graph = graphByMedia.get(this.media) || this.media.__aethervoxGraph;
    if (!graph) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ sampleRate: 48000 });
      await this.#resumeCtx(ctx);
      let source;
      try {
        source = ctx.createMediaElementSource(this.media);
      } catch (e) {
        const msg = String(e?.message || e);
        if (/already|InvalidState/i.test(msg)) {
          throw new Error(
            'Web Audio уже подключён к этому <video> — обнови вкладку (не CORS/DRM)',
          );
        }
        throw e;
      }
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      graph = { ctx, source, gain, processor: null };
      graphByMedia.set(this.media, graph);
      try {
        this.media.__aethervoxGraph = graph;
      } catch {
        /* ignore */
      }
    } else {
      await this.#resumeCtx(graph.ctx);
    }

    this.ctx = graph.ctx;
    this.source = graph.source;
    this.gain = graph.gain;

    await ensureCaptureWorklet(this.ctx);

    // (Re)attach processor for capture
    if (graph.processor) {
      this.#detachProcessor(graph.processor);
      graph.processor = null;
    }

    // Keep gain → destination so original audio never goes mute on reattach
    try {
      this.source.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.gain.disconnect();
    } catch {
      /* ignore */
    }
    this.source.connect(this.gain);
    this.gain.connect(this.ctx.destination);

    this.processor = new AudioWorkletNode(this.ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
    });
    graph.processor = this.processor;

    this._onWorkletMessage = (ev) => {
      if (!this.running) return;
      const data = ev.data;
      if (!data || data.type !== 'pcm' || !data.samples) return;

      // Resume if Chrome suspended the context mid-session
      if (this.ctx?.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }

      this.#emitActivity();
      this.#pushSamples(data.samples);
    };
    this.processor.port.onmessage = this._onWorkletMessage;
    this.processor.onprocessorerror = (err) => {
      log.warn('AudioWorklet processor error', err);
    };

    // Tap from source (pre-gain) so ducking original volume does not starve STT
    this.source.connect(this.processor);
    // Worklet must be in a live graph; silent output → destination
    this.processor.connect(this.ctx.destination);

    this.running = true;
    this.peakRms = 0;
    this.buffer = [];
    this.bufferedSamples = 0;
    this.overlapTail = new Float32Array(0);
    this.silentSamples = 0;
    this._lastActivityEmit = 0;
    this.#emitActivity(true);
    log.info('Audio capture started', {
      sampleRate: this.ctx.sampleRate,
      state: this.ctx.state,
      backend: 'AudioWorklet',
    });
  } // end #startInner

  #detachProcessor(processor) {
    if (!processor) return;
    try {
      if (this._onWorkletMessage && processor.port) {
        processor.port.onmessage = null;
      }
    } catch {
      /* ignore */
    }
    try {
      processor.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.source?.disconnect(processor);
    } catch {
      /* ignore */
    }
  }

  async #resumeCtx(ctx) {
    if (!ctx) return;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try {
        await ctx.resume();
      } catch (e) {
        log.warn('AudioContext resume failed', e);
      }
    }
  }

  /** Force-resume graph (tab focus / auto-recover). */
  async ensureLive() {
    if (this.ctx) await this.#resumeCtx(this.ctx);
  }

  setOriginalVolume(v) {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Hot-adjust chunk length under lag without restarting the graph */
  setChunkSec(sec) {
    if (typeof sec === 'number' && sec >= 0.8 && sec <= 12) {
      this.chunkSec = sec;
    }
  }

  setSilenceFlushSec(sec) {
    if (typeof sec === 'number' && sec >= 0.25 && sec <= 2) {
      this.silenceFlushSec = sec;
    }
  }

  /** Enable/disable REST chunk emission without restarting graph */
  setStreamOnly(on) {
    this.streamOnly = !!on;
  }

  setStreamHandler(fn) {
    this.onPcmStream = typeof fn === 'function' ? fn : null;
  }

  #emitActivity(force = false) {
    const now = performance.now();
    // Throttle heartbeats so health checks stay cheap
    if (!force && now - this._lastActivityEmit < 500) return;
    this._lastActivityEmit = now;
    try {
      this.onActivity?.();
    } catch {
      /* ignore */
    }
  }

  #pushSamples(floatChunk) {
    const level = rmsLevel(floatChunk);
    if (level > this.peakRms) this.peakRms = level;
    const inputRate = this.ctx.sampleRate;

    // Always feed streaming STT path when handler is set (includes silence for VAD)
    if (this.onPcmStream) {
      this._streamBuf.push(floatChunk);
      this._streamSamples += floatChunk.length;
      const needStream = Math.floor(
        (this.streamFrameSec || 0.1) * inputRate,
      );
      if (this._streamSamples >= needStream) {
        this.#flushStreamFrame();
      }
    }

    // REST rolling chunks (legacy / fallback path)
    if (!this.streamOnly) {
      this.buffer.push(floatChunk);
      this.bufferedSamples += floatChunk.length;

      if (level < this.speechThreshold) {
        this.silentSamples += floatChunk.length;
      } else {
        this.silentSamples = 0;
      }

      const need = Math.floor(this.chunkSec * inputRate);
      const silenceNeed = Math.floor(this.silenceFlushSec * inputRate);
      const minSpeech = Math.floor(
        (this.minSpeechSecBeforeFlush || 0.55) * inputRate,
      );
      // Flush on full window, or end-of-utterance silence after enough speech
      const shouldFlush =
        this.bufferedSamples >= need ||
        (this.bufferedSamples >= minSpeech && this.silentSamples >= silenceNeed);

      if (shouldFlush) this.#flush(false);
    }
  }

  /** Emit ~100ms PCM16@16k for STT WebSocket */
  #flushStreamFrame() {
    if (!this._streamBuf.length || !this.onPcmStream) {
      this._streamBuf = [];
      this._streamSamples = 0;
      return;
    }
    const inputRate = this.ctx.sampleRate;
    const merged = mergeFloat32(this._streamBuf);
    this._streamBuf = [];
    this._streamSamples = 0;
    const down = downsampleTo16k(merged, inputRate);
    if (!down.length) return;
    const pcm16 = floatTo16BitPCM(down);
    const duration = down.length / 16000;
    const mediaTime = this.media.currentTime || 0;
    try {
      this.onPcmStream(pcm16, {
        sampleRate: 16000,
        duration,
        mediaTime,
        start: Math.max(0, mediaTime - duration),
        end: mediaTime,
      });
    } catch (e) {
      log.debug('onPcmStream error', e?.message || e);
    }
  }

  #flush(force) {
    if (!this.buffer.length) return;
    const merged = mergeFloat32(this.buffer);
    const inputRate = this.ctx.sampleRate;

    let withOverlap = merged;
    if (this.overlapTail.length) {
      withOverlap = mergeFloat32([this.overlapTail, merged]);
    }

    const down = downsampleTo16k(withOverlap, inputRate);
    if (!force && rmsLevel(down) < this.speechThreshold * 0.85) {
      this.buffer = [];
      this.bufferedSamples = 0;
      // Keep a short tail so a word right after silence is not cut
      const overlapSamples = Math.floor(this.overlapSec * inputRate);
      this.overlapTail =
        merged.length > overlapSamples
          ? merged.slice(merged.length - overlapSamples)
          : new Float32Array(merged);
      return;
    }

    const pcm16 = floatTo16BitPCM(down);
    const duration = down.length / 16000;
    const start =
      (this.media.currentTime || 0) - duration + (this.overlapTail.length / inputRate || 0) * 0.5;
    const end = this.media.currentTime || start + duration;

    const overlapSamples = Math.floor(this.overlapSec * inputRate);
    this.overlapTail =
      merged.length > overlapSamples
        ? merged.slice(merged.length - overlapSamples)
        : new Float32Array(merged);

    this.buffer = [];
    this.bufferedSamples = 0;
    this.silentSamples = 0;

    this.onPcmChunk?.(down, {
      pcm16,
      sampleRate: 16000,
      start: Math.max(0, start),
      end: Math.max(0, end),
      duration,
      mediaTime: this.media.currentTime || 0,
    });
  }

  async stop() {
    this.running = false;
    try {
      if (this.onPcmStream) this.#flushStreamFrame();
    } catch {
      /* ignore */
    }
    try {
      if (!this.streamOnly) this.#flush(true);
    } catch {
      /* ignore */
    }
    try {
      this.#detachProcessor(this.processor);
    } catch (e) {
      log.warn('capture stop', e);
    }
    // Re-wire media → gain → speakers (processor tap removed)
    try {
      if (this.source && this.gain && this.ctx) {
        try {
          this.source.disconnect();
        } catch {
          /* ignore */
        }
        try {
          this.gain.disconnect();
        } catch {
          /* ignore */
        }
        this.source.connect(this.gain);
        this.gain.connect(this.ctx.destination);
      }
    } catch {
      /* ignore */
    }
    const graph = graphByMedia.get(this.media);
    if (graph) graph.processor = null;
    this.processor = null;
    this._onWorkletMessage = null;
    this.buffer = [];
    this.overlapTail = new Float32Array(0);
    // restore audible original fully when stopping translation
    if (this.gain) this.gain.gain.value = 1;
  }
}
