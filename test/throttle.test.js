import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { createReporter } from '../src/reporter.js';
import { DuplicateFilter, RateLimiter } from '../src/throttle.js';
import { VALID_OPTIONS, createTestRuntime } from './support/fake-runtime.js';

const reporters = [];

function setUp(options = {}) {
  const harness = createTestRuntime();
  const reporter = createReporter({ ...VALID_OPTIONS, ...options }, harness.runtime);
  reporters.push(reporter);
  return { ...harness, reporter };
}

afterEach(() => {
  while (reporters.length > 0) {
    reporters.pop().dispose();
  }
});

describe('duplicate suppression', () => {
  test('the same error within 60 seconds is sent once', async () => {
    const { reporter, requests, clock } = setUp();
    assert.equal(reporter.captureMessage('boom', { action: 'save' }), true);
    await clock.advance(30_000);
    assert.equal(reporter.captureMessage('boom', { action: 'save' }), false);
    assert.equal(
      reporter.captureMessage('boom', { action: 'load' }),
      true,
      'another action is another error',
    );
    await clock.advance(30_000);
    assert.equal(reporter.captureMessage('boom', { action: 'save' }), true, 'window over');
    await reporter.flush();
    assert.equal(requests.length, 3);
  });

  test('the same Error object is reported once, even through two handlers', async () => {
    const { reporter, requests } = setUp();
    const error = new Error('seen twice');
    assert.equal(reporter.captureException(error), true);
    await reporter.flush();
    assert.equal(reporter.captureException(error), false);
    await reporter.flush();
    assert.equal(requests.length, 1);
  });

  test('the filter forgets entries after the window', () => {
    const filter = new DuplicateFilter(1_000);
    assert.equal(filter.isDuplicate('a', 0), false);
    assert.equal(filter.isDuplicate('a', 999), true);
    assert.equal(filter.isDuplicate('a', 1_000), false);
  });
});

describe('rate limit', () => {
  test('at most 20 events per minute by default', async () => {
    const { reporter, requests, clock } = setUp();
    const accepted = Array.from({ length: 25 }, (_, index) =>
      reporter.captureMessage(`error ${index}`),
    );
    assert.equal(accepted.filter(Boolean).length, 20);
    await reporter.flush();
    assert.equal(requests.length, 20);

    await clock.advance(60_000);
    assert.equal(reporter.captureMessage('after a minute'), true);
  });

  test('the limit is configurable', () => {
    const { reporter } = setUp({ rateLimitPerMinute: 2 });
    assert.deepEqual(
      ['a', 'b', 'c'].map((message) => reporter.captureMessage(message)),
      [true, true, false],
    );
  });

  test('the window slides', () => {
    const limiter = new RateLimiter(2);
    assert.equal(limiter.tryAcquire(0), true);
    assert.equal(limiter.tryAcquire(30_000), true);
    assert.equal(limiter.tryAcquire(59_999), false);
    assert.equal(limiter.tryAcquire(60_000), true);
    assert.equal(limiter.tryAcquire(60_001), false);
    assert.equal(limiter.tryAcquire(90_000), true);
  });
});
