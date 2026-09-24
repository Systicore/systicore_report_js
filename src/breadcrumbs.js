/**
 * The last few things that happened before an error (navigation, HTTP calls,
 * log lines), attached to every event as context.breadcrumbs.
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
