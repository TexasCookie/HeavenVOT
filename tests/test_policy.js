const assert = require("assert");
const policy = require("../extension/policy.js");
const mixer = require("../extension/mixer.js");

assert.strictEqual(policy.playbackRateAllowed(1), true);
assert.strictEqual(policy.playbackRateAllowed(1.25), false);
assert.strictEqual(policy.sessionActionForRate(1.5, false), "refuse");
assert.strictEqual(policy.sessionActionForRate(1.5, true), "stop");
assert.strictEqual(policy.originalGain(0.25), 0.25);
assert.strictEqual(policy.originalGain(2), 1);
assert.strictEqual(policy.shouldSilenceForAd(true), true);
assert.strictEqual(policy.shouldSilenceForAd(false), false);

const userPaused = policy.ownedPlayback({ pause_player: false, reason: "asr live" }, true, false, true, false);
assert.strictEqual(userPaused.action, "none");
assert.strictEqual(userPaused.wePaused, false);

const weMustPause = policy.ownedPlayback({ pause_player: true, reason: "waiting for start buffer" }, false, false, true, false);
assert.strictEqual(weMustPause.action, "pause");
assert.strictEqual(weMustPause.wePaused, true);

const resumeOurs = policy.ownedPlayback({ pause_player: false, reason: "" }, true, true, true, false);
assert.strictEqual(resumeOurs.action, "play");
assert.strictEqual(resumeOurs.wePaused, false);

const holdDuringAd = policy.ownedPlayback({ pause_player: false, reason: "" }, true, true, true, true);
assert.strictEqual(holdDuringAd.action, "none");
assert.strictEqual(holdDuringAd.wePaused, true);

const asrLiveFlag = policy.ownedPlayback({ pause_player: true, reason: "asr live" }, false, false, true, false);
assert.strictEqual(asrLiveFlag.action, "none");

assert.strictEqual(policy.shouldStartUtterance(10, 10.1, false), true);
assert.strictEqual(policy.shouldStartUtterance(10, 10.1, true), false);
assert.strictEqual(policy.shouldStartUtterance(10, 20, false), true);
assert.strictEqual(policy.shouldStartUtterance(12, 10, false), false);

const plan = mixer.planMix(
  [
    { id: "a", start: 0.0, audio_path: "/v1/audio/a" },
    { id: "b", start: 20.0, audio_path: "/v1/audio/b" },
  ],
  0.0,
  0.3,
  false
);
assert.strictEqual(plan.originalGain, 0.3);
assert.strictEqual(plan.play.length, 1);
assert.strictEqual(plan.play[0].id, "a");

const silenced = mixer.planMix([{ id: "a", start: 0.0, audio_path: "/x" }], 0, 0.3, true);
assert.strictEqual(silenced.play.length, 0);

const video = {};
const ctx = {
  destination: {},
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  },
};
let created = 0;
function createSource() {
  created += 1;
  return { connect() {} };
}
const first = mixer.attachGraph(video, ctx, createSource);
const second = mixer.attachGraph(video, ctx, function () {
  throw new Error("must not create a second MediaElementSource");
});
assert.strictEqual(first, second);
assert.strictEqual(created, 1);
mixer.restoreGain(first, 1);
assert.strictEqual(first.gain.gain.value, 1);

let ctxBuilt = 0;
const reused = mixer.ensureGraph(
  video,
  function () {
    ctxBuilt += 1;
    throw new Error("must not build another AudioContext");
  },
  function () {
    throw new Error("must not create source");
  }
);
assert.strictEqual(reused, first);
assert.strictEqual(ctxBuilt, 0);

const other = {};
const ensured = mixer.ensureGraph(
  other,
  function () {
    ctxBuilt += 1;
    return ctx;
  },
  function (_ctx, _el) {
    return { connect() {} };
  }
);
assert.strictEqual(ctxBuilt, 1);
assert.ok(ensured.gain);

const dummy = {
  stopped: false,
  stop() {
    this.stopped = true;
  },
};
assert.deepStrictEqual(mixer.stopSources([dummy]), []);
assert.strictEqual(dummy.stopped, true);
assert.deepStrictEqual(mixer.stopSources(null), []);

console.log("policy and mixer ok");
