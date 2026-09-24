/**
 * A controllable browser Runtime for the reporter: manual clock and timers,
 * a scripted fetch that records requests, a recording sendBeacon, and
 * EventTargets standing in for window and document.
 */

export const START_TIME = Date.parse('2026-09-24T10:00:00.000Z');

export const CHROME_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Lets pending promise chains (fetch → drain loop) run to completion. */
export async function settle() {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export class FakeClock {
  now = START_TIME;
  /** @type {Map<number, { dueAt: number, callback: () => void }>} */
  #timers = new Map();
  #nextHandle = 1;

  setTimeout = (callback, delay) => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, { dueAt: this.now + Math.max(0, delay), callback });
    return handle;
  };

  clearTimeout = (handle) => {
    this.#timers.delete(handle);
  };

  get pendingTimers() {
    return this.#timers.size;
  }

  /** Moves time forward, running every timer that falls due on the way. */
  async advance(milliseconds) {
    const target = this.now + milliseconds;
    for (;;) {
      const next = this.#nextDue(target);
      if (!next) {
        break;
      }
      this.#timers.delete(next.handle);
      this.now = next.dueAt;
      next.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }

  #nextDue(target) {
    let earliest = null;
    for (const [handle, timer] of this.#timers) {
      if (timer.dueAt <= target && (!earliest || timer.dueAt < earliest.dueAt)) {
        earliest = { handle, ...timer };
      }
    }
    return earliest;
  }
}

/**
 * @param {(request: { url: string, init: any, index: number }) => ({ status: number, headers?: Record<string, string> } | Error)} [respond]
 */
export function createFetchRecorder(respond = () => ({ status: 202 })) {
  const requests = [];
  let responder = respond;
  const fetch = async (url, init) => {
    const request = { url, init, body: JSON.parse(init.body), index: requests.length };
    requests.push(request);
    const answer = responder(request);
    if (answer instanceof Error) {
      throw answer;
    }
    const headers = Object.fromEntries(
      Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return {
      status: answer.status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    };
  };
  return {
    fetch,
    requests,
    respondWith(nextResponder) {
      responder = nextResponder;
    },
  };
}

export function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

/**
 * @param {object} [overrides] Runtime fields to replace
 */
export function createTestRuntime(overrides = {}) {
  const clock = new FakeClock();
  const fetchRecorder = createFetchRecorder();
  const beacons = [];
  let beaconAccepts = true;
  let nextId = 1;
  const windowTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const navigator = { onLine: true, userAgent: CHROME_ON_WINDOWS };
  const runtime = {
    fetch: fetchRecorder.fetch,
    supportsKeepalive: true,
    sendBeacon: (url, body) => {
      if (!beaconAccepts) {
        return false;
      }
      beacons.push({ url, body: JSON.parse(body) });
      return true;
    },
    windowTarget,
    documentTarget,
    navigator,
    location: { href: 'https://app.example/vault/42?token=secret#details' },
    localStorage: createMemoryStorage(),
    indexedDB: undefined,
    now: () => clock.now,
    random: () => 0.5,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    createId: () => `id-${nextId++}`,
    ...overrides,
  };
  return {
    runtime,
    clock,
    fetchRecorder,
    requests: fetchRecorder.requests,
    beacons,
    windowTarget,
    documentTarget,
    navigator,
    setBeaconAccepts(accepts) {
      beaconAccepts = accepts;
    },
    goOffline() {
      navigator.onLine = false;
      windowTarget.dispatchEvent(new Event('offline'));
    },
    goOnline() {
      navigator.onLine = true;
      windowTarget.dispatchEvent(new Event('online'));
    },
  };
}

export const VALID_OPTIONS = Object.freeze({
  enabled: true,
  url: 'https://reports.example',
  key: 'scpk_test_0123456789abcdefghijklmnopqrstuv',
  source: 'tarp-crm_web',
  environment: 'production',
  release: { version: '1.4.2+17', commit: 'abc1234', buildTime: '2026-09-24T09:00:00Z' },
});
