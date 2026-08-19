import { EXT_NAME } from './constants.js';

let debugEnabled = false;

export function setDebug(enabled) {
  debugEnabled = !!enabled;
}

/** Make log args readable when DevTools flattens them to strings. */
function formatArg(arg) {
  if (arg == null) return arg;
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'object') {
    try {
      // Prefer structured clone in console when possible; also provide a string
      // form so copy/paste and some extension consoles don't show [object Object].
      return JSON.stringify(arg);
    } catch {
      try {
        return String(arg);
      } catch {
        return '[unserializable]';
      }
    }
  }
  return arg;
}

function stamp(level, args) {
  const t = new Date().toISOString().slice(11, 23);
  return [`[${EXT_NAME} ${t}][${level}]`, ...args.map(formatArg)];
}

export const log = {
  debug(...args) {
    if (debugEnabled) console.debug(...stamp('DBG', args));
  },
  info(...args) {
    console.info(...stamp('INF', args));
  },
  warn(...args) {
    console.warn(...stamp('WRN', args));
  },
  error(...args) {
    console.error(...stamp('ERR', args));
  },
};
