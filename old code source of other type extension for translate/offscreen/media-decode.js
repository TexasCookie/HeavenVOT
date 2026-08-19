/**
 * Offscreen media worker for VOD:
 * - download audio from stream URL (or accept base64)
 * - decodeAudioData → mono PCM @ native rate, also 16 kHz view
 * - serve fixed timeline WAV slices for xAI STT
 */

import { MSG } from '../lib/constants.js';
import {
  downsampleTo16k,
  floatTo16BitPCM,
  pcm16ToWavBlob,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  rmsLevel,
} from '../lib/pcm-utils.js';
import { planChunks, chunkPriority } from '../lib/media/audio-chunker.js';
import { isAllowedMediaStreamUrl } from '../lib/media/url-guard.js';

const TARGET_SR = 16000;
const SPEECH_RMS = 0.008;

/** @type {Map<string, Job>} */
const jobs = new Map();

/**
 * @typedef {{
 *   id: string,
 *   float32: Float32Array,
 *   sampleRate: number,
 *   durationSec: number,
 *   mime: string,
 *   plans: { index: number, start: number, end: number }[],
 *   aborted: boolean,
 * }} Job
 */

const MEDIA_BC = 'aethervox-offscreen-media';

/** Prefer BroadcastChannel — SW nested runtime.sendMessage is flaky/broken. */
try {
  const bc = new BroadcastChannel(MEDIA_BC);
  bc.onmessage = async (ev) => {
    const data = ev?.data;
    if (!data || data.channel !== MEDIA_BC || !data.id) return;
    if (data.kind !== 'request') return;
    try {
      const payload = await handle(data.message || {});
      bc.postMessage({
        channel: MEDIA_BC,
        kind: 'response',
        id: data.id,
        payload,
      });
    } catch (e) {
      bc.postMessage({
        channel: MEDIA_BC,
        kind: 'response',
        id: data.id,
        payload: { ok: false, error: String(e?.message || e) },
      });
    }
  };
} catch (e) {
  console.warn('[AetherVox offscreen] BroadcastChannel failed', e);
}

/** TTS playback via WebAudio (reliable under offscreen AUDIO_PLAYBACK) */
let ttsCtx = null;
let ttsGain = null;
let ttsSource = null;
let ttsPlayGen = 0;
let ttsA = null; // legacy HTMLAudio fallback
let ttsUrlA = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (
    type !== MSG.OFFSCREEN_DECODE_AUDIO &&
    type !== 'OFFSCREEN_MEDIA_PREPARE' &&
    type !== 'OFFSCREEN_MEDIA_CHUNK' &&
    type !== 'OFFSCREEN_MEDIA_ABORT' &&
    type !== 'OFFSCREEN_MEDIA_STATUS' &&
    type !== 'OFFSCREEN_MEDIA_DOWNLOAD' &&
    type !== 'OFFSCREEN_PLAY_TTS' &&
    type !== 'OFFSCREEN_STOP_TTS'
  ) {
    return false;
  }
  handle(message)
    .then(sendResponse)
    .catch((e) =>
      sendResponse({ ok: false, error: String(e?.message || e) }),
    );
  return true;
});

async function handle(message) {
  switch (message.type) {
    case MSG.OFFSCREEN_DECODE_AUDIO:
    case 'OFFSCREEN_MEDIA_PREPARE':
      return prepareJob(message);
    case 'OFFSCREEN_MEDIA_CHUNK':
      return sliceChunk(message);
    case 'OFFSCREEN_MEDIA_ABORT':
      return abortJob(message.jobId);
    case 'OFFSCREEN_MEDIA_STATUS':
      return statusJob(message.jobId);
    case 'OFFSCREEN_MEDIA_DOWNLOAD': {
      try {
        const ab = await download(message.streamUrl, {
          referer: message.referer,
          userAgent: message.userAgent || undefined,
        });
        return {
          ok: true,
          base64: arrayBufferToBase64(ab),
          byteLength: ab.byteLength,
        };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    case 'OFFSCREEN_PLAY_TTS':
      return playTts(message);
    case 'OFFSCREEN_STOP_TTS':
      return stopTts();
    default:
      return { ok: false, error: 'unknown offscreen media msg' };
  }
}

async function playTts(message) {
  const gen = ++ttsPlayGen;
  let ab = null;
  if (message.audioBase64) {
    ab = base64ToArrayBuffer(message.audioBase64);
  } else if (message.arrayBuffer) {
    ab = message.arrayBuffer;
  }
  if (!ab || !ab.byteLength) {
    return { ok: false, error: 'no audio payload' };
  }

  const vol = Math.max(
    0,
    Math.min(1, message.volume != null ? Number(message.volume) : 1),
  );
  const rate =
    Number(message.playbackRate) > 0 ? Number(message.playbackRate) : 1;
  /** Seconds into the TTS buffer (sync mid-chunk with video playhead) */
  let offsetSec = Number(message.offsetSec) || 0;
  if (offsetSec < 0) offsetSec = 0;

  // Stop previous source (one voice at a time — no doubles)
  try {
    ttsSource?.stop?.();
  } catch {
    /* ignore */
  }
  ttsSource = null;
  if (ttsA) {
    try {
      ttsA.pause();
    } catch {
      /* ignore */
    }
  }

  try {
    if (!ttsCtx || ttsCtx.state === 'closed') {
      ttsCtx = new AudioContext();
      ttsGain = ttsCtx.createGain();
      ttsGain.connect(ttsCtx.destination);
    }
    if (ttsCtx.state === 'suspended') {
      await ttsCtx.resume();
    }
    ttsGain.gain.value = vol;

    // decodeAudioData detaches buffer — copy first
    const decoded = await ttsCtx.decodeAudioData(ab.slice(0));
    if (gen !== ttsPlayGen) {
      return { ok: true, superseded: true, mode: 'webaudio' };
    }
    const dur = decoded.duration || 0;
    if (offsetSec > 0 && offsetSec >= dur - 0.05) {
      return { ok: true, playing: false, skipped: true, reason: 'past end' };
    }
    const src = ttsCtx.createBufferSource();
    src.buffer = decoded;
    src.playbackRate.value = rate;
    src.connect(ttsGain);
    // start(when, offset) — seek into buffer for playhead sync
    src.start(0, Math.min(offsetSec, Math.max(0, dur - 0.05)));
    ttsSource = src;
    const remain = Math.max(0.1, (dur - offsetSec) / rate);
    return {
      ok: true,
      playing: true,
      mode: 'webaudio',
      duration: dur,
      offsetSec,
      remainSec: remain,
      currentTime: offsetSec,
    };
  } catch (waErr) {
    // Fallback HTMLAudio if decode fails (rare)
    try {
      if (!ttsA) {
        ttsA = new Audio();
        ttsA.preload = 'auto';
      }
      const mime = message.contentType || message.mime || 'audio/mpeg';
      const url = URL.createObjectURL(new Blob([ab], { type: mime }));
      if (ttsUrlA) {
        try {
          URL.revokeObjectURL(ttsUrlA);
        } catch {
          /* ignore */
        }
      }
      ttsUrlA = url;
      ttsA.src = url;
      ttsA.volume = vol;
      ttsA.playbackRate = rate;
      await new Promise((resolve) => {
        const done = () => {
          ttsA.removeEventListener('loadedmetadata', done);
          resolve();
        };
        ttsA.addEventListener('loadedmetadata', done);
        setTimeout(done, 800);
      });
      if (offsetSec > 0 && Number.isFinite(ttsA.duration)) {
        ttsA.currentTime = Math.min(offsetSec, Math.max(0, ttsA.duration - 0.05));
      }
      await ttsA.play();
      await new Promise((r) => setTimeout(r, 100));
      const playing = !ttsA.paused || ttsA.currentTime > 0.01;
      const remain = Number.isFinite(ttsA.duration)
        ? Math.max(0.1, (ttsA.duration - (ttsA.currentTime || 0)) / rate)
        : 2;
      return {
        ok: playing,
        playing,
        mode: 'html-audio',
        currentTime: ttsA.currentTime,
        duration: ttsA.duration,
        offsetSec,
        remainSec: remain,
        waError: String(waErr?.message || waErr),
      };
    } catch (e) {
      return {
        ok: false,
        error: String(e?.message || e),
        waError: String(waErr?.message || waErr),
      };
    }
  }
}

function stopTts() {
  ttsPlayGen += 1;
  try {
    ttsSource?.stop?.();
  } catch {
    /* ignore */
  }
  ttsSource = null;
  if (ttsA) {
    try {
      ttsA.pause();
      ttsA.removeAttribute('src');
      ttsA.load?.();
    } catch {
      /* ignore */
    }
  }
  if (ttsUrlA) {
    try {
      URL.revokeObjectURL(ttsUrlA);
    } catch {
      /* ignore */
    }
    ttsUrlA = null;
  }
  return { ok: true };
}

async function prepareJob(message) {
  const jobId = message.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // abort previous same id
  abortJob(jobId);

  let ab;
  if (message.streamUrl) {
    ab = await download(message.streamUrl, {
      signal: message.signal,
      referer: message.referer || 'https://www.youtube.com/',
      userAgent: message.userAgent || undefined,
    });
  } else if (message.base64) {
    ab = base64ToArrayBuffer(message.base64);
  } else if (message.arrayBuffer) {
    ab = message.arrayBuffer;
  } else {
    return { ok: false, error: 'no streamUrl/base64' };
  }

  const mime = message.mime || 'audio/mp4';
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(ab.slice(0));
  } finally {
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }

  const sr = decoded.sampleRate;
  const length = decoded.length;
  const nCh = decoded.numberOfChannels;
  const mono = new Float32Array(length);
  if (nCh === 1) {
    mono.set(decoded.getChannelData(0));
  } else {
    for (let c = 0; c < nCh; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i] / nCh;
    }
  }

  const durationSec =
    Number.isFinite(decoded.duration) && decoded.duration > 0
      ? decoded.duration
      : Number(message.durationHint) > 0
        ? Number(message.durationHint)
        : 0;

  const chunkSec = Number(message.chunkSec) > 0 ? Number(message.chunkSec) : 10;
  const overlapSec =
    Number(message.overlapSec) >= 0 ? Number(message.overlapSec) : 0.35;
  const plans = planChunks(durationSec, chunkSec, overlapSec);

  /** @type {Job} */
  const job = {
    id: jobId,
    float32: mono,
    sampleRate: sr,
    durationSec,
    mime,
    plans,
    aborted: false,
  };
  jobs.set(jobId, job);
  // B26: keep at most 2 decoded jobs — abort oldest on overflow
  const MAX_JOBS = 2;
  while (jobs.size > MAX_JOBS) {
    let victim = null;
    for (const id of jobs.keys()) {
      if (id !== jobId) {
        victim = id;
        break;
      }
    }
    if (!victim) break;
    abortJob(victim);
  }

  return {
    ok: true,
    jobId,
    durationSec,
    sampleRate: sr,
    chunkCount: plans.length,
    chunkSec,
    overlapSec,
    byteLength: ab.byteLength,
    title: message.title || '',
  };
}

async function sliceChunk(message) {
  const job = jobs.get(message.jobId);
  if (!job || job.aborted) return { ok: false, error: 'job missing' };
  const index = Number(message.index);
  const plan = job.plans.find((p) => p.index === index) || job.plans[index];
  if (!plan) return { ok: false, error: `chunk ${index} out of range` };

  const sr = job.sampleRate;
  const a = Math.max(0, Math.floor(plan.start * sr));
  const b = Math.min(job.float32.length, Math.ceil(plan.end * sr));
  if (b <= a) {
    return {
      ok: true,
      silent: true,
      index: plan.index,
      start: plan.start,
      end: plan.end,
    };
  }
  const slice = job.float32.subarray(a, b);
  const f16 = downsampleTo16k(slice, sr);
  const level = rmsLevel(f16);
  if (level < SPEECH_RMS) {
    return {
      ok: true,
      silent: true,
      level,
      index: plan.index,
      start: plan.start,
      end: plan.end,
    };
  }
  const pcm16 = floatTo16BitPCM(f16);
  const wav = pcm16ToWavBlob(pcm16, TARGET_SR);
  const wavBase64 = arrayBufferToBase64(await wav.arrayBuffer());
  return {
    ok: true,
    silent: false,
    level,
    index: plan.index,
    start: plan.start,
    end: plan.end,
    sampleRate: TARGET_SR,
    wavBase64,
  };
}

function abortJob(jobId) {
  if (!jobId) return { ok: true };
  const job = jobs.get(jobId);
  if (job) {
    job.aborted = true;
    job.float32 = new Float32Array(0);
    jobs.delete(jobId);
  }
  return { ok: true };
}

function statusJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'job missing' };
  return {
    ok: true,
    jobId,
    durationSec: job.durationSec,
    chunkCount: job.plans.length,
    sampleRate: job.sampleRate,
  };
}

async function download(url, opts = {}) {
  if (!isAllowedMediaStreamUrl(url)) {
    throw new Error('offscreen download: url host not allowed');
  }
  const headers = { Accept: '*/*' };
  if (opts.referer) headers.Referer = opts.referer;
  else if (String(url).includes('googlevideo.com')) {
    headers.Referer = 'https://www.youtube.com/';
  }
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
  const res = await fetch(url, {
    method: 'GET',
    credentials: opts.credentials || 'omit',
    headers,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`offscreen download HTTP ${res.status}`);
  return res.arrayBuffer();
}

// expose priority helper for tests / debugging
globalThis.__aethervoxChunkPriority = chunkPriority;

chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_READY }).catch(() => {});
