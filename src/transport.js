/**
 * The ways an event leaves the browser. All are "simple" cross-origin
 * requests (POST, text/plain body, the public key in the query string), so
 * the browser sends no CORS preflight (contract §3).
 *
 * None goes through the app's own HTTP stack: Angular's HttpClient and the
 * apps' fetch wrappers attach cookies, CSRF headers and, in development,
 * personal access tokens, none of which may reach the reports backend, and a
 * failing report must not re-enter the app's error interceptors.
 */

import { NETWORK_FAILURE_STATUS } from './delivery-policy.js';
import { utf8ByteLength } from './text.js';

export const INGEST_PATH = '/api/v1/ingest';
export const BODY_CONTENT_TYPE = 'text/plain;charset=UTF-8';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Browsers refuse a keepalive request once the bodies of a document's
 * keepalive requests in flight would exceed 64 KiB.
 */
export const KEEPALIVE_BUDGET_BYTES = 64 * 1024;

/**
 * @param {string} baseUrl e.g. https://reports.systicore.hu
 * @param {string} publicKey a public scpk_ key
 * @returns {string}
 */
export function buildIngestEndpoint(baseUrl, publicKey) {
  return `${baseUrl.replace(/\/+$/, '')}${INGEST_PATH}?key=${encodeURIComponent(publicKey)}`;
}

/**
 * @typedef {object} TransportResponse
 * @property {number} status HTTP status, or 0 when no response arrived
 * @property {string | null} retryAfter the Retry-After header
 */

/**
 * Bytes of this reporter's keepalive requests in flight, shared by the
 * transports so that a page-hide flush does not overrun the browser's
 * budget and get its requests refused.
 */
export class KeepaliveBudget {
  #bytesInFlight = 0;

  /**
   * @param {number} bytes
   * @returns {boolean} false when the bytes do not fit; nothing is reserved then
   */
  tryReserve(bytes) {
    if (this.#bytesInFlight + bytes > KEEPALIVE_BUDGET_BYTES) {
      return false;
    }
    this.#bytesInFlight += bytes;
    return true;
  }

  /**
   * @param {number} bytes
   */
  release(bytes) {
    this.#bytesInFlight = Math.max(0, this.#bytesInFlight - bytes);
  }
}

/**
 * Sends one body with fetch and reports the answer. keepalive lets a request
 * that is in flight survive a navigation, as long as it fits the keepalive
 * budget; credentials are omitted, so no cookie is ever sent.
 */
export class FetchTransport {
  #endpoint;
  #fetch;
  #keepaliveBudget;

  /**
   * @param {string} endpoint
   * @param {import('./runtime.js').FetchFunction} fetchFunction
   * @param {KeepaliveBudget} [keepaliveBudget]
   */
  constructor(endpoint, fetchFunction, keepaliveBudget = new KeepaliveBudget()) {
    this.#endpoint = endpoint;
    this.#fetch = fetchFunction;
    this.#keepaliveBudget = keepaliveBudget;
  }

  /**
   * Never rejects: a network failure resolves to status 0.
   *
   * @param {string} body
   * @returns {Promise<TransportResponse>}
   */
  async send(body) {
    const bytes = utf8ByteLength(body);
    const keepalive = this.#keepaliveBudget.tryReserve(bytes);
    try {
      const response = await this.#fetch(this.#endpoint, createRequestInit(body, keepalive));
      return {
        status: response.status,
        // Retry-After is not a CORS-safelisted response header: the browser
        // hides it unless the reports backend lists it in
        // Access-Control-Expose-Headers, and the default wait applies then.
        retryAfter: response.headers?.get('Retry-After') ?? null,
      };
    } catch {
      return { status: NETWORK_FAILURE_STATUS, retryAfter: null };
    } finally {
      if (keepalive) {
        this.#keepaliveBudget.release(bytes);
      }
    }
  }
}

/**
 * Sends bodies while the page is being hidden or unloaded, the way a beacon
 * does: a keepalive fetch outlives the page and its answer is not awaited,
 * so a request the browser accepted counts as delivered. Unlike
 * navigator.sendBeacon, which always sends the cookies of the reports
 * domain (and of a parent domain such as .systicore.hu), it omits them.
 */
export class KeepaliveBeaconTransport {
  #endpoint;
  #fetch;
  #keepaliveBudget;

  /**
   * @param {string} endpoint
   * @param {import('./runtime.js').FetchFunction} fetchFunction
   * @param {KeepaliveBudget} keepaliveBudget
   */
  constructor(endpoint, fetchFunction, keepaliveBudget) {
    this.#endpoint = endpoint;
    this.#fetch = fetchFunction;
    this.#keepaliveBudget = keepaliveBudget;
  }

  /**
   * @param {string} body
   * @returns {boolean} false when the body does not fit the keepalive budget
   */
  send(body) {
    const bytes = utf8ByteLength(body);
    if (!this.#keepaliveBudget.tryReserve(bytes)) {
      return false;
    }
    const release = () => this.#keepaliveBudget.release(bytes);
    try {
      Promise.resolve(this.#fetch(this.#endpoint, createRequestInit(body, true))).then(
        release,
        release,
      );
      return true;
    } catch {
      release();
      return false;
    }
  }
}

/**
 * Hands bodies to navigator.sendBeacon while the page is being hidden or
 * unloaded, in browsers whose fetch has no keepalive (Firefox before 133).
 * The response is never seen, so a beacon the browser accepted counts as
 * delivered. A beacon always carries cookies: sendBeacon has no credentials
 * option.
 */
export class BeaconTransport {
  #endpoint;
  #sendBeacon;

  /**
   * @param {string} endpoint
   * @param {(url: string, body: string) => boolean} sendBeacon
   */
  constructor(endpoint, sendBeacon) {
    this.#endpoint = endpoint;
    this.#sendBeacon = sendBeacon;
  }

  /**
   * A string body makes the browser send Content-Type
   * text/plain;charset=UTF-8, the CORS-safelisted type.
   *
   * @param {string} body
   * @returns {boolean} false when the browser refused (beacon quota)
   */
  send(body) {
    try {
      return this.#sendBeacon(this.#endpoint, body) === true;
    } catch {
      return false;
    }
  }
}

/**
 * The sender for the page-hide flush: a keepalive fetch where the browser
 * supports it, navigator.sendBeacon otherwise, or none.
 *
 * @param {string} endpoint
 * @param {import('./runtime.js').Runtime} runtime
 * @param {KeepaliveBudget} keepaliveBudget shared with the FetchTransport
 * @returns {{ send(body: string): boolean } | undefined}
 */
export function createPageHideTransport(endpoint, runtime, keepaliveBudget) {
  if (runtime.fetch && runtime.supportsKeepalive) {
    return new KeepaliveBeaconTransport(endpoint, runtime.fetch, keepaliveBudget);
  }
  if (runtime.sendBeacon) {
    return new BeaconTransport(endpoint, runtime.sendBeacon);
  }
  return undefined;
}

/**
 * @param {string} body
 * @param {boolean} keepalive
 * @returns {Record<string, unknown>}
 */
function createRequestInit(body, keepalive) {
  return {
    method: 'POST',
    body,
    headers: { 'Content-Type': BODY_CONTENT_TYPE },
    keepalive,
    credentials: 'omit',
    mode: 'cors',
    // Keeps the page path and query out of the Referer header; the Origin
    // header the server checks against the key's allowed origins stays.
    referrerPolicy: 'strict-origin',
    signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
  };
}

/**
 * @param {number} timeoutMs
 * @returns {AbortSignal | undefined}
 */
function createTimeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}
