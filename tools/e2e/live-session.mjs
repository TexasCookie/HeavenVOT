import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: 9333, path }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

function frame(payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsConnect(wsUrl) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port || 80), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let open = false;
    const pending = new Map();
    let nextId = 1;
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        if (!/101/.test(buf.slice(0, idx).toString("utf8"))) {
          reject(new Error("ws handshake failed"));
          sock.destroy();
          return;
        }
        buf = buf.slice(idx + 4);
        open = true;
        resolve({
          send(method, params) {
            const id = nextId++;
            sock.write(frame(Buffer.from(JSON.stringify({ id, method, params: params || {} }))));
            return new Promise((res, rej) => {
              pending.set(id, { res, rej });
              setTimeout(() => {
                if (pending.has(id)) {
                  pending.delete(id);
                  rej(new Error("timeout " + method));
                }
              }, 20000);
            });
          },
          close() {
            sock.end();
          },
        });
      }
      while (buf.length >= 2) {
        const b1 = buf[1];
        let len = b1 & 127;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) break;
        const data = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        let msg;
        try {
          msg = JSON.parse(data.toString("utf8"));
        } catch {
          continue;
        }
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        }
      }
    });
  });
}

async function evalOn(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || "exc");
  return r && r.result ? r.result.value : null;
}

const INSPECT = `(() => {
  const pack = window.__lvtSession && window.__lvtSession.snapshot ? window.__lvtSession.snapshot() : null;
  let visitor = "";
  try {
    const ctx = window.ytcfg && ytcfg.get && ytcfg.get("INNERTUBE_CONTEXT");
    visitor = (ctx && ctx.client && ctx.client.visitorData) || (ytcfg.get && ytcfg.get("VISITOR_DATA")) || "";
  } catch (e) {}
  let nPlay = 0;
  let pot = "";
  let hosts = [];
  try {
    const entries = performance.getEntriesByType("resource");
    for (let i = 0; i < entries.length; i++) {
      const name = String(entries[i].name || "");
      if (/googlevideo|videoplayback|initplayback|youtubei\\/v1\\/player/.test(name)) {
        nPlay += 1;
        try { hosts.push(new URL(name).host + name.slice(name.indexOf("/", 8), name.indexOf("?") > 0 ? name.indexOf("?") : name.length)); } catch (e) {}
        const m = /[?&]pot=([^&]+)/.exec(name);
        if (m) pot = m[1];
      }
    }
  } catch (e) {}
  let formats = 0;
  let audioUrls = 0;
  let fmtKeys = [];
  let sabr = false;
  try {
    const player = document.getElementById("movie_player");
    const pr = (player && player.getPlayerResponse && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
    const sd = pr && pr.streamingData;
    sabr = !!(sd && (sd.serverAbrStreamingUrl || sd.sabr));
    const list = sd ? (sd.adaptiveFormats || []).concat(sd.formats || []) : [];
    formats = list.length;
    if (list[0]) fmtKeys = Object.keys(list[0]);
    audioUrls = list.filter(function (x) { return x && x.url && String(x.mimeType || "").indexOf("audio/") !== -1; }).length;
  } catch (e) {}
  const el = document.getElementById("lvt-toggle");
  return {
    href: location.href,
    hasSession: !!pack,
    hook: !!window.__lvtNetHook,
    pot: !!(pack && pack.poToken) || !!pot,
    visitor: !!(pack && pack.visitorData) || !!visitor,
    playback: pack && pack.audioUrls ? pack.audioUrls.length : nPlay,
    hosts: hosts.slice(0, 8),
    formats: formats,
    fmtKeys: fmtKeys,
    sabr: sabr,
    audioUrls: audioUrls,
    btn: el ? el.textContent || "" : "",
    hookScript: !!document.getElementById("lvt-session-hook-024"),
  };
})()`;

function findWatch(list) {
  return (list || []).find(function (t) {
    return t.type === "page" && /youtube\.com\/watch/.test(String(t.url || "")) && !/chrome-error/.test(String(t.url || ""));
  });
}

function findSw(list) {
  return (list || []).find(function (t) {
    return t.type === "service_worker" && String(t.url || "").indexOf("jmommfeoeeajjaekfgbknapfnibehgac") !== -1;
  });
}

const hookSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "session-hook.js"),
  "utf8"
);

const list = await getJson("/json");
const target = findWatch(list);
if (!target) {
  console.log("FAIL no watch tab", (list || []).map((t) => t.type + " " + t.url));
  process.exit(2);
}
console.log("target", target.title, target.url);

const list2 = list;
const target2 = findWatch(list2) || target;
const sw = findSw(list2);
if (sw) {
  const worker = await wsConnect(sw.webSocketDebuggerUrl);
  await worker.send("Runtime.enable", {});
  try {
    const info = await evalOn(worker, `({ver: chrome.runtime.getManifest().version})`);
    console.log("SW", JSON.stringify(info));
  } catch (err) {
    console.log("SW_ERR", String(err));
  }
  try {
    const sent = await evalOn(
      worker,
      `(async () => {
        const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
        const tab = tabs && tabs[0];
        if (!tab) return { ok: false, reason: "no-tab" };
        const prefix = (chrome.runtime.getManifest().background.service_worker || "").indexOf("/") !== -1 ? "extension/" : "";
        const isolated = ["policy.js","mixer.js","player-button.js","captions.js","asr-audio.js","content.js"].map((f) => prefix + f);
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: [prefix + "session-hook.js"] });
        } catch (e) {
          return { ok: false, step: "main", err: String(e), prefix: prefix };
        }
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED", files: isolated });
        } catch (e) {
          return { ok: false, step: "isolated", err: String(e), prefix: prefix, files: isolated };
        }
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "lvt-toggle" });
          return { ok: true, id: tab.id, prefix: prefix };
        } catch (e) {
          return { ok: false, step: "toggle", err: String(e), id: tab.id, prefix: prefix };
        }
      })()`
    );
    console.log("TOGGLE", JSON.stringify(sent));
  } catch (err) {
    console.log("TOGGLE_ERR", String(err));
  }
  worker.close();
}

const page = await wsConnect(target2.webSocketDebuggerUrl);
await page.send("Runtime.enable", {});
await evalOn(page, hookSrc + "; true");
const afterHook = await evalOn(page, INSPECT);
console.log("AFTER_HOOK", JSON.stringify(afterHook));
try {
  const ens = await evalOn(
    page,
    `(async () => {
      if (!window.__lvtSession || !window.__lvtSession.ensure) return { no: true };
      const pack = await window.__lvtSession.ensure();
      return { n: (pack.audioUrls||[]).length, pot: !!pack.poToken, visitor: !!pack.visitorData, audio: !!pack.audioUrl };
    })()`
  );
  console.log("ENSURE", JSON.stringify(ens));
} catch (err) {
  console.log("ENSURE_ERR", String(err));
}

const labels = [];
for (let i = 0; i < 28; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = await evalOn(page, INSPECT);
  if (!labels.length || labels[labels.length - 1] !== st.btn) labels.push(st.btn);
  console.log("tick", i, st.btn, "session=" + st.hasSession, "pot=" + st.pot, "play=" + st.playback, "sabr=" + st.sabr);
  const stop = ["Выкл", "нет дорожки", "нет хоста", "ошибка", "нет видео", "ASR пусто", "ставь ASR", "уже на языке"];
  if (stop.includes(st.btn) && i >= 3) break;
}
console.log("LABELS", JSON.stringify(labels));
try {
  const h = await fetch("http://127.0.0.1:17890/v1/session").then((r) => r.json());
  console.log("HOST", JSON.stringify({ state: h.state, reason: h.reason, ready: h.ready_count, asr_done: h.asr_done, gate: h.gate }));
} catch (e) {
  console.log("HOST", String(e));
}
page.close();
