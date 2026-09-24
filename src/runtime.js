/**
 * The browser services the reporter uses, detected once at init. Everything
 * is feature-detected and optional, so the reporter degrades to a no-op
 * instead of throwing on an old browser, in a worker, during server-side
 * rendering or under a restrictive sandbox. Tests pass their own Runtime.
 */

/**
 * @typedef {object} ListenerTarget
 * @property {(type: string, listener: (event: any) => void) => void} addEventListener
 * @property {(type: string, listener: (event: any) => void) => void} removeEventListener
 */

/**
 * @typedef {object} FetchResponseLike
 * @property {number} status
 * @property {{ get(name: string): string | null }} [headers]
 */

/**
 * @typedef {(url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>} FetchFunction
 */

/**
 * @typedef {object} Runtime
 * @property {FetchFunction | undefined} fetch
 * @property {boolean} supportsKeepalive fetch honours keepalive (not Firefox before 133)
 * @property {((url: string, body: string) => boolean) | undefined} sendBeacon
 * @property {ListenerTarget | undefined} windowTarget receives error, unhandledrejection, online and pagehide
 * @property {(ListenerTarget & { visibilityState?: string }) | undefined} documentTarget receives visibilitychange
 * @property {{ onLine?: boolean, userAgent?: string } | undefined} navigator
 * @property {{ href?: string } | undefined} location
 * @property {import('./device.js').KeyValueStorage | undefined} localStorage
 * @property {IDBFactory | undefined} indexedDB
 * @property {() => number} now epoch milliseconds
 * @property {() => number} random uniform in [0, 1)
 * @property {(callback: () => void, delay: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 * @property {() => string} createId
 */

/**
 * @returns {Runtime}
 */
export function detectRuntime() {
  /** @type {any} */
  const scope = globalThis;
  const navigatorObject = scope.navigator;
  return {
    fetch: typeof scope.fetch === 'function' ? scope.fetch.bind(scope) : undefined,
    supportsKeepalive:
      typeof scope.Request === 'function' && 'keepalive' in scope.Request.prototype,
    sendBeacon:
      typeof navigatorObject?.sendBeacon === 'function'
        ? (url, body) => navigatorObject.sendBeacon(url, body)
        : undefined,
    windowTarget: asListenerTarget(scope.window) ?? asListenerTarget(scope),
    documentTarget: asListenerTarget(scope.document),
    navigator: navigatorObject,
    location: scope.location,
    localStorage: readGlobal(scope, 'localStorage'),
    indexedDB: readGlobal(scope, 'indexedDB'),
    now: () => Date.now(),
    random: Math.random,
    setTimeout: (callback, delay) => scope.setTimeout(callback, delay),
    clearTimeout: (handle) => scope.clearTimeout(handle),
    createId: createRandomId,
  };
}

/**
 * @param {unknown} candidate
 * @returns {any}
 */
export function asListenerTarget(candidate) {
  const target = /** @type {any} */ (candidate);
  return typeof target?.addEventListener === 'function' &&
    typeof target?.removeEventListener === 'function'
    ? target
    : undefined;
}

/**
 * Reads a global whose getter may throw (localStorage in a sandboxed iframe,
 * indexedDB in some privacy modes).
 *
 * @param {any} scope
 * @param {string} name
 * @returns {any}
 */
function readGlobal(scope, name) {
  try {
    return scope[name] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A random v4 UUID. crypto.randomUUID only exists in secure contexts, so
 * getRandomValues (and, as a last resort, Math.random) cover plain-http
 * development hosts.
 *
 * @returns {string}
 */
export function createRandomId() {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoObject?.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * True unless the browser positively knows it is offline.
 *
 * @param {Runtime} runtime
 * @returns {boolean}
 */
export function isOnline(runtime) {
  return runtime.navigator?.onLine !== false;
}
