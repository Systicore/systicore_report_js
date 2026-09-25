/**
 * The public module API against real globals (a fetch stub and a stand-in
 * window). The facade is a module singleton, so the tests run in order and
 * each one leaves a known state behind.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  addBreadcrumb,
  captureException,
  captureMessage,
  flush,
  init,
  installGlobalHandlers,
  isEnabled,
  reportHttpError,
  setUser,
} from '../src/index.js';
import { VALID_OPTIONS, createFetchRecorder } from './support/fake-runtime.js';

describe('public API', () => {
  const originalFetch = globalThis.fetch;
  const recorder = createFetchRecorder();
  const windowTarget = new EventTarget();

  before(() => {
    globalThis.fetch = /** @type {any} */ (recorder.fetch);
    /** @type {any} */ (globalThis).window = windowTarget;
  });

  after(() => {
    init({ enabled: false });
    globalThis.fetch = originalFetch;
    delete (/** @type {any} */ (globalThis).window);
  });

  test('calls before init() are buffered and replayed', async () => {
    addBreadcrumb({ category: 'nav', message: 'boot' });
    setUser({ id: 7 });
    assert.equal(captureMessage('before init'), false);
    assert.equal(isEnabled(), false);

    assert.equal(init(VALID_OPTIONS), true);
    await flush();

    assert.equal(recorder.requests.length, 1);
    const body = recorder.requests[0].body;
    assert.equal(body.error.message, 'before init');
    assert.deepEqual(body.user, { id: '7' });
    assert.equal(body.context.breadcrumbs[0].message, 'boot');
  });

  test('captureException and reportHttpError go through the active reporter', async () => {
    assert.equal(captureException(new Error('after init')), true);
    assert.equal(reportHttpError({ method: 'GET', urlTemplate: '/api/items', status: 503 }), true);
    assert.equal(reportHttpError({ method: 'GET', urlTemplate: '/api/items', status: 404 }), false);
    await flush();
    assert.deepEqual(
      recorder.requests.slice(1).map((request) => request.body.error.message),
      ['after init', 'GET /api/items failed with HTTP 503'],
    );
  });

  test('installGlobalHandlers is idempotent and uninstallable', async () => {
    const uninstall = installGlobalHandlers();
    assert.equal(installGlobalHandlers(), uninstall);

    const uncaught = new TypeError('uncaught');
    windowTarget.dispatchEvent(Object.assign(new Event('error'), { error: uncaught }));
    windowTarget.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('rejected') }),
    );
    await flush();
    const reported = recorder.requests
      .slice(-2)
      .map((request) => [request.body.error.message, request.body.context.tags.mechanism]);
    assert.deepEqual(reported, [
      ['uncaught', 'window.error'],
      ['rejected', 'window.unhandledrejection'],
    ]);

    uninstall();
    uninstall();
    const countAfterUninstall = recorder.requests.length;
    windowTarget.dispatchEvent(Object.assign(new Event('error'), { error: new Error('ignored') }));
    await flush();
    assert.equal(recorder.requests.length, countAfterUninstall);

    const reinstalled = installGlobalHandlers();
    assert.notEqual(reinstalled, uninstall);
    reinstalled();
  });

  test('installGlobalHandlers skips a rejection the app passed to reportHttpError', async () => {
    const uninstall = installGlobalHandlers();
    const apiError = Object.assign(new Error('Not found'), { status: 404 });
    reportHttpError({ method: 'GET', urlTemplate: '/api/items/:id', status: 404, error: apiError });
    const countBefore = recorder.requests.length;
    windowTarget.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: apiError }),
    );
    await flush();
    assert.equal(recorder.requests.length, countBefore);
    uninstall();
  });

  test('never throws, whatever is passed', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    assert.doesNotThrow(() => captureException(hostile));
    assert.doesNotThrow(() => captureException(null, /** @type {any} */ (null)));
    assert.doesNotThrow(() => captureMessage(/** @type {any} */ (Symbol('odd'))));
    assert.doesNotThrow(() => reportHttpError(/** @type {any} */ (null)));
    assert.doesNotThrow(() => addBreadcrumb(/** @type {any} */ (undefined)));
    assert.doesNotThrow(() => setUser(/** @type {any} */ ('not a user')));
    await flush();
  });

  test('init() again replaces the reporter; disabled makes every call a no-op', async () => {
    assert.equal(init({ ...VALID_OPTIONS, enabled: false }), false);
    assert.equal(isEnabled(), false);
    const count = recorder.requests.length;
    assert.equal(captureMessage('while disabled'), false);
    await flush();
    assert.equal(recorder.requests.length, count);
  });
});
