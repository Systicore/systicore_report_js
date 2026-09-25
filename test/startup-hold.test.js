import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HOLD_LIMIT_MILLISECONDS, StartupHold } from '../src/startup-hold.js';
import { FakeClock } from './support/fake-runtime.js';

function setUp() {
  const clock = new FakeClock();
  const hold = new StartupHold(clock);
  const reported = [];
  /** @param {unknown} error */
  const reportOrHold = (error) => hold.reportOrHold(error, () => reported.push(error));
  return { clock, hold, reported, reportOrHold };
}

describe('StartupHold', () => {
  test('without a pending start, an error is reported at once', () => {
    const { reported, reportOrHold, clock } = setUp();
    const error = new Error('while running');
    reportOrHold(error);
    assert.deepEqual(reported, [error]);
    assert.equal(clock.pendingTimers, 0);
  });

  test('while a start is pending, errors wait until it ends, then go in order', () => {
    const { hold, reported, reportOrHold, clock } = setUp();
    const first = new Error('first');
    const second = new Error('second');
    hold.begin();
    reportOrHold(first);
    reportOrHold(second);
    assert.deepEqual(reported, []);

    hold.end();
    assert.deepEqual(reported, [first, second]);
    assert.equal(clock.pendingTimers, 0);
  });

  test('a claimed error is taken out of the hold without being reported', () => {
    const { hold, reported, reportOrHold, clock } = setUp();
    const failure = new Error('the start failed');
    const unrelated = new Error('ResizeObserver loop completed with undelivered notifications');
    hold.begin();
    reportOrHold(unrelated);
    reportOrHold(failure);
    reportOrHold(failure);

    assert.equal(hold.claim(failure), true);
    assert.equal(hold.claim(failure), false);
    assert.equal(hold.claim(new Error('never met')), false);
    hold.end();
    assert.deepEqual(reported, [unrelated]);
    assert.equal(clock.pendingTimers, 0);
  });

  test('a start that does not settle holds an error for the hold limit at most', async () => {
    const { hold, reported, reportOrHold, clock } = setUp();
    const error = new Error('while the start hangs');
    hold.begin();
    reportOrHold(error);

    await clock.advance(HOLD_LIMIT_MILLISECONDS - 1);
    assert.deepEqual(reported, []);
    await clock.advance(1);
    assert.deepEqual(reported, [error]);
    assert.equal(hold.claim(error), false);

    hold.end();
    assert.deepEqual(reported, [error]);
  });

  test('with two starts pending, errors wait for both', () => {
    const { hold, reported, reportOrHold } = setUp();
    const error = new Error('during two starts');
    hold.begin();
    hold.begin();
    reportOrHold(error);
    hold.end();
    assert.deepEqual(reported, []);
    hold.end();
    assert.deepEqual(reported, [error]);
  });

  test('a report that throws does not keep the others back', () => {
    const { hold, reported } = setUp();
    hold.begin();
    hold.reportOrHold(new Error('first'), () => {
      throw new Error('report bug');
    });
    hold.reportOrHold('second', () => reported.push('second'));
    hold.end();
    assert.deepEqual(reported, ['second']);
  });

  test('an unpaired end() does not make later starts release early', () => {
    const { hold, reported, reportOrHold } = setUp();
    hold.end();
    hold.begin();
    reportOrHold('during the start');
    assert.deepEqual(reported, []);
    hold.end();
    assert.deepEqual(reported, ['during the start']);
  });
});
