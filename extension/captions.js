(function (root) {
  function normalizeLang(code) {
    if (!code) return "";
    var token = String(code).trim().toLowerCase().replace("_", "-");
    var primary = token.split("-")[0];
    if (primary === "en" || primary === "eng") return "en";
    if (primary === "ru" || primary === "rus") return "ru";
    return primary;
  }

  function urlHasTlang(url) {
    return /[?&]tlang=/.test(url || "");
  }

  function decodeEntities(text) {
    return String(text || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) {
        return String.fromCharCode(Number(n));
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractTracks(payload) {
    var tracks = ((((payload || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var raw = tracks[i] || {};
      out.push({
        language: normalizeLang(raw.languageCode),
        baseUrl: raw.baseUrl || "",
        kind: raw.kind || "standard",
        isAutoTranslate: urlHasTlang(raw.baseUrl || ""),
      });
    }
    return out;
  }

  function selectSourceTrack(tracks, targetLang) {
    var target = normalizeLang(targetLang);
    var usable = (tracks || []).filter(function (t) {
      return t.baseUrl && !t.isAutoTranslate;
    });
    if (!usable.length) return null;
    var foreignManual = usable.filter(function (t) {
      return t.language !== target && t.kind !== "asr";
    });
    if (foreignManual.length) return foreignManual[0];
    var foreign = usable.filter(function (t) {
      return t.language !== target;
    });
    if (foreign.length) return foreign[0];
    return usable[0];
  }

  function parseXmlTranscript(body, lang) {
    var cues = [];
    var re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    var match;
    while ((match = re.exec(body))) {
      var attrs = match[1];
      var start = Number((/start="([^"]+)"/.exec(attrs) || [])[1] || 0);
      var dur = Number((/dur="([^"]+)"/.exec(attrs) || /duration="([^"]+)"/.exec(attrs) || [])[1] || 0);
      var text = decodeEntities(match[2]);
      if (text) cues.push({ start: start, duration: dur, text: text, lang: lang || "", speaker: 0 });
    }
    return cues;
  }

  function parseJson3(body, lang) {
    var data = JSON.parse(body);
    var events = data.events || [];
    var cues = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i] || {};
      if (!ev.segs) continue;
      var text = ev.segs.map(function (seg) { return seg.utf8 || ""; }).join("");
      text = decodeEntities(text);
      if (!text) continue;
      cues.push({
        start: Number(ev.t || 0) / 1000,
        duration: Number(ev.d || 0) / 1000,
        text: text,
        lang: lang || "",
        speaker: 0,
      });
    }
    return cues;
  }

  function parseTimedtext(body, lang) {
    var text = String(body || "").replace(/^\uFEFF/, "").trim();
    if (!text) return [];
    try {
      if (text[0] === "{" || text[0] === "[") return parseJson3(text, lang);
      return parseXmlTranscript(text, lang);
    } catch (err) {
      return [];
    }
  }

  function timedtextCandidates(videoId, targetLang) {
    var target = normalizeLang(targetLang);
    var langs = ["en", "es", "de", "fr", "it", "pt", "ja", "ko", "zh", "ar", "hi", "pl", "uk", "tr"];
    var out = [];
    langs.forEach(function (lang) {
      if (normalizeLang(lang) === target) return;
      out.push({ language: normalizeLang(lang), url: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=" + lang });
      out.push({ language: normalizeLang(lang), url: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=" + lang + "&kind=asr" });
      out.push({ language: normalizeLang(lang), url: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=" + lang + "&fmt=json3" });
      out.push({ language: normalizeLang(lang), url: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=" + lang + "&kind=asr&fmt=json3" });
    });
    return out;
  }

  function loadByVideoId(videoId, targetLang, fetchText) {
    var list = timedtextCandidates(videoId, targetLang);
    function next(index) {
      if (index >= list.length) {
        return Promise.resolve({ cues: [], sourceLang: "", status: "need_asr" });
      }
      return Promise.resolve(fetchText(list[index].url))
        .then(function (body) {
          var cues = parseTimedtext(body, list[index].language);
          if (cues.length) {
            return { cues: cues, sourceLang: list[index].language, status: "ok" };
          }
          return next(index + 1);
        })
        .catch(function () {
          return next(index + 1);
        });
    }
    return next(0);
  }

  function loadFromPlayer(payload, targetLang, fetchText) {
    var track = selectSourceTrack(extractTracks(payload), targetLang);
    if (!track) {
      return Promise.resolve({ cues: [], sourceLang: "", status: "need_asr" });
    }
    return Promise.resolve(fetchText(track.baseUrl)).then(function (body) {
      var cues = parseTimedtext(body, track.language);
      return {
        cues: cues,
        sourceLang: track.language,
        status: cues.length ? "ok" : "need_asr",
      };
    });
  }

  function pickVideoId(search, playerVideoId, flexyId, initialId) {
    var id = String(playerVideoId || flexyId || initialId || "").trim();
    if (id) return id;
    try {
      return String(new URLSearchParams(search || "").get("v") || "");
    } catch (err) {
      return "";
    }
  }

  var AUDIO_ITAGS = { 139: 1, 140: 1, 141: 1, 249: 1, 250: 1, 251: 1, 599: 1, 600: 1 };

  function isAudioPlaybackUrl(url) {
    var text = String(url || "");
    if (text.indexOf("googlevideo.com") === -1 || text.indexOf("videoplayback") === -1) return false;
    if (/[?&]mime=audio/.test(text)) return true;
    var match = /[?&]itag=(\d+)/.exec(text);
    return !!(match && AUDIO_ITAGS[match[1]]);
  }

  function stripRangeParams(url) {
    return String(url || "")
      .replace(/&range=[^&]*/g, "")
      .replace(/&rn=[^&]*/g, "")
      .replace(/&rbuf=[^&]*/g, "");
  }

  function pickAudioUrl(payload) {
    var sd = (payload || {}).streamingData || {};
    var list = (sd.adaptiveFormats || []).concat(sd.formats || []);
    var fallback = "";
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var url = item.url || "";
      if (!url) continue;
      var mime = String(item.mimeType || item.mime || "");
      var itag = String(item.itag || "");
      if (mime.indexOf("audio/") !== -1 || AUDIO_ITAGS[itag]) {
        if (mime.indexOf("audio/") !== -1) return url;
        fallback = url;
      }
    }
    return fallback;
  }

  function potFromUrl(url) {
    var match = /[?&]pot=([^&]+)/.exec(String(url || ""));
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (err) {
      return match[1];
    }
  }

  function visitorFromPayload(payload) {
    var pr = payload || {};
    var rc = pr.responseContext || {};
    if (rc.visitorData) return String(rc.visitorData);
    var groups = rc.serviceTrackingParams || [];
    for (var i = 0; i < groups.length; i++) {
      var params = (groups[i] && groups[i].params) || [];
      for (var j = 0; j < params.length; j++) {
        var key = String((params[j] && params[j].key) || "");
        if (key === "visitor_data" || key === "visitorData") return String(params[j].value || "");
      }
    }
    return "";
  }

  function collectAudioUrls(payload) {
    var sd = (payload || {}).streamingData || {};
    var list = (sd.adaptiveFormats || []).concat(sd.formats || []);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var url = (list[i] && list[i].url) || "";
      if (!url) continue;
      if (isAudioPlaybackUrl(url) || String((list[i] && list[i].mimeType) || "").indexOf("audio/") !== -1) {
        url = stripRangeParams(url);
        if (out.indexOf(url) === -1) out.push(url);
      }
    }
    return out;
  }

  var api = {
    normalizeLang: normalizeLang,
    urlHasTlang: urlHasTlang,
    extractTracks: extractTracks,
    selectSourceTrack: selectSourceTrack,
    parseTimedtext: parseTimedtext,
    timedtextCandidates: timedtextCandidates,
    pickVideoId: pickVideoId,
    isAudioPlaybackUrl: isAudioPlaybackUrl,
    stripRangeParams: stripRangeParams,
    pickAudioUrl: pickAudioUrl,
    potFromUrl: potFromUrl,
    visitorFromPayload: visitorFromPayload,
    collectAudioUrls: collectAudioUrls,
    loadByVideoId: loadByVideoId,
    loadFromPlayer: loadFromPlayer,
  };
  root.LvtCaptions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
