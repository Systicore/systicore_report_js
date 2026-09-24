/**
 * Client-side flood control. An error inside a render loop or a timer can
 * fire hundreds of times a second; the server rate-limits per key, so a
 * flood from one browser would also starve every other user of the app.
 */

export const DUPLICATE_WINDOW_MS = 60_000;
export const RATE_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

/** Distinct errors remembered at once; the oldest is forgotten first. */
const MAX_REMEMBERED_ERRORS = 100;

/**
 * Suppresses an error identical to one sent within the last 60 seconds. The
 * window starts at the first occurrence and is not extended by suppressed
 * repeats, so a persistent error is still reported once a minute.
 */
export class DuplicateFilter {
  /** @type {Map<string, number>} identity → time it was last let through */
  #passedAt = new Map();
  #windowMs;

  /**
   * @param {number} [windowMs]
   */
  constructor(windowMs = DUPLICATE_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  /**
   * @param {string} identity
   * @param {number} now epoch milliseconds
   * @returns {boolean} true when the error must be suppressed
   */
  isDuplicate(identity, now) {
    this.#forgetExpired(now);
    if (this.#passedAt.has(identity)) {
      return true;
    }
    this.#passedAt.set(identity, now);
    if (this.#passedAt.size > MAX_REMEMBERED_ERRORS) {
      const oldest = this.#passedAt.keys().next().value;
      if (oldest !== undefined) {
        this.#passedAt.delete(oldest);
      }
    }
    return false;
  }

  /**
   * @param {number} now
   */
  #forgetExpired(now) {
    for (const [identity, passedAt] of this.#passedAt) {
      if (now - passedAt < this.#windowMs) {
        break;
      }
      this.#passedAt.delete(identity);
    }
  }
}

/**
 * Sliding one-minute window: at most `limit` events in any 60 seconds.
 */
export class RateLimiter {
  /** @type {number[]} */
  #acceptedAt = [];
  #limit;

  /**
   * @param {number} limit events per minute
   */
  constructor(limit) {
    this.#limit = limit;
  }

  /**
   * @param {number} now epoch milliseconds
   * @returns {boolean} true when the event may be sent
   */
  tryAcquire(now) {
    while (this.#acceptedAt.length > 0 && now - this.#acceptedAt[0] >= RATE_WINDOW_MS) {
      this.#acceptedAt.shift();
    }
    if (this.#acceptedAt.length >= this.#limit) {
      return false;
    }
    this.#acceptedAt.push(now);
    return true;
  }
}

/**
 * The identity used for duplicate suppression.
 *
 * @param {import('./event-builder.js').IngestError} error
 * @returns {string}
 */
export function duplicateIdentityOf(error) {
  return [error.type, error.code, error.message, error.action].map((part) => part ?? '').join('|');
}
