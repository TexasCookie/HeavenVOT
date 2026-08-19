/**
 * AudioWorklet: silent mono tap that posts PCM frames to the main thread.
 * Runs in AudioWorkletGlobalScope (no DOM / chrome.*).
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Keep output silent — this node is a capture tap only
    if (output) {
      for (let c = 0; c < output.length; c++) {
        output[c].fill(0);
      }
    }

    const channel = input?.[0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage({ type: 'pcm', samples: copy }, [copy.buffer]);
    }

    // Keep processor alive for the lifetime of the node
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
