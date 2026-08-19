/** PCM helpers for STT chunk packaging */

export function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/**
 * PCM16 LE (Uint8Array or Int16Array / ArrayBuffer) → Float32 in [-1, 1].
 * Used by stream-path speaker gender / voice-type detection.
 */
export function pcm16ToFloat32(pcm16) {
  if (!pcm16) return new Float32Array(0);
  let bytes;
  if (pcm16 instanceof ArrayBuffer) {
    bytes = new Uint8Array(pcm16);
  } else if (pcm16 instanceof Uint8Array) {
    bytes = pcm16;
  } else if (pcm16 instanceof Int16Array) {
    const out = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      const s = pcm16[i];
      out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    return out;
  } else if (pcm16.buffer) {
    bytes = new Uint8Array(
      pcm16.buffer,
      pcm16.byteOffset || 0,
      pcm16.byteLength || pcm16.length * 2,
    );
  } else {
    return new Float32Array(0);
  }
  const n = bytes.byteLength >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

/**
 * Downsample to 16 kHz with linear interpolation (less aliasing than nearest).
 * Improves STT on 44.1/48 kHz capture vs pure decimation.
 */
export function downsampleTo16k(float32Array, inputSampleRate) {
  if (inputSampleRate === 16000) return float32Array;
  if (inputSampleRate < 16000) {
    // rare — return as-is, STT will resample
    return float32Array;
  }
  const ratio = inputSampleRate / 16000;
  const newLen = Math.floor(float32Array.length / ratio);
  if (newLen <= 0) return new Float32Array(0);
  const result = new Float32Array(newLen);
  const last = float32Array.length - 1;
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const a = float32Array[idx] || 0;
    const b = float32Array[Math.min(idx + 1, last)] || 0;
    result[i] = a + (b - a) * frac;
  }
  return result;
}

export function mergeFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encode mono PCM16 as a minimal WAV blob for REST STT */
export function pcm16ToWavBlob(pcm16, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm16.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcm16);
  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function rmsLevel(float32Array) {
  if (!float32Array.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32Array.length; i++) {
    const v = float32Array[i];
    sum += v * v;
  }
  return Math.sqrt(sum / float32Array.length);
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
