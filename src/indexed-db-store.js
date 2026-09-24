/**
 * QueueStore backed by IndexedDB, for offline-first apps (the tarp-planner
 * PWA is used on site, often without a connection): events captured offline
 * survive a reload or a closed tab and are replayed on the next start.
 *
 * Best effort by design. Every failure (no IndexedDB, private mode, quota,
 * a blocked upgrade) degrades to "not persisted" and never reaches the app.
 */

/** @typedef {import('./event-queue.js').QueueStore} QueueStore */

const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'events';
const DATABASE_NAME_PREFIX = 'systicore-report';

/**
 * @param {string | undefined} source the reporting component, e.g. tarp-planner_web
 * @returns {string}
 */
export function queueDatabaseName(source) {
  return source ? `${DATABASE_NAME_PREFIX}:${source}` : DATABASE_NAME_PREFIX;
}

/** @implements {QueueStore} */
export class IndexedDbStore {
  #factory;
  #databaseName;
  /** @type {Promise<IDBDatabase | null> | null} */
  #databasePromise = null;

  /**
   * @param {IDBFactory} factory usually globalThis.indexedDB
   * @param {string} databaseName
   */
  constructor(factory, databaseName) {
    this.#factory = factory;
    this.#databaseName = databaseName;
  }

  /**
   * @returns {Promise<unknown[]>}
   */
  async loadAll() {
    const database = await this.#open();
    if (!database) {
      return [];
    }
    return new Promise((resolve) => {
      try {
        const request = database
          .transaction(OBJECT_STORE_NAME, 'readonly')
          .objectStore(OBJECT_STORE_NAME)
          .getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * @param {import('./event-queue.js').QueuedEvent} record
   */
  save(record) {
    void this.#write((objectStore) => objectStore.put({ ...record }));
  }

  /**
   * @param {string} id
   */
  remove(id) {
    void this.#write((objectStore) => objectStore.delete(id));
  }

  /**
   * Writes are queued behind the same open promise, so they reach IndexedDB
   * in call order, and IndexedDB runs read-write transactions on one object
   * store in creation order.
   *
   * @param {(objectStore: IDBObjectStore) => void} operation
   * @returns {Promise<void>}
   */
  async #write(operation) {
    const database = await this.#open();
    if (!database) {
      return;
    }
    try {
      operation(
        database.transaction(OBJECT_STORE_NAME, 'readwrite').objectStore(OBJECT_STORE_NAME),
      );
    } catch {
      // Quota or a closing connection: the event stays in memory only.
    }
  }

  /**
   * @returns {Promise<IDBDatabase | null>}
   */
  #open() {
    this.#databasePromise ??= new Promise((resolve) => {
      try {
        const request = this.#factory.open(this.#databaseName, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
            database.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          // Another tab upgrading the schema must not wait on this connection.
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.#databasePromise;
  }
}
