/**
 * Local reverse-proxy for api.x.ai (HTTP + WebSocket) — same contract as
 * tools/xai-relay-worker.js, zero npm deps (Node 18+).
 *
 * Run:
 *   set XAI_API_KEY=xai-...   (optional default if client omits key)
 *   node tools/xai-relay-local.mjs
 *   # listens http://127.0.0.1:8787
 *
 * AetherVox → Options → Network:
 *   Mode: relay (or auto)
 *   HTTPS reverse-proxy: http://127.0.0.1:8787/v1
 *
 * Auth (WebSocket — browser cannot set Authorization):
 *   query  ?_av_key=<token>   → injected as Authorization: Bearer …
 *   or Sec-WebSocket-Protocol: xai-client-secret.<token>
 *
 * Hard self-test also boots an in-process twin of this logic.
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const UPSTREAM_HOST = 'api.x.ai';
const AV_KEY_PARAM = '_av_key';
const XAI_PROTO_PREFIX = 'xai-client-secret.';
const PORT = Number(process.env.PORT || process.env.AV_RELAY_PORT || 8787);
const HOST = process.env.AV_RELAY_HOST || '127.0.0.1';
const DEFAULT_KEY = String(process.env.XAI_API_KEY || '').trim();

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 */
export function extractRelayKey(req, url) {
  let key = url.searchParams.get(AV_KEY_PARAM) || '';
  if (key) {
    url.searchParams.delete(AV_KEY_PARAM);
  }
  if (!key) {
    const protoHeader = req.headers['sec-websocket-protocol'] || '';
    const protocols = String(protoHeader)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of protocols) {
      if (p.startsWith(XAI_PROTO_PREFIX)) {
        key = p.slice(XAI_PROTO_PREFIX.length);
        break;
      }
    }
  }
  if (!key && DEFAULT_KEY) key = DEFAULT_KEY;
  return key;
}

/**
 * Pure decision used by hard tests: does this handshake carry auth?
 * @param {{ url: string, protocols?: string[], authorization?: string }} h
 */
export function handshakeHasAuth(h) {
  if (h.authorization && /Bearer\s+\S+/i.test(h.authorization)) return true;
  try {
    const u = new URL(h.url, 'http://local');
    if (u.searchParams.get(AV_KEY_PARAM)) return true;
  } catch {
    /* ignore */
  }
  for (const p of h.protocols || []) {
    if (String(p).startsWith(XAI_PROTO_PREFIX) && p.length > XAI_PROTO_PREFIX.length) {
      return true;
    }
  }
  return false;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function proxyHttp(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  // Strip _av_key from HTTP too (should not appear, but never leak upstream)
  url.searchParams.delete(AV_KEY_PARAM);

  const headers = { ...req.headers, host: UPSTREAM_HOST };
  delete headers['host'];
  headers.host = UPSTREAM_HOST;

  // Prefer client Authorization; optional env fallback for local debug only
  if (!headers.authorization && DEFAULT_KEY) {
    headers.authorization = `Bearer ${DEFAULT_KEY}`;
  }

  const path = url.pathname + url.search;
  const upstream = https.request(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      path,
      method: req.method,
      headers,
    },
    (upRes) => {
      const out = { ...upRes.headers, ...corsHeaders() };
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders() });
    }
    res.end(`relay upstream error: ${e.message}`);
  });
  req.pipe(upstream);
}

/**
 * WebSocket tunnel: client ↔ local relay ↔ wss://api.x.ai
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 */
function proxyWebSocket(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const key = extractRelayKey(req, url);

  if (!key) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nmissing _av_key or xai-client-secret protocol',
    );
    socket.destroy();
    return;
  }

  const path = url.pathname + url.search;
  const clientKey = req.headers['sec-websocket-key'];
  if (!clientKey) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upHeaders = {
    host: UPSTREAM_HOST,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': req.headers['sec-websocket-version'] || '13',
    'sec-websocket-key': clientKey,
    authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`,
  };
  // Forward client subprotocols only if xAI form (optional); Authorization is primary
  const proto = req.headers['sec-websocket-protocol'];
  if (proto && String(proto).includes(XAI_PROTO_PREFIX)) {
    upHeaders['sec-websocket-protocol'] = proto;
  }

  const upReq = https.request({
    hostname: UPSTREAM_HOST,
    port: 443,
    path,
    method: 'GET',
    headers: upHeaders,
  });

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    const accept = crypto
      .createHash('sha1')
      .update(clientKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    // Echo a selected protocol if upstream did
    const upProto = upRes.headers['sec-websocket-protocol'];
    if (upProto) lines.push(`Sec-WebSocket-Protocol: ${upProto}`);
    lines.push('', '');
    socket.write(lines.join('\r\n'));
    if (head?.length) upSocket.write(head);
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const kill = () => {
      try {
        upSocket.destroy();
      } catch {
        /* ignore */
      }
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    };
    upSocket.on('error', kill);
    socket.on('error', kill);
  });

  upReq.on('response', (upRes) => {
    // Non-101 (auth fail, etc.)
    const body = [];
    upRes.on('data', (c) => body.push(c));
    upRes.on('end', () => {
      const msg = Buffer.concat(body).toString('utf8').slice(0, 200);
      socket.write(
        `HTTP/1.1 ${upRes.statusCode || 502} ${upRes.statusMessage || 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nupstream ${upRes.statusCode}: ${msg}`,
      );
      socket.destroy();
    });
  });

  upReq.on('error', (e) => {
    try {
      socket.write(
        `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${e.message}`,
      );
    } catch {
      /* ignore */
    }
    socket.destroy();
  });

  upReq.end();
}

/**
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string, close: () => Promise<void> }>}
 */
export function startRelay(opts = {}) {
  const host = opts.host || HOST;
  const port = opts.port ?? PORT;
  const server = http.createServer(proxyHttp);
  server.on('upgrade', proxyWebSocket);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort =
        addr && typeof addr === 'object' ? addr.port : port;
      const baseUrl = `http://${host}:${boundPort}/v1`;
      resolve({
        server,
        baseUrl,
        port: boundPort,
        close: () =>
          new Promise((res, rej) => {
            server.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
  });
}

// CLI entry
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('xai-relay-local.mjs') ||
    process.argv[1].includes('xai-relay-local'));

if (isMain) {
  const { baseUrl } = await startRelay();
  console.log(`[aethervox-relay] listening ${baseUrl}`);
  console.log(`[aethervox-relay] set Options → relay base to: ${baseUrl}`);
  if (!DEFAULT_KEY) {
    console.log(
      '[aethervox-relay] tip: clients send _av_key; or set XAI_API_KEY env for default',
    );
  } else {
    console.log('[aethervox-relay] XAI_API_KEY env present (default auth)');
  }
}
