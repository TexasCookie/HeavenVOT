(function (root) {
  function rms(samples) {
    var list = samples || [];
    if (!list.length) return 0;
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += list[i] * list[i];
    return Math.sqrt(sum / list.length);
  }

  function downsample(input, fromRate, toRate) {
    var src = input || new Float32Array(0);
    var from = Number(fromRate) || 0;
    var to = Number(toRate) || 0;
    if (!src.length || from <= 0 || to <= 0) return new Float32Array(0);
    if (from === to) return src;
    var ratio = from / to;
    var outLen = Math.max(1, Math.floor(src.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var start = Math.floor(i * ratio);
      var end = Math.min(src.length, Math.floor((i + 1) * ratio));
      var acc = 0;
      var n = 0;
      for (var j = start; j < end; j++) {
        acc += src[j];
        n += 1;
      }
      out[i] = n ? acc / n : src[Math.min(start, src.length - 1)];
    }
    return out;
  }

  function mergeFloat32(chunks) {
    var list = chunks || [];
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    var out = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < list.length; j++) {
      out.set(list[j], off);
      off += list[j].length;
    }
    return out;
  }

  function encodeWavPcm16(float32, sampleRate) {
    var samples = float32 || new Float32Array(0);
    var rate = Number(sampleRate) || 16000;
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buf);
    function writeStr(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, n * 2, true);
    var off = 44;
    for (var s = 0; s < n; s++) {
      var clipped = Math.max(-1, Math.min(1, samples[s]));
      view.setInt16(off, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
      off += 2;
    }
    return buf;
  }

  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    var chunk = 0x8000;
    var out = "";
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function jsonLosesArrayBuffer(buffer) {
    try {
      var packed = JSON.parse(JSON.stringify({ audio: buffer }));
      return !(packed.audio && packed.audio.byteLength);
    } catch (err) {
      return true;
    }
  }

  var api = {
    rms: rms,
    downsample: downsample,
    mergeFloat32: mergeFloat32,
    encodeWavPcm16: encodeWavPcm16,
    toBase64: toBase64,
    jsonLosesArrayBuffer: jsonLosesArrayBuffer,
    SILENCE_RMS: 0.004,
  };
  root.LvtAsrAudio = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
