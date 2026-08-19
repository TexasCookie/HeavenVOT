/**
 * Speaker gender + voice-type estimation from mono PCM.
 *
 * Features:
 *  - short-time autocorrelation F0 (fundamental frequency)
 *  - spectral brightness / ZCR (helps tenor↔alto and soft↔bright)
 *  - hysteresis lock so TTS gender never flips mid-session on noise
 *
 * Voice types (classical register bands) map 1:1 onto Grok TTS timbres
 * so the dub matches the original author as closely as possible without
 * ♂/♀ mismatch.
 *
 * Not a biometric classifier — optimized for voice-over pairing.
 */

import { rmsLevel } from './pcm-utils.js';

/** @typedef {'female'|'male'} SpeakerGender */
/**
 * Main voice types for TTS matching (register + gender):
 * male: bass | baritone | tenor
 * female: alto | mezzo | soprano
 * @typedef {'bass'|'baritone'|'tenor'|'alto'|'mezzo'|'soprano'} VoiceType
 */

// Typical adult F0: male ~85–155 Hz, female ~165–255 Hz.
// Finer register bands for voice-type match (not only binary gender).
const F0_BASS_MAX = 108;
const F0_BARITONE_MAX = 148;
const F0_TENOR_MAX = 170; // upper male / ambiguous with alto
const F0_ALTO_MAX = 205;
const F0_MEZZO_MAX = 248;
// above → soprano

const F0_MALE_MAX = 155;
const F0_FEMALE_MIN = 175;
const F0_MIN = 70;
const F0_MAX = 380;

const FRAME_MS = 40;
const HOP_MS = 20;
const MIN_VOICED_FRAMES_PER_CHUNK = 3;
/** Need more evidence before locking — false ♀-on-♂ is worse than a short wait */
const MIN_SAMPLES_TO_LOCK = 7;
const CONFIDENCE_LOCK = 0.66;
/** Female lock needs extra confidence (autocorr often doubles male F0 → fake ♀) */
const CONFIDENCE_LOCK_FEMALE = 0.74;
const MIN_SAMPLES_LOCK_FEMALE = 9;

/** Ordered male → female for nearest-type fallback */
export const VOICE_TYPE_ORDER = /** @type {VoiceType[]} */ ([
  'bass',
  'baritone',
  'tenor',
  'alto',
  'mezzo',
  'soprano',
]);

/**
 * Gender of a voice type (always defined for known types).
 * @param {VoiceType|string|null|undefined} voiceType
 * @returns {SpeakerGender|null}
 */
export function genderFromVoiceType(voiceType) {
  switch (voiceType) {
    case 'bass':
    case 'baritone':
    case 'tenor':
      return 'male';
    case 'alto':
    case 'mezzo':
    case 'soprano':
      return 'female';
    default:
      return null;
  }
}

/**
 * Lightweight spectral cues (no FFT — content-script friendly).
 * brightness: high-pass energy / total energy (first-diff proxy).
 * zcr: zero-crossing rate (higher → brighter / noisier).
 * @param {Float32Array} float32
 * @returns {{ brightness: number, zcr: number }}
 */
export function estimateSpectralCues(float32) {
  if (!float32?.length || float32.length < 32) {
    return { brightness: 0, zcr: 0 };
  }
  let eTotal = 0;
  let eHigh = 0;
  let zc = 0;
  let prev = float32[0];
  eTotal += prev * prev;
  for (let i = 1; i < float32.length; i++) {
    const v = float32[i];
    eTotal += v * v;
    const d = v - prev;
    eHigh += d * d;
    if ((v >= 0) !== (prev >= 0)) zc += 1;
    prev = v;
  }
  const brightness = eTotal > 1e-12 ? Math.min(4, eHigh / eTotal) : 0;
  const zcr = zc / float32.length;
  return { brightness, zcr };
}

/**
 * Estimate median fundamental frequency (Hz) of voiced frames in a mono buffer.
 * @param {Float32Array} float32
 * @param {number} [sampleRate=16000]
 * @returns {{
 *   f0: number|null,
 *   voicedFrames: number,
 *   rms: number,
 *   brightness: number,
 *   zcr: number,
 * }}
 */
/**
 * Normalized autocorrelation at lag (frame already mean-centered via `mean`).
 * @param {Float32Array} float32
 * @param {number} start
 * @param {number} frameSize
 * @param {number} mean
 * @param {number} r0
 * @param {number} lag
 */
function acorrAt(float32, start, frameSize, mean, r0, lag) {
  if (lag <= 0 || lag >= frameSize - 2 || r0 < 1e-10) return 0;
  let sum = 0;
  let e1 = 0;
  let e2 = 0;
  const n = frameSize - lag;
  for (let i = 0; i < n; i++) {
    const a = float32[start + i] - mean;
    const b = float32[start + i + lag] - mean;
    sum += a * b;
    e1 += a * a;
    e2 += b * b;
  }
  const den = Math.sqrt(e1 * e2);
  return den > 1e-10 ? sum / den : 0;
}

/**
 * Prefer true F0 over 2× harmonic (common ♂→fake ♀ failure on compressed video).
 * If best peak looks like an octave of a strong subharmonic in the male band, halve it.
 * @param {number} f0
 * @param {number} bestCorr
 * @param {(lag: number) => number} corrAt
 * @param {number} sampleRate
 * @param {number} minLag
 * @param {number} maxLag
 */
function correctOctaveF0(f0, bestCorr, corrAt, sampleRate, minLag, maxLag) {
  if (!Number.isFinite(f0) || f0 < 150) return f0;
  // Candidate true fundamental at ~f0/2 (octave down)
  const half = f0 * 0.5;
  if (half < F0_MIN || half > F0_MALE_MAX + 25) return f0;
  const halfLag = Math.round(sampleRate / half);
  if (halfLag < minLag || halfLag > maxLag) return f0;
  const halfCorr = corrAt(halfLag);
  // Accept half if correlation is almost as strong (subharmonic present)
  if (halfCorr >= Math.max(0.28, bestCorr * 0.72)) {
    return half;
  }
  // Also scan ±2 samples around halfLag for a slightly better peak
  let bestHalf = halfCorr;
  let bestHalfLag = halfLag;
  for (let d = -2; d <= 2; d++) {
    const lag = halfLag + d;
    if (lag < minLag || lag > maxLag) continue;
    const c = corrAt(lag);
    if (c > bestHalf) {
      bestHalf = c;
      bestHalfLag = lag;
    }
  }
  if (bestHalf >= Math.max(0.28, bestCorr * 0.72)) {
    return sampleRate / bestHalfLag;
  }
  return f0;
}

export function estimatePitchHz(float32, sampleRate = 16000) {
  const spectral = estimateSpectralCues(float32);
  if (!float32?.length || sampleRate < 8000) {
    return { f0: null, voicedFrames: 0, rms: 0, ...spectral };
  }

  const rms = rmsLevel(float32);
  if (rms < 0.008) {
    return { f0: null, voicedFrames: 0, rms, ...spectral };
  }

  const frameSize = Math.max(64, Math.floor((sampleRate * FRAME_MS) / 1000));
  const hop = Math.max(32, Math.floor((sampleRate * HOP_MS) / 1000));
  const minLag = Math.floor(sampleRate / F0_MAX);
  const maxLag = Math.min(frameSize - 2, Math.floor(sampleRate / F0_MIN));
  if (maxLag <= minLag + 2) {
    return { f0: null, voicedFrames: 0, rms, ...spectral };
  }

  const pitches = [];
  const energyGate = Math.max(0.00002, rms * rms * 0.15);

  for (let start = 0; start + frameSize <= float32.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = float32[start + i];
      energy += v * v;
    }
    energy /= frameSize;
    if (energy < energyGate) continue;

    // Mean-center frame for cleaner autocorrelation
    let mean = 0;
    for (let i = 0; i < frameSize; i++) mean += float32[start + i];
    mean /= frameSize;

    let r0 = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = float32[start + i] - mean;
      r0 += v * v;
    }
    if (r0 < 1e-10) continue;

    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const corr = acorrAt(float32, start, frameSize, mean, r0, lag);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    // Voiced frames need a clear periodic peak
    if (bestLag > 0 && bestCorr >= 0.35) {
      let f0 = sampleRate / bestLag;
      const corrAt = (lag) => acorrAt(float32, start, frameSize, mean, r0, lag);
      f0 = correctOctaveF0(f0, bestCorr, corrAt, sampleRate, minLag, maxLag);
      pitches.push(f0);
    }
  }

  if (pitches.length < MIN_VOICED_FRAMES_PER_CHUNK) {
    return { f0: null, voicedFrames: pitches.length, rms, ...spectral };
  }

  pitches.sort((a, b) => a - b);
  const mid = pitches[Math.floor(pitches.length / 2)];
  return { f0: mid, voicedFrames: pitches.length, rms, ...spectral };
}

/**
 * Map F0 to gender label; null if ambiguous.
 * @param {number} f0
 * @returns {SpeakerGender|null}
 */
export function genderFromF0(f0) {
  if (!Number.isFinite(f0) || f0 <= 0) return null;
  if (f0 <= F0_MALE_MAX) return 'male';
  if (f0 >= F0_FEMALE_MIN) return 'female';
  return null;
}

/**
 * Classify main voice type from F0 + spectral cues.
 * Uses brightness/ZCR in the tenor↔alto transition band to avoid gender mismatch.
 *
 * @param {number} f0
 * @param {{ brightness?: number, zcr?: number }} [cues]
 * @returns {{ gender: SpeakerGender|null, voiceType: VoiceType|null, ambiguous: boolean }}
 */
export function classifyVoiceType(f0, cues = {}) {
  if (!Number.isFinite(f0) || f0 <= 0) {
    return { gender: null, voiceType: null, ambiguous: true };
  }

  const brightness = Number(cues.brightness) || 0;
  const zcr = Number(cues.zcr) || 0;
  // Empirically: brighter / higher ZCR leans female in mid-band; darker → male
  const brightLean =
    brightness > 0.55 || zcr > 0.12 ? 1 : brightness < 0.28 && zcr < 0.07 ? -1 : 0;

  // Clear low male registers
  if (f0 <= F0_BASS_MAX) {
    return { gender: 'male', voiceType: 'bass', ambiguous: false };
  }
  if (f0 <= F0_BARITONE_MAX) {
    return { gender: 'male', voiceType: 'baritone', ambiguous: false };
  }

  // Tenor / alto transition (~148–175 Hz) — highest mismatch risk
  if (f0 <= F0_TENOR_MAX) {
    // Strong low pitch + dark spectrum → tenor male
    if (f0 <= 158 && brightLean <= 0) {
      return { gender: 'male', voiceType: 'tenor', ambiguous: f0 > 155 };
    }
    // Higher pitch + bright spectrum → alto female (still mark ambiguous —
    // residual octave-error risk after correction)
    if (f0 >= 162 && brightLean > 0) {
      return { gender: 'female', voiceType: 'alto', ambiguous: true };
    }
    // Mid ambiguous: use F0 + soft spectral bias
    if (f0 < 160 || (f0 < 165 && brightLean < 0)) {
      return { gender: 'male', voiceType: 'tenor', ambiguous: true };
    }
    if (f0 >= 168 && brightLean > 0) {
      return { gender: 'female', voiceType: 'alto', ambiguous: true };
    }
    // Default male in classic male upper band to avoid ♀-on-♂ mismatch
    return { gender: 'male', voiceType: 'tenor', ambiguous: true };
  }

  // Low-alto band still risky (male harmonic residue ~170–195 Hz)
  if (f0 <= 195) {
    if (brightLean < 0) {
      return { gender: 'male', voiceType: 'tenor', ambiguous: true };
    }
    if (brightLean > 0 && f0 >= 185) {
      return { gender: 'female', voiceType: 'alto', ambiguous: true };
    }
    // Neutral spectrum in 170–195: prefer male (false ♀ hurts more)
    return { gender: 'male', voiceType: 'tenor', ambiguous: true };
  }

  // Clearer female registers
  if (f0 <= F0_ALTO_MAX) {
    return { gender: 'female', voiceType: 'alto', ambiguous: f0 < 200 };
  }
  if (f0 <= F0_MEZZO_MAX) {
    return { gender: 'female', voiceType: 'mezzo', ambiguous: false };
  }
  // High / child-like → soprano TTS (still female; never map to male)
  return { gender: 'female', voiceType: 'soprano', ambiguous: f0 > 320 };
}

/**
 * Rolling tracker: accumulates pitch + spectral evidence across chunks,
 * locks gender/type for stable TTS selection.
 */
export class SpeakerGenderTracker {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {number[]} */
    this._f0Samples = [];
    /** @type {number[]} */
    this._brightnessSamples = [];
    /** @type {Record<VoiceType, number>} */
    this._typeVotes = {
      bass: 0,
      baritone: 0,
      tenor: 0,
      alto: 0,
      mezzo: 0,
      soprano: 0,
    };
    /** @type {SpeakerGender|null} */
    this.gender = null;
    /** @type {VoiceType|null} */
    this.voiceType = null;
    this.confidence = 0;
    this.locked = false;
    this.chunksObserved = 0;
    this.voicedChunks = 0;
    this.lastF0 = null;
    this.lastBrightness = null;
    this._maleVotes = 0;
    this._femaleVotes = 0;
  }

  /**
   * @param {Float32Array} float32
   * @param {number} [sampleRate=16000]
   * @returns {{
   *   gender: SpeakerGender|null,
   *   voiceType: VoiceType|null,
   *   confidence: number,
   *   f0: number|null,
   *   brightness: number|null,
   *   locked: boolean,
   *   changed: boolean,
   * }}
   */
  observe(float32, sampleRate = 16000) {
    this.chunksObserved += 1;
    const prevGender = this.gender;
    const prevType = this.voiceType;
    const { f0, voicedFrames, brightness, zcr } = estimatePitchHz(float32, sampleRate);

    if (f0 != null && voicedFrames >= MIN_VOICED_FRAMES_PER_CHUNK) {
      this.voicedChunks += 1;
      this.lastF0 = f0;
      this.lastBrightness = brightness;
      this._f0Samples.push(f0);
      this._brightnessSamples.push(brightness);
      if (this._f0Samples.length > 40) this._f0Samples.shift();
      if (this._brightnessSamples.length > 40) this._brightnessSamples.shift();

      const classified = classifyVoiceType(f0, { brightness, zcr });
      // Ambiguous chunks get lower weight so clear frames dominate
      const w = classified.ambiguous ? 0.45 : 1;

      if (classified.gender === 'male') this._maleVotes += w;
      else if (classified.gender === 'female') this._femaleVotes += w;

      if (classified.voiceType && this._typeVotes[classified.voiceType] != null) {
        this._typeVotes[classified.voiceType] += w;
      }

      // Soft mid-band gender votes when classifier returns null (shouldn't often)
      if (!classified.gender) {
        if (f0 < (F0_MALE_MAX + F0_FEMALE_MIN) / 2) this._maleVotes += 0.35;
        else this._femaleVotes += 0.35;
      }

      this.#recompute();
    }

    const changed =
      (prevGender !== this.gender && this.gender != null) ||
      (prevType !== this.voiceType && this.voiceType != null);

    return {
      gender: this.gender,
      voiceType: this.voiceType,
      confidence: this.confidence,
      f0: this.lastF0,
      brightness: this.lastBrightness,
      locked: this.locked,
      changed,
    };
  }

  #recompute() {
    const total = this._maleVotes + this._femaleVotes;
    if (total < 0.5 || this._f0Samples.length === 0) {
      this.gender = null;
      this.voiceType = null;
      this.confidence = 0;
      this.locked = false;
      return;
    }

    const femaleShare = this._femaleVotes / total;
    const maleShare = this._maleVotes / total;
    const median = this.#medianF0();
    const medBright = this.#medianBrightness();

    let nextGender = null;
    let conf = 0;
    // Slightly asymmetric thresholds: require clearer majority for female
    // (protects against octave-doubled male F0 flooding ♀ votes)
    if (femaleShare >= 0.6 && femaleShare >= maleShare + 0.08) {
      nextGender = 'female';
      conf = femaleShare;
    } else if (maleShare >= 0.52) {
      nextGender = 'male';
      conf = maleShare;
    }

    // Reinforce with median F0 + spectral when votes are close
    if (!nextGender && median != null) {
      const c = classifyVoiceType(median, { brightness: medBright ?? 0 });
      nextGender = c.gender;
      conf = c.ambiguous ? 0.52 : 0.58;
    }

    // Median F0 hard gate: clear low pitch never locks as female
    if (nextGender === 'female' && median != null && median <= F0_MALE_MAX) {
      nextGender = 'male';
      conf = Math.max(conf, 0.62);
    }
    // Very high median with dark spectrum → likely harmonic, prefer male
    if (
      nextGender === 'female' &&
      median != null &&
      median <= 210 &&
      (medBright ?? 1) < 0.3
    ) {
      nextGender = 'male';
      conf = Math.max(0.55, conf * 0.9);
    }

    // Hysteresis: once locked, require stronger contrary evidence (anti-mismatch)
    if (this.locked && this.gender && nextGender && nextGender !== this.gender) {
      // Flipping male→female is harder (false ♀ is the main complaint)
      const need =
        this.gender === 'male' && nextGender === 'female' ? 0.86 : 0.78;
      if (conf < need || this._f0Samples.length < MIN_SAMPLES_TO_LOCK + 4) {
        nextGender = this.gender;
        conf = Math.max(this.confidence, 0.7);
      }
    }

    this.gender = nextGender;
    this.confidence = nextGender ? Math.min(0.99, conf) : 0;

    const prevType = this.voiceType;
    // Pick voice type among types that match locked gender
    let nextType = nextGender
      ? this.#bestVoiceTypeForGender(nextGender, median, medBright)
      : null;

    // Type hysteresis when already locked: keep previous type unless a clear winner
    if (
      this.locked &&
      prevType &&
      nextType &&
      prevType !== nextType &&
      genderFromVoiceType(prevType) === nextGender
    ) {
      const prevVotes = this._typeVotes[prevType] || 0;
      const nextVotes = this._typeVotes[nextType] || 0;
      if (nextVotes < prevVotes * 1.35) {
        nextType = prevType;
      }
    }

    this.voiceType = nextType;

    const minSamples =
      nextGender === 'female' ? MIN_SAMPLES_LOCK_FEMALE : MIN_SAMPLES_TO_LOCK;
    const confNeed =
      nextGender === 'female' ? CONFIDENCE_LOCK_FEMALE : CONFIDENCE_LOCK;
    this.locked =
      !!nextGender &&
      this._f0Samples.length >= minSamples &&
      this.confidence >= confNeed;
  }

  /**
   * @param {SpeakerGender} gender
   * @param {number|null} medianF0
   * @param {number|null} medBright
   * @returns {VoiceType|null}
   */
  #bestVoiceTypeForGender(gender, medianF0, medBright) {
    const allowed =
      gender === 'male'
        ? /** @type {VoiceType[]} */ (['bass', 'baritone', 'tenor'])
        : /** @type {VoiceType[]} */ (['alto', 'mezzo', 'soprano']);

    let best = null;
    let bestScore = -1;
    for (const t of allowed) {
      const s = this._typeVotes[t] || 0;
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }

    // If votes weak, derive from median F0
    if (bestScore < 0.8 && medianF0 != null) {
      const c = classifyVoiceType(medianF0, { brightness: medBright ?? 0 });
      if (c.voiceType && genderFromVoiceType(c.voiceType) === gender) {
        return c.voiceType;
      }
      // Force type from F0 within gender band
      if (gender === 'male') {
        if (medianF0 <= F0_BASS_MAX) return 'bass';
        if (medianF0 <= F0_BARITONE_MAX) return 'baritone';
        return 'tenor';
      }
      if (medianF0 <= F0_ALTO_MAX) return 'alto';
      if (medianF0 <= F0_MEZZO_MAX) return 'mezzo';
      return 'soprano';
    }

    return best;
  }

  #medianF0() {
    if (!this._f0Samples.length) return null;
    const a = [...this._f0Samples].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  #medianBrightness() {
    if (!this._brightnessSamples.length) return null;
    const a = [...this._brightnessSamples].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  /**
   * Gender only when confident enough for TTS selection.
   * @returns {SpeakerGender|null}
   */
  getReliableGender() {
    if (!this.gender) return null;
    if (this.locked) return this.gender;
    if (this.confidence >= 0.7 && this._f0Samples.length >= 3) return this.gender;
    return null;
  }

  /**
   * Voice type when gender is reliable (type may still refine later).
   * @returns {VoiceType|null}
   */
  getReliableVoiceType() {
    if (!this.getReliableGender()) return null;
    if (this.voiceType && genderFromVoiceType(this.voiceType) === this.gender) {
      return this.voiceType;
    }
    return null;
  }

  /**
   * Combined reliable profile for TTS.
   * @returns {{ gender: SpeakerGender, voiceType: VoiceType|null }|null}
   */
  getReliableProfile() {
    const gender = this.getReliableGender();
    if (!gender) return null;
    return {
      gender,
      voiceType: this.getReliableVoiceType(),
    };
  }

  snapshot() {
    return {
      gender: this.gender,
      voiceType: this.voiceType,
      reliable: this.getReliableGender(),
      reliableVoiceType: this.getReliableVoiceType(),
      confidence: this.confidence,
      locked: this.locked,
      lastF0: this.lastF0,
      medianF0: this.#medianF0(),
      medianBrightness: this.#medianBrightness(),
      lastBrightness: this.lastBrightness,
      voicedChunks: this.voicedChunks,
      chunksObserved: this.chunksObserved,
      samples: this._f0Samples.length,
      typeVotes: { ...this._typeVotes },
    };
  }
}

/**
 * Human-readable gender label for UI toasts.
 * @param {SpeakerGender|null|undefined} g
 */
export function genderLabelRu(g) {
  if (g === 'female') return 'женский';
  if (g === 'male') return 'мужской';
  return 'не определён';
}

/**
 * Human-readable voice type label (RU).
 * @param {VoiceType|null|undefined} t
 */
export function voiceTypeLabelRu(t) {
  switch (t) {
    case 'bass':
      return 'бас (низкий ♂)';
    case 'baritone':
      return 'баритон (средний ♂)';
    case 'tenor':
      return 'тенор (высокий ♂)';
    case 'alto':
      return 'альт (низкий ♀)';
    case 'mezzo':
      return 'меццо (средний ♀)';
    case 'soprano':
      return 'сопрано (высокий ♀)';
    default:
      return 'тип не определён';
  }
}

/**
 * Compact label: "баритон ♂" / "меццо ♀"
 * @param {VoiceType|null|undefined} t
 * @param {SpeakerGender|null|undefined} [gender]
 */
export function voiceProfileLabelRu(t, gender) {
  const g = gender || genderFromVoiceType(t);
  const mark = g === 'female' ? '♀' : g === 'male' ? '♂' : '?';
  if (!t) return genderLabelRu(g);
  const short = {
    bass: 'бас',
    baritone: 'баритон',
    tenor: 'тенор',
    alto: 'альт',
    mezzo: 'меццо',
    soprano: 'сопрано',
  }[t];
  return short ? `${short} ${mark}` : genderLabelRu(g);
}
