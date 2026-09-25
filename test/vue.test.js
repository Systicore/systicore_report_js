import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';

import { flush, init, reportHttpError } from '../src/index.js';
import { installVueErrorHandler } from '../src/vue.js';
import { VALID_OPTIONS, createFetchRecorder } from './support/fake-runtime.js';

/** A component public instance as Vue hands it to app.config.errorHandler. */
function componentInstance({ name, routePath } = {}) {
  const instance = { $options: { __name: name } };
  if (routePath) {
    instance.$route = { path: '/vault/42', matched: [{ path: '/vault' }, { path: routePath }] };
  }
  return instance;
}

describe('Vue adapter', () => {
  const originalFetch = globalThis.fetch;
  /** @type {ReturnType<typeof createFetchRecorder>} */
  let recorder;

  before(() => {
    mock.method(console, 'error', () => {});
  });

  beforeEach(() => {
    recorder = createFetchRecorder();
    globalThis.fetch = /** @type {any} */ (recorder.fetch);
    init(VALID_OPTIONS);
  });

  afterEach(() => {
    init({ enabled: false });
  });

  after(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('reports errors with the route template, component and hook', async () => {
    const app = { config: {} };
    installVueErrorHandler(app);
    const error = new Error('render failed');
    /** @type {any} */ (app.config).errorHandler(
      error,
      componentInstance({ name: 'VaultView', routePath: '/vault/:id' }),
      'render function',
    );
    await flush();

    const { error: reported, context } = recorder.requests[0].body;
    assert.equal(reported.message, 'render failed');
    assert.equal(context.route, '/vault/:id');
    assert.deepEqual(context.tags, {
      mechanism: 'vue.errorHandler',
      'vue.info': 'render function',
      'vue.component': 'VaultView',
    });
  });

  test('keeps the error code of a production build', async () => {
    const app = { config: {} };
    installVueErrorHandler(app);
    /** @type {any} */ (app.config).errorHandler(
      new Error('render failed'),
      componentInstance({ name: 'VaultView' }),
      'https://vuejs.org/error-reference/#runtime-1',
    );
    await flush();

    assert.equal(recorder.requests[0].body.context.tags['vue.info'], 'runtime-1');
  });

  test('chains the handler that was installed before', async () => {
    const calls = [];
    const previous = function (error, instance, info) {
      calls.push([this, error, instance, info]);
    };
    const app = { config: { errorHandler: previous } };
    installVueErrorHandler(app);
    const error = new Error('watcher failed');
    const instance = componentInstance();
    /** @type {any} */ (app.config.errorHandler).call(app, error, instance, 'watcher callback');
    await flush();

    assert.deepEqual(calls, [[app, error, instance, 'watcher callback']]);
    assert.equal(recorder.requests.length, 1);
  });

  test('skips an error the app passed to reportHttpError, but still chains', async () => {
    const calls = [];
    const app = { config: { errorHandler: (error) => calls.push(error) } };
    installVueErrorHandler(app);
    const apiError = Object.assign(new Error('Forbidden'), { status: 403 });
    reportHttpError({ method: 'GET', urlTemplate: '/api/plans/:id', status: 403, error: apiError });
    /** @type {any} */ (app.config.errorHandler)(apiError, componentInstance(), 'setup function');
    await flush();

    assert.deepEqual(calls, [apiError]);
    assert.equal(recorder.requests.length, 0);
  });

  test('without a previous handler the error is still logged', () => {
    const consoleError = /** @type {any} */ (console.error);
    consoleError.mock.resetCalls();
    const app = { config: {} };
    installVueErrorHandler(app);
    const error = new Error('logged');
    /** @type {any} */ (app.config).errorHandler(error, null, 'setup function');
    assert.deepEqual(consoleError.mock.calls[0].arguments, [error]);
  });

  test('uninstall restores the previous handler; install is idempotent', () => {
    const previous = () => {};
    const app = { config: { errorHandler: previous } };
    const uninstall = installVueErrorHandler(app);
    const installedHandler = app.config.errorHandler;
    assert.notEqual(installedHandler, previous);
    assert.equal(installVueErrorHandler(app), uninstall);
    assert.equal(app.config.errorHandler, installedHandler);

    uninstall();
    assert.equal(app.config.errorHandler, previous);
  });

  test('tolerates an app without config', () => {
    assert.doesNotThrow(() => installVueErrorHandler(/** @type {any} */ ({}))());
  });
});
