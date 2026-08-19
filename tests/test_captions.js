const assert = require("assert");
const fs = require("fs");
const path = require("path");
const cap = require("../extension/captions.js");

assert.strictEqual(cap.normalizeLang("en-US"), "en");
assert.strictEqual(cap.urlHasTlang("https://www.youtube.com/api/timedtext?v=x&tlang=ru"), true);
assert.strictEqual(cap.urlHasTlang("https://www.youtube.com/api/timedtext?v=x"), false);

const tracks = cap.extractTracks({
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=1", languageCode: "en" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=1&tlang=ru", languageCode: "en" },
      ],
    },
  },
});
assert.strictEqual(cap.pickVideoId("?v=fromurl", "fromplayer", "", ""), "fromplayer");
assert.strictEqual(cap.pickVideoId("?v=fromurl", "", "fromflexy", ""), "fromflexy");
assert.strictEqual(cap.pickVideoId("?v=fromurl", "", "", ""), "fromurl");
assert.strictEqual(
  cap.isAudioPlaybackUrl("https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4"),
  true
);
assert.strictEqual(cap.isAudioPlaybackUrl("https://example.com/videoplayback?itag=140"), false);
assert.strictEqual(
  cap.pickAudioUrl({
    streamingData: {
      adaptiveFormats: [
        { itag: 137, url: "https://x/video", mimeType: "video/mp4" },
        { itag: 140, url: "https://x/audio", mimeType: "audio/mp4" },
      ],
    },
  }),
  "https://x/audio"
);
assert.strictEqual(
  cap.potFromUrl("https://rr.googlevideo.com/videoplayback?itag=140&pot=ABC%2B1&range=0-10"),
  "ABC+1"
);
assert.strictEqual(
  cap.visitorFromPayload({
    responseContext: { visitorData: "CgtVISITOR" },
  }),
  "CgtVISITOR"
);
assert.deepStrictEqual(
  cap.collectAudioUrls({
    streamingData: {
      adaptiveFormats: [
        { url: "https://rr.googlevideo.com/videoplayback?itag=140&range=0-9", mimeType: "audio/mp4" },
      ],
    },
  }),
  ["https://rr.googlevideo.com/videoplayback?itag=140"]
);

const chosen = cap.selectSourceTrack(tracks, "ru");
assert.ok(chosen);
assert.strictEqual(chosen.language, "en");
assert.strictEqual(cap.urlHasTlang(chosen.baseUrl), false);

const xml = '<transcript><text start="1.5" dur="2">Hello&amp; friends</text></transcript>';
const xmlCues = cap.parseTimedtext(xml, "en");
assert.strictEqual(xmlCues[0].text, "Hello& friends");
assert.strictEqual(xmlCues[0].start, 1.5);
assert.strictEqual(xmlCues[0].duration, 2);

const json3 = JSON.stringify({ events: [{ t: 1500, d: 2000, segs: [{ utf8: "Hi" }, { utf8: " there" }] }] });
const jsonCues = cap.parseTimedtext(json3, "en");
assert.strictEqual(jsonCues[0].text, "Hi there");
assert.strictEqual(jsonCues[0].start, 1.5);

cap.loadFromPlayer(
  {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: "http://local/manual", languageCode: "en" }],
      },
    },
  },
  "ru",
  function () {
    return Promise.resolve(xml);
  }
).then(function (loaded) {
  assert.strictEqual(loaded.status, "ok");
  assert.strictEqual(loaded.cues[0].text, "Hello& friends");
  const candidates = cap.timedtextCandidates("abc123", "ru");
  assert.ok(candidates.some(function (item) { return item.url.indexOf("kind=asr") !== -1; }));
  const hook = fs.readFileSync(path.join(__dirname, "..", "extension", "session-hook.js"), "utf8");
  assert.ok(/__lvtSession/.test(hook), "MAIN hook exposes player session");
  assert.ok(/serviceIntegrityDimensions/.test(hook), "MAIN hook reads Innertube PO token");
  assert.ok(/TVHTML5/.test(hook), "MAIN hook asks Innertube as the TV client");
  console.log("captions ok");
});
