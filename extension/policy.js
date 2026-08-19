(function (root) {
  function playbackRateAllowed(rate) {
    return Math.abs(Number(rate) - 1) < 0.001;
  }

  function originalGain(slider) {
    var value = Number(slider);
    if (Number.isNaN(value)) return 0.25;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function shouldSilenceForAd(adPlaying) {
    return Boolean(adPlaying);
  }

  function sessionActionForRate(rate, sessionLive) {
    if (playbackRateAllowed(rate)) return "continue";
    return sessionLive ? "stop" : "refuse";
  }

  function shouldStartUtterance(start, playhead, paused) {
    if (paused) return false;
    var when = Number(start);
    var now = Number(playhead);
    if (!Number.isFinite(when) || !Number.isFinite(now)) return false;
    if (when > now + 0.15) return false;
    return true;
  }

  function ownedPlayback(tick, mediaPaused, wePaused, enabled, adPlaying) {
    if (!enabled || !tick) return { action: "none", wePaused: Boolean(wePaused) };
    var hostWantsPause = Boolean(tick.pause_player) && tick.reason !== "asr live";
    if (hostWantsPause) {
      if (!mediaPaused) return { action: "pause", wePaused: true };
      return { action: "none", wePaused: Boolean(wePaused) };
    }
    if (wePaused) {
      if (adPlaying) return { action: "none", wePaused: true };
      if (mediaPaused) return { action: "play", wePaused: false };
      return { action: "none", wePaused: false };
    }
    return { action: "none", wePaused: false };
  }

  var api = {
    playbackRateAllowed: playbackRateAllowed,
    originalGain: originalGain,
    shouldSilenceForAd: shouldSilenceForAd,
    sessionActionForRate: sessionActionForRate,
    shouldStartUtterance: shouldStartUtterance,
    ownedPlayback: ownedPlayback,
    defaultOriginalGain: 0.25,
  };

  root.LvtPolicy = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
