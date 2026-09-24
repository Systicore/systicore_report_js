/**
 * How the reporter reacts to the ingest responses (contract §3, "Client SDK
 * behaviour on responses"):
 *   2xx                  delivered
 *   400, 413, other 4xx  dropped: the same payload would be refused again
 *   401, 403             dropped, and nothing is sent for 5 minutes (circuit
 *                        breaker: a revoked key or a wrong origin will not
 *                        heal by itself, so hammering the server is pointless)
 *   429                  kept, nothing is sent until Retry-After has passed
 *   5xx, 408, network    kept, retried with exponential backoff
 */

export const DeliveryOutcome = Object.freeze({
  DELIVERED: 'delivered',
  REJECTED: 'rejected',
  UNAUTHORIZED: 'unauthorized',
  THROTTLED: 'throttled',
  RETRYABLE: 'retryable',
});

export const CIRCUIT_BREAK_MS = 5 * 60_000;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
export const INITIAL_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
/** Jitter spreads the retries of many browsers that failed at the same moment. */
const BACKOFF_JITTER_RATIO = 0.2;

/** Status used for a request that never got an HTTP response. */
export const NETWORK_FAILURE_STATUS = 0;

/**
 * @param {number} status HTTP status, or 0 for a network failure
 * @returns {string} one of DeliveryOutcome
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) {
    return DeliveryOutcome.DELIVERED;
  }
  if (status === 401 || status === 403) {
    return DeliveryOutcome.UNAUTHORIZED;
  }
  if (status === 429) {
    return DeliveryOutcome.THROTTLED;
  }
  if (status === NETWORK_FAILURE_STATUS || status === 408 || status >= 500) {
    return DeliveryOutcome.RETRYABLE;
  }
  return DeliveryOutcome.REJECTED;
}

/**
 * Milliseconds to wait from a Retry-After header: delay-seconds or an
 * HTTP-date. Missing or unparsable values wait a minute; the wait is bounded
 * to one hour so a misconfigured proxy cannot silence reporting for good.
 *
 * @param {string | null | undefined} headerValue
 * @param {number} now epoch milliseconds
 * @returns {number}
 */
export function parseRetryAfter(headerValue, now) {
  const text = typeof headerValue === 'string' ? headerValue.trim() : '';
  let delay = DEFAULT_RETRY_AFTER_MS;
  if (/^\d+$/.test(text)) {
    delay = Number(text) * 1000;
  } else if (text !== '') {
    const date = Date.parse(text);
    if (!Number.isNaN(date)) {
      delay = date - now;
    }
  }
  return Math.min(Math.max(delay, 1000), MAX_RETRY_AFTER_MS);
}

/**
 * 2 s, 4 s, 8 s … capped at 5 minutes, each ±20 %.
 *
 * @param {number} consecutiveFailures 1 for the first failure
 * @param {() => number} random uniform in [0, 1)
 * @returns {number} milliseconds
 */
export function backoffDelay(consecutiveFailures, random) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
  const jitter = 1 - BACKOFF_JITTER_RATIO + random() * 2 * BACKOFF_JITTER_RATIO;
  return Math.round(base * jitter);
}

/**
 * The single "do not send before" instant shared by the circuit breaker,
 * Retry-After and backoff. A longer block is never shortened by a shorter one.
 */
export class DeliveryGate {
  #blockedUntil = 0;

  /**
   * @param {number} now
   * @returns {boolean}
   */
  isBlocked(now) {
    return now < this.#blockedUntil;
  }

  /** @returns {number} epoch milliseconds, 0 when never blocked */
  get blockedUntil() {
    return this.#blockedUntil;
  }

  /**
   * @param {number} durationMs
   * @param {number} now
   */
  blockFor(durationMs, now) {
    this.#blockedUntil = Math.max(this.#blockedUntil, now + durationMs);
  }
}
