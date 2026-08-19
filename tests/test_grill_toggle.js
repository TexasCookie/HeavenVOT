const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
const start = src.indexOf("async function runToggle()");
assert.ok(start >= 0, "runToggle missing");
const next = src.indexOf("\n  function ", start + 10);
const body = src.slice(start, next);
assert.ok(!/startAsrCapture\(/.test(body), "runToggle must not start live tap");
assert.ok(!/LVT_ASR_START/.test(body), "runToggle must not post live ASR start");
assert.ok(/asr_mode:\s*true/.test(body), "enable is always the file pipeline");
assert.ok(!/skip_download\s*:/.test(body), "enable must not skip yt-dlp because an intercept URL exists");
assert.ok(/expect_upload:/.test(body), "intercept URL keeps upload method open");
assert.ok(/po_token:/.test(body), "player PO token goes to the host");
assert.ok(/visitor_data:/.test(body), "player visitorData goes to the host");
assert.ok(/audio_url:/.test(body), "player googlevideo URL goes to the host");
assert.ok(/need-file/.test(body), "intercept fetch fail must ask the host for the file job");
assert.ok(/askNeedFile/.test(body), "hung googlevideo fetch must stop waiting");
assert.ok(!/setButtonState\("Выкл"\)/.test(body), "captions alone must not mark success");

const popup = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.html"), "utf8");
assert.ok(popup.indexOf("waitFull") !== -1);
assert.ok(popup.indexOf('value="ru"') !== -1);
assert.ok(popup.indexOf('value="en"') !== -1);

console.log("grill toggle ok");
