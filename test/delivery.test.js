import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { backoffDelay, parseRetryAfter } from '../src/delivery-policy.js';
import { MAX_DELIVERY_ATTEMPTS } from '../src/dispatcher.js';
import { createReporter } from '../src/reporter.js';
import { START_TIME, VALID_OPTIONS, createTestRuntime, settle } from './support/fake-runtime.js';

const reporters = [];

function setUp(options = {}, runtimeOverrides = {}) {
  const harness = createTestRuntime(runtimeOverrides);
  const reporter = createReporter({ ...VALID_OPTIONS, ...options }, harness.runtime);
  reporters.push(reporter);
  return { ...harness, reporter };
}

afterEach(() => {
  while (reporters.length > 0) {
    reporters.pop().dispose();
  }
});

const MINUTE = 60_000;

describe('response handling', () => {
  test('sending starts on a timer, outside the caller', async () => {
    const { reporter, requests, clock } = setUp();
    reporter.captureMessage('boom');
    assert.equal(requests.length, 0);
    await clock.advance(0);
    assert.equal(requests.length, 1);
  });

  for (const status of [400, 413, 404, 422]) {
    test(`HTTP ${status} drops the event without retrying`, async () => {
      const { reporter, requests, fetchRecorder, clock } = setUp();
      fetchRecorder.respondWith(() => ({ status }));
      reporter.captureMessage('boom');
      await reporter.flush();
      await clock.advance(10 * MINUTE);
      assert.equal(requests.length, 1);

      fetchRecorder.respondWith(() => ({ status: 202 }));
      reporter.captureMessage('next');
      await reporter.flush();
      assert.equal(requests.length, 2, 'no circuit breaker for a rejected payload');
    });
  }

  for (const status of [401, 403]) {
    test(`HTTP ${status} drops the event and pauses sending for 5 minutes`, async () => {
      const { reporter, requests, fetchRecorder, clock } = setUp();
      fetchRecorder.respondWith(() => ({ status }));
      reporter.captureMessage('first');
      await reporter.flush();
      assert.equal(requests.length, 1);

      fetchRecorder.respondWith(() => ({ status: 202 }));
      reporter.captureMessage('second');
      await reporter.flush();
      await clock.advance(5 * MINUTE - 1000);
      assert.equal(requests.length, 1, 'circuit open: nothing sent');

      await clock.advance(1000);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.error.message, 'second');
    });
  }

  test('HTTP 429 keeps the event and waits for Retry-After seconds', async () => {
    const { reporter, requests, fetchRecorder, clock } = setUp();
    fetchRecorder.respondWith(({ index }) =>
      index === 0 ? { status: 429, headers: { 'Retry-After': '30' } } : { status: 202 },
    );
    reporter.captureMessage('boom');
    await reporter.flush();
    assert.equal(requests.length, 1);

    await clock.advance(29_000);
    assert.equal(requests.length, 1);
    await clock.advance(1_000);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.error.message, 'boom');

    await clock.advance(10 * MINUTE);
    assert.equal(requests.length, 2, 'delivered after the retry');
  });

  test('Retry-After accepts an HTTP date and is bounded', () => {
    const now = START_TIME;
    assert.equal(parseRetryAfter(new Date(now + 120_000).toUTCString(), now), 120_000);
    assert.equal(parseRetryAfter(null, now), 60_000);
    assert.equal(parseRetryAfter('not a date', now), 60_000);
    assert.equal(parseRetryAfter('0', now), 1_000);
    assert.equal(parseRetryAfter('999999', now), 60 * MINUTE);
  });

  test('5xx keeps the event and retries with exponential backoff', async () => {
    const { reporter, requests, fetchRecorder, clock } = setUp();
    fetchRecorder.respondWith(({ index }) => (index < 3 ? { status: 503 } : { status: 202 }));
    reporter.captureMessage('boom');
    await reporter.flush();
    assert.equal(requests.length, 1);

    await clock.advance(1_999);
    assert.equal(requests.length, 1);
    await clock.advance(1);
    assert.equal(requests.length, 2, 'first retry after 2 s');
    await clock.advance(4_000);
    assert.equal(requests.length, 3, 'second retry after 4 s');
    await clock.advance(8_000);
    assert.equal(requests.length, 4, 'third retry after 8 s');
    await clock.advance(10 * MINUTE);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.body.error.message === 'boom'));
  });

  test('backoff grows to 5 minutes with ±20 % jitter', () => {
    assert.equal(
      backoffDelay(1, () => 0.5),
      2_000,
    );
    assert.equal(
      backoffDelay(3, () => 0.5),
      8_000,
    );
    assert.equal(
      backoffDelay(30, () => 0.5),
      5 * MINUTE,
    );
    assert.equal(
      backoffDelay(1, () => 0),
      1_600,
    );
    assert.equal(
      backoffDelay(1, () => 0.999999),
      2_400,
    );
  });

  test(`an event is dropped after ${MAX_DELIVERY_ATTEMPTS} failed attempts`, async () => {
    const { reporter, requests, fetchRecorder, clock } = setUp();
    fetchRecorder.respondWith(() => ({ status: 500 }));
    reporter.captureMessage('boom');
    await reporter.flush();
    await clock.advance(60 * MINUTE);
    assert.equal(requests.length, MAX_DELIVERY_ATTEMPTS);
  });

  test('a network error is retried like a 5xx', async () => {
    const { reporter, requests, fetchRecorder, clock } = setUp();
    fetchRecorder.respondWith(({ index }) =>
      index === 0 ? new TypeError('Failed to fetch') : { status: 202 },
    );
    reporter.captureMessage('boom');
    await reporter.flush();
    await clock.advance(2_000);
    assert.equal(requests.length, 2);
  });

  test('offline: nothing is sent until the browser is back online', async () => {
    const harness = setUp();
    const { reporter, requests, clock } = harness;
    harness.goOffline();
    reporter.captureMessage('captured offline');
    await reporter.flush();
    await clock.advance(10 * MINUTE);
    assert.equal(requests.length, 0);

    harness.goOnline();
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.error.message, 'captured offline');
  });

  test('a network failure detected as offline does not count as an attempt', async () => {
    const harness = setUp();
    const { reporter, requests, fetchRecorder } = harness;
    fetchRecorder.respondWith(({ index }) => {
      if (index === 0) {
        harness.navigator.onLine = false;
        return new TypeError('Failed to fetch');
      }
      return { status: 202 };
    });
    reporter.captureMessage('boom');
    await reporter.flush();
    assert.equal(requests.length, 1);

    harness.goOnline();
    await settle();
    assert.equal(requests.length, 2, 'resent immediately, no backoff');
  });

  test('the queue keeps the newest maxQueue events', async () => {
    const harness = setUp({ maxQueue: 3 });
    const { reporter, requests } = harness;
    harness.goOffline();
    for (const message of ['one', 'two', 'three', 'four', 'five']) {
      reporter.captureMessage(message);
    }
    harness.goOnline();
    await settle();
    assert.deepEqual(
      requests.map((request) => request.body.error.message),
      ['three', 'four', 'five'],
    );
  });
});

describe('page hide', () => {
  const INGEST_URL =
    'https://reports.example/api/v1/ingest?key=scpk_test_0123456789abcdefghijklmnopqrstuv';

  test('pagehide sends queued events as keepalive requests without cookies', async () => {
    const { reporter, requests, beacons, windowTarget, clock } = setUp();
    reporter.captureMessage('one');
    reporter.captureMessage('two');
    windowTarget.dispatchEvent(new Event('pagehide'));

    assert.deepEqual(
      requests.map((request) => request.body.error.message),
      ['one', 'two'],
    );
    for (const { url, init } of requests) {
      assert.equal(url, INGEST_URL);
      assert.equal(init.keepalive, true);
      assert.equal(init.credentials, 'omit');
    }
    assert.equal(beacons.length, 0);
    await clock.advance(0);
    assert.equal(requests.length, 2, 'flushed events are not sent again');
  });

  test('visibilitychange to hidden flushes, visible does not', async () => {
    const { reporter, requests, documentTarget } = setUp();
    reporter.captureMessage('one');
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(requests.length, 0);
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(requests.length, 1);
  });

  test('what does not fit the keepalive budget stays queued', async () => {
    const { reporter, requests, windowTarget, clock } = setUp();
    for (const letter of ['a', 'b']) {
      reporter.captureException(
        Object.assign(new Error(letter.repeat(8_000)), { stack: letter.repeat(32_000) }),
      );
    }
    windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(requests.length, 1, 'two 40 KB bodies exceed the 64 KiB budget');
    assert.ok(requests[0].body.error.message.startsWith('a'));

    await settle();
    await clock.advance(0);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].body.error.message.startsWith('b'));
    assert.equal(requests[1].init.keepalive, true, 'the finished request freed its budget');
  });

  test('without keepalive support, pagehide hands queued events to sendBeacon', async () => {
    const { reporter, requests, beacons, windowTarget, clock } = setUp(
      {},
      { supportsKeepalive: false },
    );
    reporter.captureMessage('one');
    reporter.captureMessage('two');
    windowTarget.dispatchEvent(new Event('pagehide'));

    assert.equal(beacons.length, 2);
    assert.equal(beacons[0].url, INGEST_URL);
    assert.deepEqual(
      beacons.map((beacon) => beacon.body.error.message),
      ['one', 'two'],
    );
    await clock.advance(0);
    assert.equal(requests.length, 0, 'beaconed events are not sent again');
  });

  test('a refused beacon keeps the event queued', async () => {
    const harness = setUp({}, { supportsKeepalive: false });
    const { reporter, requests, beacons, windowTarget, clock } = harness;
    harness.setBeaconAccepts(false);
    reporter.captureMessage('one');
    windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(beacons.length, 0);
    await clock.advance(0);
    assert.equal(requests.length, 1);
  });

  test('no flush while the circuit breaker is open or the browser is offline', async () => {
    const harness = setUp();
    const { reporter, requests, beacons, windowTarget, fetchRecorder } = harness;
    fetchRecorder.respondWith(() => ({ status: 401 }));
    reporter.captureMessage('first');
    await reporter.flush();
    reporter.captureMessage('second');
    windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(requests.length, 1);
    assert.equal(beacons.length, 0);

    const offline = setUp();
    offline.goOffline();
    offline.reporter.captureMessage('offline');
    offline.windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(offline.requests.length, 0);
    assert.equal(offline.beacons.length, 0);
  });

  test('listeners are removed on dispose', async () => {
    const { reporter, requests, beacons, windowTarget } = setUp();
    reporter.captureMessage('one');
    reporter.dispose();
    windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(requests.length, 0);
    assert.equal(beacons.length, 0);
  });
});
