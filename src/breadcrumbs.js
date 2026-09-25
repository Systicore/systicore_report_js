/**
 * The last few things that happened before an error (navigation, HTTP calls,
 * log lines), attached to every event as context.breadcrumbs, together with
 * the app's own steps from the breadcrumbsProvider option.
 */

import { limitBreadcrumbMessage, normalizeBreadcrumbCategory } from './event-builder.js';
import { MAX_BREADCRUMBS } from './limits.js';

/** @typedef {import('./event-builder.js').Breadcrumb} Breadcrumb */

export class BreadcrumbTrail {
  /** @type {Breadcrumb[]} */
  #entries = [];
  #now;
  #capacity;

  /**
   * @param {() => number} now epoch milliseconds
   * @param {number} [capacity]
   */
  constructor(now, capacity = MAX_BREADCRUMBS) {
    this.#now = now;
    this.#capacity = capacity;
  }

  /**
   * Records one breadcrumb; the oldest one is forgotten beyond the capacity.
   * Messages are cut to 200 characters with URL queries removed.
   *
   * @param {{ category?: unknown, message?: unknown }} breadcrumb
   * @returns {boolean} false when the message is empty
   */
  add(breadcrumb) {
    const message = limitBreadcrumbMessage(breadcrumb?.message);
    if (message === undefined) {
      return false;
    }
    this.#entries.push({
      ts: new Date(this.#now()).toISOString(),
      category: normalizeBreadcrumbCategory(breadcrumb.category),
      message,
    });
    if (this.#entries.length > this.#capacity) {
      this.#entries.shift();
    }
    return true;
  }

  /**
   * @returns {Breadcrumb[]} a copy, oldest first
   */
  snapshot() {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}

/**
 * The trail merged with the breadcrumbs of the app's breadcrumbsProvider
 * (its own step log), oldest first, the newest MAX_BREADCRUMBS kept. Only
 * the last MAX_BREADCRUMBS provided entries are read, so a long app log
 * costs nothing on the error path. A provided entry is a string or
 * { category?, message, ts? }; without a usable `ts` it gets the capture
 * time.
 *
 * @param {Breadcrumb[]} trail from BreadcrumbTrail.snapshot()
 * @param {unknown} provided what the provider returned
 * @param {number} now epoch milliseconds of the capture
 * @returns {Breadcrumb[]}
 */
export function mergeProvidedBreadcrumbs(trail, provided, now) {
  if (!Array.isArray(provided) || provided.length === 0) {
    return trail;
  }
  /** @type {Breadcrumb[]} */
  const providedBreadcrumbs = [];
  for (const entry of provided.slice(-MAX_BREADCRUMBS)) {
    const breadcrumb = typeof entry === 'string' ? { message: entry } : entry;
    const message = limitBreadcrumbMessage(breadcrumb?.message);
    if (message !== undefined) {
      providedBreadcrumbs.push({
        ts: timestampOf(breadcrumb.ts, now),
        category: normalizeBreadcrumbCategory(breadcrumb.category),
        message,
      });
    }
  }
  return [...trail, ...providedBreadcrumbs]
    .sort((earlier, later) => Date.parse(earlier.ts) - Date.parse(later.ts))
    .slice(-MAX_BREADCRUMBS);
}

/**
 * @param {unknown} value a Date, epoch milliseconds or a date string
 * @param {number} now used when `value` is not a valid time
 * @returns {string} RFC 3339 timestamp
 */
function timestampOf(value, now) {
  const isTimeLike =
    value instanceof Date || typeof value === 'number' || typeof value === 'string';
  const date = isTimeLike ? new Date(value) : new Date(Number.NaN);
  return (Number.isNaN(date.getTime()) ? new Date(now) : date).toISOString();
}
