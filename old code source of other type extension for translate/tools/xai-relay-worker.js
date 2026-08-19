/**
 * Cloudflare Worker — reverse-proxy для api.x.ai (HTTP + WebSocket).
 *
 * Деплой: https://workers.cloudflare.com → Create Worker → вставить этот файл.
 * В AetherVox → Настройки → «HTTPS reverse-proxy»:
 *   https://<твой-сабдомен>.workers.dev/v1
 *
 * Локальный twin (без CF): node tools/xai-relay-local.mjs → http://127.0.0.1:8787/v1
 *
 * Важно:
 * - Это твой личный relay. Не публикуй его в открытых списках с чужими ключами.
 * - HTTP: клиент шлёт Authorization — worker форвардит.
 * - WebSocket: браузер НЕ может выставить Authorization.
 *   AetherVox передаёт ключ как query `_av_key=...` (или Sec-WebSocket-Protocol
 *   `xai-client-secret.<token>`). Worker снимает секрет с URL и ставит Authorization
 *   на upstream api.x.ai (серверный путь — надёжнее protocol auth).
 * - Не логируй Authorization / _av_key.
 */

const UPSTREAM = 'https://api.x.ai';
const AV_KEY_PARAM = '_av_key';
const XAI_PROTO_PREFIX = 'xai-client-secret.';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade') || '';

    // WebSocket upgrade → tunnel to api.x.ai (streaming STT / TTS)
    if (upgrade.toLowerCase() === 'websocket') {
      return proxyWebSocket(request, url);
    }

    // Strip accidental _av_key on HTTP
    url.searchParams.delete(AV_KEY_PARAM);
    const path = url.pathname + url.search;
    const target = UPSTREAM + path;

    const headers = new Headers(request.headers);
    headers.delete('host');

    const init = {
      method: request.method,
      headers,
      redirect: 'follow',
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
      // @ts-ignore — duplex needed for streaming bodies on some runtimes
      init.duplex = 'half';
    }

    // CORS preflight (debug from pages; extension SW doesn't need it)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const res = await fetch(target, init);
    const outHeaders = new Headers(res.headers);
    outHeaders.set('Access-Control-Allow-Origin', '*');
    outHeaders.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
    });
  },
};

/**
 * @param {Request} request
 * @param {URL} url
 */
async function proxyWebSocket(request, url) {
  // Pull key from query (extension relay path) — strip before upstream
  let key = url.searchParams.get(AV_KEY_PARAM) || '';
  url.searchParams.delete(AV_KEY_PARAM);

  // Or from Sec-WebSocket-Protocol: xai-client-secret.<token>
  const protoHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const protocols = protoHeader
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!key) {
    for (const p of protocols) {
      if (p.startsWith(XAI_PROTO_PREFIX)) {
        key = p.slice(XAI_PROTO_PREFIX.length);
        break;
      }
    }
  }

  if (!key) {
    return new Response(
      'relay: missing _av_key or xai-client-secret protocol (browser cannot set Authorization)',
      { status: 401 },
    );
  }

  const targetUrl = UPSTREAM + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.delete('host');

  // Reliable server-side path for TTS/STT (protocol alone is Realtime-oriented)
  const bearer = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
  headers.set('Authorization', bearer);

  // Drop subprotocol after extracting key — avoid double-auth confusion upstream
  headers.delete('Sec-WebSocket-Protocol');

  return fetch(targetUrl, {
    method: request.method,
    headers,
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
