import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve(JSON.parse(raw)));
    }).on("error", reject);
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

function wsConnect(wsUrl, timeoutMs) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const limit = timeoutMs || 45000;
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
              }, limit);
            });
          },
          close() {
            sock.end();
          },
        });
      }
      while (buf.length >= 2) {
        let len = buf[1] & 127;
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

const list = await getJson("/json");
const pageT = (list || []).find((t) => t.type === "page" && /youtube\.com\/watch/.test(t.url || "") && !/chrome-error/.test(t.url || ""));
const swT = (list || []).find((t) => t.type === "service_worker" && String(t.url || "").includes("jmommfeoeeajjaekfgbknapfnibehgac"));
if (!pageT) {
  console.log("FAIL no watch");
  process.exit(2);
}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const hookSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "session-hook.js"), "utf8");
const page = await wsConnect(pageT.webSocketDebuggerUrl);
await page.send("Runtime.enable", {});
await evalOn(page, hookSrc + "; true");
const pack = await evalOn(
  page,
  `(async () => {
    const v = document.querySelector("video");
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    const vid = new URLSearchParams(location.search).get("v") || "";
    let session = {};
    if (window.__lvtSession && window.__lvtSession.ensure) session = await window.__lvtSession.ensure();
    return {
      videoId: vid,
      duration: dur,
      visitorData: session.visitorData || "",
      poToken: session.poToken || "",
      audioUrl: session.audioUrl || "",
      audioUrls: session.audioUrls || [],
    };
  })()`
);
page.close();
console.log("PACK", JSON.stringify({
  videoId: pack.videoId,
  duration: pack.duration,
  visitor: !!pack.visitorData,
  pot: !!pack.poToken,
  audio: !!pack.audioUrl,
  n: (pack.audioUrls || []).length,
}));
if (pack.audioUrl) {
  const tmp = path.join(process.env.TEMP || ".", "lvt-url.txt");
  fs.writeFileSync(tmp, pack.audioUrl, "utf8");
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync(
    "curl.exe",
    ["-sI", "-L", "--max-time", "15", "-x", "socks5://127.0.0.1:10808", "-A", "Mozilla/5.0", "-H", "Referer: https://www.youtube.com/", "-D", "-", "-o", "NUL", pack.audioUrl],
    { encoding: "utf8" }
  );
  const head = String(probe.stdout || probe.stderr || "").split(/\r?\n/).filter((l) => /HTTP\/|content-type|content-length|x-robots/i.test(l));
  console.log("HEAD", JSON.stringify(head.slice(0, 8)));
}

let cookies = [];
if (swT) {
  const sw = await wsConnect(swT.webSocketDebuggerUrl);
  await sw.send("Runtime.enable", {});
  cookies = await evalOn(
    sw,
    `(async () => {
      const a = await chrome.cookies.getAll({ domain: "youtube.com" });
      const b = await chrome.cookies.getAll({ domain: "google.com" });
      return (a || []).concat(b || []).map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, expirationDate: c.expirationDate
      }));
    })()`
  );
  sw.close();
}
console.log("COOKIES", (cookies || []).length);

const start = await fetch("http://127.0.0.1:17890/v1/session/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tab_id: "probe:" + Date.now(),
    video_id: pack.videoId,
    target_lang: "ru",
    video_duration: pack.duration || 0,
    playback_rate: 1,
    asr_mode: true,
    cookies: cookies || [],
    visitor_data: pack.visitorData || "",
    po_token: pack.poToken || "",
    audio_url: pack.audioUrl || "",
    audio_urls: pack.audioUrls || [],
    expect_upload: false,
  }),
}).then((r) => r.json());
console.log("START", JSON.stringify({ state: start.state, reason: start.reason, file_job: start.file_job }));

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const snap = await fetch("http://127.0.0.1:17890/v1/session").then((r) => r.json());
  console.log("SNAP", i, JSON.stringify({
    state: snap.state,
    reason: snap.reason,
    ready: snap.ready_count,
    asr_done: snap.asr_done,
    gate: snap.gate,
  }));
  if (snap.state === "error" || snap.asr_done || (snap.ready_count || 0) > 0) break;
}
