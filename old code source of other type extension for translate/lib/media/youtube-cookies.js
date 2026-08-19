/**
 * Export YouTube/Google cookies from the *current* browser profile
 * (works in Arc/Chrome/Edge — no DPAPI / cookies-from-browser needed).
 */

/**
 * Netscape cookie jar for yt-dlp --cookies
 * @returns {Promise<string>}
 */
export async function exportYoutubeCookiesNetscape() {
  if (!chrome?.cookies?.getAll) {
    return '';
  }
  const domains = [
    '.youtube.com',
    'youtube.com',
    '.googlevideo.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtube-nocookie.com',
    '.youtube-nocookie.com',
  ];
  /** @type {Map<string, chrome.cookies.Cookie>} */
  const byKey = new Map();
  for (const domain of domains) {
    try {
      const list = await chrome.cookies.getAll({ domain });
      for (const c of list || []) {
        const key = `${c.domain}\t${c.path}\t${c.name}`;
        byKey.set(key, c);
      }
    } catch {
      /* ignore */
    }
  }
  // Also URL-scoped fetch (some Chromium forks)
  for (const url of [
    'https://www.youtube.com/',
    'https://youtube.com/',
  ]) {
    try {
      const list = await chrome.cookies.getAll({ url });
      for (const c of list || []) {
        const key = `${c.domain}\t${c.path}\t${c.name}`;
        byKey.set(key, c);
      }
    } catch {
      /* ignore */
    }
  }

  const lines = ['# Netscape HTTP Cookie File', '# AetherVox export'];
  for (const c of byKey.values()) {
    const domain = c.domain || '';
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires =
      c.session || !c.expirationDate
        ? '0'
        : String(Math.floor(Number(c.expirationDate)));
    const name = c.name || '';
    const value = c.value || '';
    if (!name) continue;
    lines.push(
      [domain, includeSub, path, secure, expires, name, value].join('\t'),
    );
  }
  return lines.join('\n') + '\n';
}
