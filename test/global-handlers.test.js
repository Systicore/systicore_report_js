import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { installWindowErrorHandlers } from '../src/global-handlers.js';

/** @param {string} type @param {Record<string, unknown>} fields */
function eventWith(type, fields) {
  return Object.assign(new Event(type), fields);
}

describe('installWindowErrorHandlers', () => {
  /** @type {EventTarget} */
  let windowTarget;
  /** @type {Array<[unknown, string]>} */
  let captured;
  /** @type {() => void} */
  let uninstall;

  beforeEach(() => {
    windowTarget = new EventTarget();
    captured = [];
    uninstall = installWindowErrorHandlers(windowTarget, (error, mechanism) =>
      captured.push([error, mechanism]),
    );
  });

  afterEach(() => uninstall());

  test('reports the error of an ErrorEvent', () => {
    const error = new RangeError('bad index');
    windowTarget.dispatchEvent(
      eventWith('error', { error, message: 'Uncaught RangeError: bad index' }),
    );
    assert.deepEqual(captured, [[error, 'window.error']]);
  });

  test('builds an error from message and location when the error is missing', () => {
    windowTarget.dispatchEvent(
      eventWith('error', {
        message: 'Uncaught oops',
        filename: 'https://app.example/main.js',
        lineno: 3,
        colno: 7,
      }),
    );
    assert.deepEqual(captured[0][0], {
      name: 'Error',
      message: 'Uncaught oops',
      stack: 'Error: Uncaught oops\n    at https://app.example/main.js:3:7',
    });
  });

  test('skips the opaque "Script error." of cross-origin scripts', () => {
    windowTarget.dispatchEvent(eventWith('error', { message: 'Script error.', filename: '' }));
    assert.equal(captured.length, 0);
  });

  test('reports the reason of an unhandled rejection', () => {
    const reason = new Error('rejected');
    windowTarget.dispatchEvent(eventWith('unhandledrejection', { reason }));
    assert.deepEqual(captured, [[reason, 'window.unhandledrejection']]);
  });

  test('uninstall removes both listeners', () => {
    uninstall();
    windowTarget.dispatchEvent(eventWith('error', { error: new Error('late') }));
    windowTarget.dispatchEvent(eventWith('unhandledrejection', { reason: 'late' }));
    assert.equal(captured.length, 0);
  });
});
