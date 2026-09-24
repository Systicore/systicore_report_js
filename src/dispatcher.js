/**
 * Delivers queued events one at a time, in order, and applies the response
 * policy of delivery-policy.js. One request in flight at a time keeps the
 * order stable and stays inside the browser's 64 KiB keepalive budget.
 *
 * All sending is asynchronous and every failure is contained here: nothing
 * the reports backend or the network does can throw into the app.
 */

import {
  CIRCUIT_BREAK_MS,
  DeliveryGate,
  DeliveryOutcome,
  backoffDelay,
  classifyStatus,
  parseRetryAfter,
} from './delivery-policy.js';
import { isOnline } from './runtime.js';

/** Retryable failures (5xx, network while online) before an event is dropped. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * @typedef {object} DispatcherDependencies
 * @property {import('./event-queue.js').EventQueue} queue
 * @property {{ send(body: string): Promise<import('./transport.js').TransportResponse> }} transport
 * @property {{ send(body: string): boolean } | undefined} pageHideTransport sends without
 *   waiting for the answer; false when the browser refused the body
 * @property {import('./runtime.js').Runtime} runtime
 * @property {import('./logger.js').Logger} logger
 */

export class Dispatcher {
  #queue;
  #transport;
  #pageHideTransport;
  #runtime;
  #logger;
  #gate = new DeliveryGate();
  #consecutiveFailures = 0;
  /** @type {string | null} */
  #inFlightId = null;
  /** @type {Promise<void> | null} */
  #drainPromise = null;
  /** @type {unknown} */
  #timer = null;
  #timerDueAt = 0;
  #disposed = false;

  /**
   * @param {DispatcherDependencies} dependencies
   */
  constructor({ queue, transport, pageHideTransport, runtime, logger }) {
    this.#queue = queue;
    this.#transport = transport;
    this.#pageHideTransport = pageHideTransport;
    this.#runtime = runtime;
    this.#logger = logger;
  }

  /**
   * Queues a serialized event; sending starts on the next task, never inside
   * the app's error path.
   *
   * @param {string} body
   */
  enqueue(body) {
    this.#queue.add({
      id: this.#runtime.createId(),
      body,
      createdAt: this.#runtime.now(),
      attempts: 0,
    });
    this.#scheduleDrain(0);
  }

  /**
   * Sends queued events until the queue is empty, the browser is offline or
   * the gate (circuit breaker, Retry-After, backoff) closes. Concurrent calls
   * share one run.
   *
   * @returns {Promise<void>}
   */
  drain() {
    this.#drainPromise ??= this.#drainQueue().finally(() => {
      this.#drainPromise = null;
    });
    return this.#drainPromise;
  }

  /**
   * Hands every queued event to the page-hide transport (a keepalive fetch,
   * or sendBeacon); called while the page is being hidden, when a pending
   * timer may never run. Skipped offline and while the gate is closed, so
   * the server's back-off requests still hold and a persisted queue keeps
   * its events for the next visit. What the browser refuses stays queued.
   */
  flushOnPageHide() {
    try {
      if (!this.#pageHideTransport || this.#disposed || !isOnline(this.#runtime)) {
        return;
      }
      if (this.#gate.isBlocked(this.#runtime.now())) {
        return;
      }
      for (const record of this.#queue.records()) {
        if (record.id === this.#inFlightId) {
          continue;
        }
        if (!this.#pageHideTransport.send(record.body)) {
          return;
        }
        this.#queue.remove(record.id);
      }
    } catch (failure) {
      this.#logger.warn('page-hide flush failed', failure);
    }
  }

  /** Stops the retry timer; queued events stay in the store, if any. */
  dispose() {
    this.#disposed = true;
    this.#cancelTimer();
  }

  async #drainQueue() {
    try {
      while (!this.#disposed) {
        const record = this.#queue.first();
        if (!record || !isOnline(this.#runtime)) {
          return;
        }
        const now = this.#runtime.now();
        if (this.#gate.isBlocked(now)) {
          this.#scheduleDrain(this.#gate.blockedUntil - now);
          return;
        }
        this.#inFlightId = record.id;
        const response = await this.#transport.send(record.body);
        this.#inFlightId = null;
        this.#handleResponse(record, response);
      }
    } catch (failure) {
      this.#logger.warn('delivery failed unexpectedly', failure);
    } finally {
      this.#inFlightId = null;
    }
  }

  /**
   * @param {import('./event-queue.js').QueuedEvent} record
   * @param {import('./transport.js').TransportResponse} response
   */
  #handleResponse(record, response) {
    const now = this.#runtime.now();
    switch (classifyStatus(response.status)) {
      case DeliveryOutcome.DELIVERED:
        this.#queue.remove(record.id);
        this.#consecutiveFailures = 0;
        return;
      case DeliveryOutcome.REJECTED:
        this.#queue.remove(record.id);
        this.#consecutiveFailures = 0;
        this.#logger.warn(`event dropped: the reports backend answered HTTP ${response.status}`);
        return;
      case DeliveryOutcome.UNAUTHORIZED:
        this.#queue.remove(record.id);
        this.#gate.blockFor(CIRCUIT_BREAK_MS, now);
        this.#logger.warn(
          `event dropped and sending paused for 5 minutes: HTTP ${response.status}; ` +
            "check REPORTS_KEY and the key's allowed origins",
        );
        return;
      case DeliveryOutcome.THROTTLED:
        this.#gate.blockFor(parseRetryAfter(response.retryAfter, now), now);
        return;
      default:
        this.#handleRetryableFailure(record, now);
    }
  }

  /**
   * @param {import('./event-queue.js').QueuedEvent} record
   * @param {number} now
   */
  #handleRetryableFailure(record, now) {
    if (!isOnline(this.#runtime)) {
      // Not the event's fault: the 'online' listener resumes delivery.
      return;
    }
    this.#consecutiveFailures += 1;
    record.attempts += 1;
    if (record.attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.#queue.remove(record.id);
      this.#logger.warn(`event dropped after ${MAX_DELIVERY_ATTEMPTS} failed attempts`);
    } else {
      this.#queue.update(record);
    }
    this.#gate.blockFor(backoffDelay(this.#consecutiveFailures, this.#runtime.random), now);
  }

  /**
   * Keeps at most one timer, due at the earliest requested time.
   *
   * @param {number} delayMs
   */
  #scheduleDrain(delayMs) {
    if (this.#disposed) {
      return;
    }
    const dueAt = this.#runtime.now() + Math.max(0, delayMs);
    if (this.#timer !== null && this.#timerDueAt <= dueAt) {
      return;
    }
    this.#cancelTimer();
    this.#timerDueAt = dueAt;
    this.#timer = this.#runtime.setTimeout(
      () => {
        this.#timer = null;
        void this.drain();
      },
      Math.max(0, delayMs),
    );
  }

  #cancelTimer() {
    if (this.#timer !== null) {
      this.#runtime.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
