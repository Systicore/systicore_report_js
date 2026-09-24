/**
 * The small slice of IndexedDB that IndexedDbStore uses: open with an
 * upgrade, one object store with a key path, put/delete/getAll. Requests
 * complete asynchronously, as in a browser; the data outlives connections,
 * so a second "page load" sees what the first one stored.
 */

function later(callback) {
  setImmediate(callback);
}

class FakeRequest {
  result = undefined;
  error = null;
  onsuccess = null;
  onerror = null;
  onupgradeneeded = null;

  succeed(result) {
    later(() => {
      this.result = result;
      this.onsuccess?.({ target: this });
    });
  }
}

class FakeObjectStore {
  #records;
  #keyPath;

  constructor(records, keyPath) {
    this.#records = records;
    this.#keyPath = keyPath;
  }

  put(value) {
    const request = new FakeRequest();
    this.#records.set(value[this.#keyPath], structuredClone(value));
    request.succeed(value[this.#keyPath]);
    return request;
  }

  delete(key) {
    const request = new FakeRequest();
    this.#records.delete(key);
    request.succeed(undefined);
    return request;
  }

  getAll() {
    const request = new FakeRequest();
    request.succeed([...this.#records.values()].map((value) => structuredClone(value)));
    return request;
  }
}

class FakeDatabase {
  /** @type {Map<string, { keyPath: string, records: Map<unknown, unknown> }>} */
  stores;
  onversionchange = null;

  constructor(stores) {
    this.stores = stores;
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }

  createObjectStore(name, { keyPath }) {
    this.stores.set(name, { keyPath, records: new Map() });
  }

  transaction(name) {
    const store = this.stores.get(name);
    if (!store) {
      throw new Error(`NotFoundError: no object store ${name}`);
    }
    return { objectStore: () => new FakeObjectStore(store.records, store.keyPath) };
  }

  close() {}
}

export class FakeIndexedDb {
  /** @type {Map<string, Map<string, { keyPath: string, records: Map<unknown, unknown> }>>} */
  databases = new Map();

  open(name) {
    const request = new FakeRequest();
    later(() => {
      const isNew = !this.databases.has(name);
      if (isNew) {
        this.databases.set(name, new Map());
      }
      request.result = new FakeDatabase(this.databases.get(name));
      if (isNew) {
        request.onupgradeneeded?.({ target: request });
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  /** Records of one object store, for assertions. */
  records(databaseName, storeName = 'events') {
    return [...(this.databases.get(databaseName)?.get(storeName)?.records.values() ?? [])];
  }
}
