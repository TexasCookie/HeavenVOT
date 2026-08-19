(function (root) {
  function planMix(utterances, playhead, originalSlider, adPlaying) {
    var policy = root.LvtPolicy;
    var gain = policy.originalGain(originalSlider);
    if (policy.shouldSilenceForAd(adPlaying)) {
      return { originalGain: gain, play: [] };
    }
    var play = [];
    for (var i = 0; i < utterances.length; i++) {
      var item = utterances[i];
      if (item.start <= playhead + 0.15) {
        play.push({ id: item.id, when: item.start, url: item.audio_path });
      }
    }
    return { originalGain: gain, play: play };
  }

  function attachGraph(video, audioContext, createMediaElementSource) {
    if (!video || !audioContext) {
      throw new Error("missing media graph");
    }
    if (video.__lvtSource) {
      return video.__lvtSource;
    }
    var source = createMediaElementSource(video);
    var gain = audioContext.createGain();
    source.connect(gain);
    gain.connect(audioContext.destination);
    var handle = { source: source, gain: gain, context: audioContext };
    video.__lvtSource = handle;
    return handle;
  }

  function ensureGraph(video, createContext, createSourceWithCtx) {
    if (video && video.__lvtSource) {
      return video.__lvtSource;
    }
    var ctx = createContext();
    return attachGraph(video, ctx, function (el) {
      return createSourceWithCtx(ctx, el);
    });
  }

  function restoreGain(handle, value) {
    if (handle && handle.gain && handle.gain.gain) {
      handle.gain.gain.value = value;
    }
  }

  function stopSources(sources) {
    var list = sources || [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].stop();
      } catch (err) {}
    }
    return [];
  }

  var api = {
    planMix: planMix,
    attachGraph: attachGraph,
    ensureGraph: ensureGraph,
    restoreGain: restoreGain,
    stopSources: stopSources,
  };
  root.LvtMixer = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
