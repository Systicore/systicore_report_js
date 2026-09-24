/**
 * Serialized events waiting to be delivered, oldest first.
 *
 * The queue itself always lives in memory, so the page-hide flush can read it
 * synchronously (a request that outlives the page has to start inside the
 * pagehide handler). A QueueStore mirrors it for persistence across reloads:
 * the in-memory NULL_STORE by default, or IndexedDbStore for offline-first
 * apps.
 */

/** Persisted events older than this are discarded instead of replayed. */
export const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * @typedef {object} QueuedEvent
 * @property {string} id
 * @property {string} body the serialized ingest event
 * @property {number} createdAt epoch milliseconds
 * @property {number} attempts failed delivery attempts so far
 */

/**
 * @typedef {object} QueueStore
 * @property {() => Promise<unknown[]>} loadAll
 * @property {(record: QueuedEvent) => void} save
 * @property {(id: string) => void} remove
 */

/** @type {QueueStore} */
export const NULL_STORE = Object.freeze({
  loadAll: async () => [],
  save: () => {},
  remove: () => {},
});

export class EventQueue {
  /** @type {QueuedEvent[]} */
  #records = [];
  #capacity;
  #store;

  /**
   * @param {number} capacity beyond it the oldest event is dropped
   * @param {QueueStore} [store]
   */
  constructor(capacity, store = NULL_STORE) {
    this.#capacity = capacity;
    this.#store = store;
  }

  get size() {
    return this.#records.length;
  }

  /**
   * @param {QueuedEvent} record
   */
  add(record) {
    this.#records.push(record);
    this.#store.save(record);
    this.#dropOverflow();
  }

  /**
   * @returns {QueuedEvent | undefined}
   */
  first() {
    return this.#records[0];
  }

  /**
   * @returns {QueuedEvent[]} a copy, oldest first
   */
  records() {
    return [...this.#records];
  }

  /**
   * Persists a changed attempt count.
   *
   * @param {QueuedEvent} record
   */
  update(record) {
    if (this.#records.includes(record)) {
      this.#store.save(record);
    }
  }

  /**
   * @param {string} id
   */
  remove(id) {
    const index = this.#records.findIndex((record) => record.id === id);
    if (index !== -1) {
      this.#records.splice(index, 1);
    }
    this.#store.remove(id);
  }

  /**
   * Adds the events persisted by an earlier page load. Expired records are
   * deleted from the store, malformed ones ignored; the capacity still applies.
   *
   * @param {number} now epoch milliseconds
   * @returns {Promise<void>}
   */
  async restore(now) {
    const stored = await this.#store.loadAll();
    const knownIds = new Set(this.#records.map((record) => record.id));
    for (const candidate of stored) {
      if (!isQueuedEvent(candidate)) {
        continue;
      }
      if (knownIds.has(candidate.id)) {
        continue;
      }
      if (now - candidate.createdAt > MAX_RECORD_AGE_MS) {
        this.#store.remove(candidate.id);
        continue;
      }
      this.#records.push(candidate);
    }
    this.#records.sort((left, right) => left.createdAt - right.createdAt);
    this.#dropOverflow();
  }

  #dropOverflow() {
    while (this.#records.length > this.#capacity) {
      const dropped = this.#records.shift();
      if (dropped) {
        this.#store.remove(dropped.id);
      }
    }
  }
}

/**
 * @param {unknown} candidate
 * @returns {candidate is QueuedEvent}
 */
function isQueuedEvent(candidate) {
  const record = /** @type {Partial<QueuedEvent> | null} */ (candidate);
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.id === 'string' &&
    typeof record.body === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.attempts === 'number'
  );
}
