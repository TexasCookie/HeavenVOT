(function () {
  if (window.__lvtSession && window.__lvtSession.ver === 4) return;

  var pot = "";
  var visitor = "";
  var playback = [];
  var ensuring = null;
  var AUDIO_ITAG = /[?&]itag=(139|140|141|249|250|251|599|600)(&|$)/;

  function strip(url) {
    return String(url || "")
      .replace(/&range=[^&]*/g, "")
      .replace(/&rn=[^&]*/g, "")
      .replace(/&rbuf=[^&]*/g, "");
  }

  function remember(url) {
    var text = strip(url);
    if (!text || text.indexOf("videoplayback") === -1 || text.indexOf("googlevideo.com") === -1) return;
    if (playback.indexOf(text) === -1) {
      playback.unshift(text);
      if (playback.length > 12) playback.length = 12;
    }
    var match = /[?&]pot=([^&]+)/.exec(text);
    if (match && match[1]) {
      try {
        pot = decodeURIComponent(match[1]);
      } catch (err) {
        pot = match[1];
      }
    }
  }

  function pullVisitor() {
    if (visitor) return visitor;
    try {
      var cfg = window.ytcfg;
      if (cfg && typeof cfg.get === "function") {
        var ctx = cfg.get("INNERTUBE_CONTEXT");
        if (ctx && ctx.client && ctx.client.visitorData) visitor = String(ctx.client.visitorData);
        if (!visitor) visitor = String(cfg.get("VISITOR_DATA") || "");
      }
    } catch (err) {}
    try {
      if (!visitor && window.yt && yt.config_ && yt.config_.VISITOR_DATA) {
        visitor = String(yt.config_.VISITOR_DATA);
      }
    } catch (err) {}
    return visitor;
  }

  function scanJson(body) {
    if (!body || typeof body !== "string") return;
    if (body.indexOf("poToken") === -1 && body.indexOf("visitorData") === -1) return;
    try {
      var json = JSON.parse(body);
    } catch (err) {
      return;
    }
    var token = json && json.serviceIntegrityDimensions && json.serviceIntegrityDimensions.poToken;
    if (token) pot = String(token);
    var vd = json && json.context && json.context.client && json.context.client.visitorData;
    if (vd) visitor = String(vd);
  }

  function scanPerf() {
    try {
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length; i++) remember(entries[i].name);
    } catch (err) {}
  }

  function pickAudio(urls) {
    for (var i = 0; i < urls.length; i++) {
      var item = urls[i] || "";
      if (/[?&]mime=audio/.test(item) || AUDIO_ITAG.test(item)) return item;
    }
    return urls[0] || "";
  }

  function videoId() {
    try {
      return new URLSearchParams(location.search).get("v") || "";
    } catch (err) {
      return "";
    }
  }

  function pullUrlsFromPlayer(pr) {
    if (!pr || !pr.streamingData) return;
    var sd = pr.streamingData;
    var list = (sd.adaptiveFormats || []).concat(sd.formats || []);
    for (var i = 0; i < list.length; i++) remember((list[i] && list[i].url) || "");
    if (sd.serverAbrStreamingUrl) remember(sd.serverAbrStreamingUrl);
    var rc = pr.responseContext || {};
    if (rc.visitorData) visitor = String(rc.visitorData);
  }

  function fetchAltPlayer() {
    var vid = videoId();
    if (!vid) return Promise.resolve();
    var key = "";
    try {
      key = (window.ytcfg && ytcfg.get && ytcfg.get("INNERTUBE_API_KEY")) || "";
    } catch (err) {}
    var vd = pullVisitor();
    var url = "/youtubei/v1/player?prettyPrint=false";
    if (key) url += "&key=" + encodeURIComponent(key);
    var clients = [
      { name: "TVHTML5", version: "7.20260114.12.00", id: "7" },
      { name: "TVHTML5_SIMPLY", version: "1.0", id: "75" },
      { name: "WEB_EMBEDDED_PLAYER", version: "1.20260115.01.00", id: "56" },
    ];
    function next(index) {
      if (index >= clients.length) return Promise.resolve();
      var client = clients[index];
      var body = {
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            hl: "en",
            visitorData: vd,
          },
        },
        videoId: vid,
        playbackContext: { contentPlaybackContext: { html5Preference: "HTML5" } },
        contentCheckOk: true,
        racyCheckOk: true,
      };
      var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ac ? setTimeout(function () { ac.abort(); }, 8000) : null;
      return fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": client.id,
          "X-YouTube-Client-Version": client.version,
          "X-Goog-Visitor-Id": vd,
        },
        body: JSON.stringify(body),
        signal: ac ? ac.signal : undefined,
      }).finally(function () {
        if (timer) clearTimeout(timer);
      })
        .then(function (res) {
          return res.json();
        })
        .then(function (pr) {
          pullUrlsFromPlayer(pr);
          if (playback.length) return;
          return next(index + 1);
        })
        .catch(function () {
          return next(index + 1);
        });
    }
    return next(0);
  }

  function snapshot() {
    pullVisitor();
    scanPerf();
    try {
      var player = document.getElementById("movie_player");
      if (player && player.getPlayerResponse) pullUrlsFromPlayer(player.getPlayerResponse());
      else pullUrlsFromPlayer(window.ytInitialPlayerResponse);
    } catch (err) {}
    var urls = playback.slice();
    return {
      poToken: pot,
      visitorData: visitor || pullVisitor(),
      audioUrl: pickAudio(urls),
      audioUrls: urls,
      clientName: "web",
    };
  }

  function ensure() {
    snapshot();
    if (ensuring) return ensuring;
    ensuring = fetchAltPlayer()
      .then(function () {
        ensuring = null;
        return snapshot();
      })
      .catch(function () {
        ensuring = null;
        return snapshot();
      });
    return ensuring;
  }

  function hook() {
    if (window.__lvtNetHook) return;
    window.__lvtNetHook = true;
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          var url = typeof input === "string" ? input : input && input.url;
          remember(url);
          var body = init && init.body;
          if (typeof body === "string") scanJson(body);
        } catch (err) {}
        return origFetch.apply(this, arguments).then(function (res) {
          try {
            remember(res && res.url);
          } catch (err) {}
          return res;
        });
      };
    }
    if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__lvtUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        try {
          remember(this.__lvtUrl || "");
          if (typeof body === "string") scanJson(body);
        } catch (err) {}
        return origSend.apply(this, arguments);
      };
    }
  }

  hook();
  window.__lvtSession = {
    ver: 4,
    snapshot: snapshot,
    remember: remember,
    ensure: ensure,
  };
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;
    if (event.data.type === "LVT_REQUEST_SESSION") {
      ensure().then(function (pack) {
        window.postMessage({ type: "LVT_SESSION_PACK", payload: pack }, "*");
      });
    }
  });
})();
