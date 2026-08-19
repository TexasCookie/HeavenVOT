(function () {
  var asrRec = null;
  var asrTap = null;
  var sharedCtx = null;
  var asrWatch = null;
  var emitted = 0;

  function unlockAudio() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!sharedCtx) sharedCtx = new Ctx();
    if (sharedCtx.state === "suspended") sharedCtx.resume();
    return sharedCtx;
  }

  function helpers() {
    return window.LvtAsrAudio || null;
  }

  function grab() {
    try {
      var player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
      if (player && typeof player.getPlayerResponse === "function") {
        return player.getPlayerResponse();
      }
    } catch (err) {}
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    return null;
  }

  function reply() {
    window.postMessage({ type: "LVT_PLAYER_RESPONSE", payload: grab() }, "*");
  }

  function videoEl() {
    return document.querySelector("video.html5-main-video, ytd-player video, video");
  }

  function status(ok, reason) {
    window.postMessage({ type: "LVT_ASR_STATUS", ok: ok, reason: reason }, "*");
  }

  function emitWav(video, samples, sampleRate) {
    var lib = helpers();
    if (!lib || !samples || !samples.length) return;
    if (video && video.paused) return;
    var level = lib.rms(samples);
    if (level < lib.SILENCE_RMS) {
      emitted += 1;
      window.postMessage({ type: "LVT_ASR_CHUNK", startAt: Math.max(0, (video.currentTime || 0) - 10), rms: level, silent: true }, "*");
      return;
    }
    var pcm = lib.downsample(samples, sampleRate, 16000);
    var wav = lib.encodeWavPcm16(pcm, 16000);
    emitted += 1;
    window.postMessage(
      {
        type: "LVT_ASR_CHUNK",
        startAt: Math.max(0, (video.currentTime || 0) - 10),
        mime: "audio/wav",
        rms: level,
        silent: false,
        buffer: wav,
      },
      "*"
    );
  }

  function attachProcessor(ctx, source, video, hear) {
    var lib = helpers();
    if (!lib) return null;
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    if (hear) source.connect(ctx.destination);
    var pending = [];
    var count = 0;
    var target = Math.floor(ctx.sampleRate * 10);
    proc.onaudioprocess = function (event) {
      var out = event.outputBuffer.getChannelData(0);
      for (var z = 0; z < out.length; z++) out[z] = 0;
      if (!asrTap || !asrTap.running) return;
      if (video.paused) {
        pending = [];
        count = 0;
        return;
      }
      var data = event.inputBuffer.getChannelData(0);
      pending.push(new Float32Array(data));
      count += data.length;
      if (count < target) return;
      var merged = lib.mergeFloat32(pending);
      pending = [];
      count = 0;
      emitWav(video, merged, ctx.sampleRate);
    };
    return { ctx: ctx, source: source, proc: proc, mute: mute, running: true };
  }

  function tapElement(video) {
    if (video.__lvtAsrTap && video.__lvtAsrTap.proc) {
      video.__lvtAsrTap.running = true;
      return video.__lvtAsrTap;
    }
    var ctx = unlockAudio();
    if (!ctx) return null;
    try {
      var src = ctx.createMediaElementSource(video);
      src.connect(ctx.destination);
      var tap = attachProcessor(ctx, src, video, false);
      video.__lvtAsrTap = tap;
      return tap;
    } catch (err) {
      return null;
    }
  }

  function tapCapture(video) {
    var stream = null;
    try {
      if (video.captureStream) stream = video.captureStream();
      else if (video.mozCaptureStream) stream = video.mozCaptureStream();
    } catch (err) {
      return null;
    }
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return null;
    var ctx = unlockAudio();
    if (!ctx) return null;
    try {
      var src = ctx.createMediaStreamSource(stream);
      return attachProcessor(ctx, src, video, false);
    } catch (err) {
      return null;
    }
  }

  function startRecorderFallback(video) {
    var stream;
    try {
      stream = video.captureStream ? video.captureStream() : null;
    } catch (err) {
      stream = null;
    }
    if (!stream || !stream.getAudioTracks().length) {
      status(false, "no-audio");
      return;
    }
    var mime = "";
    var types = ["audio/webm;codecs=opus", "audio/webm"];
    for (var i = 0; i < types.length; i++) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(types[i])) {
        mime = types[i];
        break;
      }
    }
    try {
      asrRec = mime
        ? new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: mime })
        : new MediaRecorder(new MediaStream(stream.getAudioTracks()));
    } catch (err) {
      status(false, "no-recorder");
      return;
    }
    asrRec.ondataavailable = function (event) {
      if (!event.data || event.data.size < 200 || video.paused) return;
      event.data.arrayBuffer().then(function (buf) {
        window.postMessage(
          { type: "LVT_ASR_CHUNK", startAt: Math.max(0, (video.currentTime || 0) - 10), mime: asrRec.mimeType || mime, buffer: buf },
          "*"
        );
      });
    };
    asrRec.start(2000);
    status(true, "recording-fallback");
  }

  function stopAsr() {
    if (asrWatch) {
      clearTimeout(asrWatch);
      asrWatch = null;
    }
    if (asrTap) {
      asrTap.running = false;
      asrTap = null;
    }
    if (asrRec) {
      try {
        asrRec.stop();
      } catch (err) {}
      asrRec = null;
    }
  }

  function startAsr() {
    stopAsr();
    emitted = 0;
    unlockAudio();
    var video = videoEl();
    if (!video) {
      status(false, "no-video");
      return;
    }
    if (!helpers()) {
      status(false, "no-helpers");
      return;
    }
    asrTap = tapElement(video) || tapCapture(video);
    if (asrTap) {
      status(true, "recording-pcm");
      asrWatch = setTimeout(function () {
        if (emitted === 0) startRecorderFallback(video);
      }, 3500);
      return;
    }
    startRecorderFallback(video);
  }

  function sessionPack() {
    if (window.__lvtSession && typeof window.__lvtSession.snapshot === "function") {
      return window.__lvtSession.snapshot();
    }
    var pr = grab();
    var audioUrl = "";
    try {
      var sd = pr && pr.streamingData;
      var list = sd ? (sd.adaptiveFormats || []).concat(sd.formats || []) : [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {};
        if (item.url && String(item.mimeType || "").indexOf("audio/") !== -1) {
          audioUrl = item.url;
          break;
        }
      }
    } catch (err) {}
    return { poToken: "", visitorData: "", audioUrl: audioUrl, audioUrls: audioUrl ? [audioUrl] : [], clientName: "web" };
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.type) return;
    if (event.data.type === "LVT_REQUEST_PLAYER") reply();
    if (event.data.type === "LVT_REQUEST_SESSION") {
      window.postMessage({ type: "LVT_SESSION_PACK", payload: sessionPack() }, "*");
    }
    if (event.data.type === "LVT_ASR_UNLOCK") unlockAudio();
    if (event.data.type === "LVT_ASR_START") startAsr();
    if (event.data.type === "LVT_ASR_STOP") stopAsr();
  });
  reply();
})();
