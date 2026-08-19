import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: 9333, path }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
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

const STATE = `(() => {
  const el = document.getElementById("lvt-toggle");
  const v = document.querySelector("video.html5-main-video, ytd-player video, video");
  return {
    href: location.href,
    title: document.title,
    btn: el ? el.textContent || "" : "",
    n: document.querySelectorAll("#lvt-toggle").length,
    video: !!v,
    ready: v ? v.readyState : -1,
    dur: v && isFinite(v.duration) ? v.duration : 0,
    paused: v ? v.paused : null,
    t: v ? Number(v.currentTime.toFixed(1)) : null,
  };
})()`;

const list = await getJson("/json");
const target = (list || []).find((t) => t.type === "page" && String(t.url || "").includes("vGUNqq3jVLg"));
if (!target) {
  console.log("FAIL no target", (list || []).map((t) => t.type + " " + t.url));
  process.exit(2);
}
console.log("target", target.title, target.url);
const cdp = await wsConnect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable", {});
for (let i = 0; i < 20; i++) {
  const st = await evalOn(cdp, STATE);
  console.log("wait", i, JSON.stringify(st));
  if (st.n && st.video && st.dur > 1) {
    await evalOn(cdp, `(() => { const v=document.querySelector("video"); if(v){v.muted=true; v.play().catch(()=>{});} return true; })()`);
    break;
  }
  await new Promise((r) => setTimeout(r, 800));
}
const before = await evalOn(cdp, STATE);
console.log("before", JSON.stringify(before));
if (!before.n) {
  console.log("FAIL no button");
  cdp.close();
  process.exit(2);
}
await evalOn(cdp, `document.getElementById("lvt-toggle").click()`);
const labels = [];
for (let i = 0; i < 70; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = await evalOn(cdp, STATE);
  if (!labels.length || labels[labels.length - 1] !== st.btn) labels.push(st.btn);
  console.log("tick", i, JSON.stringify(st));
  const stop = ["Выкл", "нет дорожки", "нет хоста", "ошибка", "нет видео", "ASR пусто", "ставь ASR", "уже на языке"];
  if (stop.includes(st.btn) && i >= 4) break;
}
console.log("LABELS", JSON.stringify(labels));
console.log("LAST", labels[labels.length - 1]);
try {
  const h = await fetch("http://127.0.0.1:17890/v1/session").then((r) => r.json());
  console.log("HOST", JSON.stringify(h));
} catch (e) {
  console.log("HOST", String(e));
}
cdp.close();
process.exit(0);
