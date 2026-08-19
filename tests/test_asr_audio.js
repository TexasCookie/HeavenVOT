const assert = require("assert");
const asr = require("../extension/asr-audio.js");

assert.strictEqual(asr.rms(new Float32Array([0, 0, 0])), 0);
assert.ok(asr.rms(new Float32Array([0.5, -0.5, 0.5])) > 0.4);

const merged = asr.mergeFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
assert.deepStrictEqual(Array.from(merged), [1, 2, 3]);

const down = asr.downsample(new Float32Array([1, 1, 3, 3]), 4, 2);
assert.strictEqual(down.length, 2);
assert.strictEqual(down[0], 1);
assert.strictEqual(down[1], 3);

const wav = asr.encodeWavPcm16(new Float32Array(1600), 16000);
const bytes = new Uint8Array(wav);
assert.strictEqual(wav.byteLength, 44 + 1600 * 2);
assert.strictEqual(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), "RIFF");
assert.strictEqual(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]), "WAVE");

assert.strictEqual(asr.jsonLosesArrayBuffer(new ArrayBuffer(32)), true);
assert.ok(asr.toBase64(wav).length > 20);

console.log("asr-audio ok");
