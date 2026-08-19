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
              }, 25000);
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
const swT = (list || []).find((t) => t.type === "service_worker" && String(t.url || "").includes("jmommfeoeeajjaekfgbknapfnibehgac"));
if (!swT) {
  console.log("FAIL no sw");
  process.exit(2);
}
const sw = await wsConnect(swT.webSocketDebuggerUrl);
await sw.send("Runtime.enable", {});
const reloaded = await evalOn(
  sw,
  `(async () => {
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
    const tab = tabs && tabs[0];
    if (!tab) return { ok: false, reason: "no-tab" };
    await chrome.tabs.reload(tab.id);
    return { ok: true, id: tab.id };
  })()`
);
console.log("RELOAD", JSON.stringify(reloaded));
sw.close();
await new Promise((r) => setTimeout(r, 5000));

const list2 = await getJson("/json");
const pageT = (list2 || []).find((t) => t.type === "page" && /youtube\.com\/watch/.test(t.url || "") && !/chrome-error/.test(t.url || ""));
const sw2 = (list2 || []).find((t) => t.type === "service_worker" && String(t.url || "").includes("jmommfeoeeajjaekfgbknapfnibehgac"));
if (!pageT) {
  console.log("FAIL watch gone", (list2 || []).map((t) => t.type + " " + t.url));
  process.exit(2);
}
if (sw2) {
  const worker = await wsConnect(sw2.webSocketDebuggerUrl);
  await worker.send("Runtime.enable", {});
  const tog = await evalOn(
    worker,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
      const tab = tabs && tabs[0];
      if (!tab) return { ok: false };
      for (let i = 0; i < 10; i++) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "lvt-toggle" });
          return { ok: true, tries: i + 1 };
        } catch (e) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      return { ok: false, reason: "no receiver" };
    })()`
  );
  console.log("TOGGLE", JSON.stringify(tog));
  worker.close();
}

const page = await wsConnect(pageT.webSocketDebuggerUrl);
await page.send("Runtime.enable", {});
const labels = [];
for (let i = 0; i < 35; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = await evalOn(
    page,
    `(() => {
      const el = document.getElementById("lvt-toggle");
      const v = document.querySelector("video");
      return {
        btn: el ? el.textContent : "",
        href: location.href,
        video: !!v,
        session: !!(window.__lvtSession && window.__lvtSession.ver),
        ver: window.__lvtSession && window.__lvtSession.ver,
      };
    })()`
  );
  if (!labels.length || labels[labels.length - 1] !== st.btn) labels.push(st.btn);
  console.log("tick", i, JSON.stringify(st));
  const stop = ["Выкл", "нет дорожки", "нет хоста", "ошибка", "нет видео", "ASR пусто", "ставь ASR", "уже на языке"];
  if (stop.includes(st.btn) && i >= 4) break;
}
console.log("LABELS", JSON.stringify(labels));
try {
  const h = await fetch("http://127.0.0.1:17890/v1/session").then((r) => r.json());
  console.log("HOST", JSON.stringify({ state: h.state, reason: String(h.reason || "").slice(0, 120), ready: h.ready_count, asr_done: h.asr_done }));
} catch (e) {
  console.log("HOST", String(e));
}
page.close();
