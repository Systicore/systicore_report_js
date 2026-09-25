import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';

import {
  ReportingErrorHandler,
  bootstrapWithReporting,
  isHttpErrorResponse,
  reportHttpErrorResponse,
} from '../src/angular.js';
import { captureMessage, flush, init, reportHttpError } from '../src/index.js';
import { HOLD_LIMIT_MILLISECONDS } from '../src/startup-hold.js';
import { VALID_OPTIONS, createFetchRecorder } from './support/fake-runtime.js';

/** The fields of Angular's HttpErrorResponse the adapter reads. */
function httpErrorResponse(status, url, headers = {}) {
  return {
    name: 'HttpErrorResponse',
    ok: false,
    status,
    statusText: status === 0 ? 'Unknown Error' : 'Server Error',
    url,
    message: `Http failure response for ${url}: ${status}`,
    error: null,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

/** What the recorded requests reported: [type, code, severity, action] each. */
function reportedEvents(recorder) {
  return recorder.requests.map(({ body }) => [
    body.error.type,
    body.error.code,
    body.error.severity,
    body.error.action,
  ]);
}

/**
 * Gives the page a navigator whose onLine the test switches, and restarts
 * the reporter so it reads that navigator.
 *
 * @param {import('node:test').TestContext} context
 */
function useSwitchableNavigator(context) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const switchableNavigator = { onLine: true, userAgent: 'Mozilla/5.0 (test)' };
  Object.defineProperty(globalThis, 'navigator', {
    value: switchableNavigator,
    configurable: true,
    writable: true,
  });
  context.after(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor);
    } else {
      delete (/** @type {any} */ (globalThis).navigator);
    }
  });
  init(VALID_OPTIONS);
  return switchableNavigator;
}

describe('Angular adapter', () => {
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

  test('ReportingErrorHandler can be constructed by Angular DI (no constructor arguments)', () => {
    assert.equal(ReportingErrorHandler.length, 0);
    assert.equal(typeof new ReportingErrorHandler().handleError, 'function');
  });

  test('handleError logs like Angular and reports the error', async () => {
    const consoleError = /** @type {any} */ (console.error);
    consoleError.mock.resetCalls();
    const error = new TypeError('Cannot read properties of undefined');
    new ReportingErrorHandler().handleError(error);
    await flush();

    assert.deepEqual(consoleError.mock.calls[0].arguments, ['ERROR', error]);
    assert.equal(recorder.requests.length, 1);
    assert.equal(recorder.requests[0].body.error.type, 'TypeError');
    assert.deepEqual(recorder.requests[0].body.context.tags, { mechanism: 'angular.ErrorHandler' });
  });

  test('handleError unwraps a Zone.js promise rejection', async () => {
    const original = new Error('original');
    new ReportingErrorHandler().handleError(
      Object.assign(new Error('Uncaught (in promise): original'), { rejection: original }),
    );
    await flush();
    assert.equal(recorder.requests[0].body.error.message, 'original');
  });

  test('an HttpErrorResponse reaching handleError is reported only for 5xx and network failures', async () => {
    const handler = new ReportingErrorHandler();
    handler.handleError(httpErrorResponse(404, 'https://api.example/api/items/5'));
    handler.handleError(httpErrorResponse(500, 'https://api.example/api/items/5?x=1'));
    await flush();

    assert.equal(recorder.requests.length, 1);
    assert.equal(recorder.requests[0].body.error.action, '/api/items/:id');
    assert.equal(recorder.requests[0].body.error.code, 'HTTP_500');
  });

  test('reportHttpErrorResponse uses the request method and the request id header', async () => {
    const response = httpErrorResponse(503, 'https://api.example/api/vault/42', {
      'x-request-id': 'req-7',
    });
    assert.equal(
      reportHttpErrorResponse(response, { method: 'PUT', url: 'https://api.example/api/vault/42' }),
      true,
    );
    await flush();

    const { error, context } = recorder.requests[0].body;
    assert.equal(error.action, 'PUT /api/vault/:id');
    assert.equal(context.requestId, 'req-7');
  });

  test('a status 0 response is a network failure', async () => {
    reportHttpErrorResponse(httpErrorResponse(0, 'https://api.example/api/items?token=secret'), {
      method: 'GET',
      url: 'https://api.example/api/items',
    });
    await flush();
    const { error, context } = recorder.requests[0].body;
    assert.equal(error.type, 'NetworkError');
    assert.equal(error.severity, 'warning');
    assert.equal(context.tags['http.error'], 'HttpErrorResponse');
  });

  test('a relative request URL reaches the report only as a template', async () => {
    const url = '/api/items/42?email=john@x.com';
    reportHttpErrorResponse(httpErrorResponse(0, url), { method: 'GET', url });
    await flush();
    const { body, init: request } = recorder.requests[0];
    assert.equal(body.error.action, 'GET /api/items/:id');
    assert.ok(!request.body.includes('john@x.com'), request.body);
    assert.ok(!request.body.includes('/api/items/42'), request.body);
  });

  test('the interceptor and the ErrorHandler report one failure once', async () => {
    const response = httpErrorResponse(500, 'https://api.example/api/items');
    reportHttpErrorResponse(response, { method: 'GET', url: 'https://api.example/api/items' });
    new ReportingErrorHandler().handleError(response);
    await flush();
    assert.equal(recorder.requests.length, 1);
  });

  test('a 4xx seen by the interceptor and the ErrorHandler leaves one breadcrumb', async () => {
    const response = httpErrorResponse(404, 'https://api.example/api/products/topps-chrome');
    reportHttpErrorResponse(response, { method: 'GET', url: '/api/products/topps-chrome' });
    new ReportingErrorHandler().handleError(response);
    captureMessage('later failure');
    await flush();

    assert.equal(recorder.requests.length, 1);
    assert.deepEqual(
      recorder.requests[0].body.context.breadcrumbs.map((breadcrumb) => breadcrumb.message),
      ['GET /api/products/topps-chrome → 404'],
    );
  });

  test('an error the app passed to reportHttpError is logged but not reported again', async () => {
    const consoleError = /** @type {any} */ (console.error);
    consoleError.mock.resetCalls();
    const apiError = Object.assign(new Error('Validation failed'), { status: 422 });
    reportHttpError({ method: 'POST', urlTemplate: '/api/items', status: 422, error: apiError });
    new ReportingErrorHandler().handleError(apiError);
    await flush();

    assert.equal(recorder.requests.length, 0);
    assert.deepEqual(consoleError.mock.calls[0].arguments, ['ERROR', apiError]);
  });

  test('beforeHandle runs first; "handled" stops logging and reporting', async () => {
    const consoleError = /** @type {any} */ (console.error);
    consoleError.mock.resetCalls();
    const steps = [];
    const chunkLoadError = Object.assign(new Error('Loading chunk 7 failed'), {
      name: 'ChunkLoadError',
    });
    const handler = new ReportingErrorHandler({
      beforeHandle: (error) => {
        steps.push(['beforeHandle', error, consoleError.mock.callCount()]);
        return 'handled';
      },
    });
    handler.handleError(
      Object.assign(new Error('Uncaught (in promise)'), { rejection: chunkLoadError }),
    );
    await flush();

    assert.deepEqual(steps, [['beforeHandle', chunkLoadError, 0]]);
    assert.equal(consoleError.mock.callCount(), 0);
    assert.equal(recorder.requests.length, 0);
  });

  test('"skip" logs the error but does not report it', async () => {
    const consoleError = /** @type {any} */ (console.error);
    consoleError.mock.resetCalls();
    const error = new Error('ExpressionChangedAfterItHasBeenChecked');
    new ReportingErrorHandler({ beforeHandle: () => 'skip' }).handleError(error);
    new ReportingErrorHandler({ beforeHandle: () => 'skip' }).handleError(
      httpErrorResponse(503, 'https://api.example/api/items'),
    );
    await flush();

    assert.deepEqual(consoleError.mock.calls[0].arguments, ['ERROR', error]);
    assert.equal(recorder.requests.length, 0);
  });

  test('"report", no decision, an unknown value or a throwing hook report as before', async () => {
    const hooks = [
      () => 'report',
      () => undefined,
      () => 'later',
      () => {
        throw new Error('hook bug');
      },
    ];
    for (const [index, beforeHandle] of hooks.entries()) {
      new ReportingErrorHandler({ beforeHandle }).handleError(new Error(`failure ${index}`));
    }
    new ReportingErrorHandler(null).handleError(new Error('without options'));
    await flush();

    assert.deepEqual(
      recorder.requests.map((request) => request.body.error.message),
      ['failure 0', 'failure 1', 'failure 2', 'failure 3', 'without options'],
    );
  });

  test('a subclass can act first and then hand over to the reporting handler', async () => {
    class AppErrorHandler extends ReportingErrorHandler {
      reloads = 0;

      /** @param {unknown} error */
      handleError(error) {
        if (error instanceof Error && error.name === 'ChunkLoadError') {
          this.reloads += 1;
          return;
        }
        super.handleError(error);
      }
    }
    assert.equal(AppErrorHandler.length, 0);
    const handler = new AppErrorHandler();
    handler.handleError(
      Object.assign(new Error('Loading chunk 3 failed'), { name: 'ChunkLoadError' }),
    );
    handler.handleError(new Error('real failure'));
    await flush();

    assert.equal(handler.reloads, 1);
    assert.deepEqual(
      recorder.requests.map((request) => request.body.error.message),
      ['real failure'],
    );
  });

  describe('bootstrapWithReporting', () => {
    /**
     * What Angular's bootstrap does with an app-initializer failure: hand it
     * to the ErrorHandler, then reject with it.
     */
    function failingBootstrap(handler, failure) {
      return async () => {
        await Promise.resolve();
        handler.handleError(failure);
        throw failure;
      };
    }

    test('an error the ErrorHandler sees while bootstrapping is sent once, as critical', async () => {
      const handler = new ReportingErrorHandler();
      const failure = new Error('APP_INITIALIZER failed');
      await assert.rejects(
        bootstrapWithReporting(failingBootstrap(handler, failure)),
        (error) => error === failure,
      );
      handler.handleError(new Error('after bootstrap'));
      await flush();

      assert.deepEqual(
        recorder.requests.map(({ body }) => [
          body.error.message,
          body.error.severity,
          body.error.action,
        ]),
        [
          ['APP_INITIALIZER failed', 'critical', 'bootstrap'],
          ['after bootstrap', 'error', undefined],
        ],
      );
      assert.deepEqual(recorder.requests[0].body.context.tags, {
        mechanism: 'angular.ErrorHandler',
      });
    });

    test('a failure before the ErrorHandler exists is reported by the helper', async () => {
      const failure = new TypeError('environment initializer failed');
      await assert.rejects(
        bootstrapWithReporting(() => {
          throw failure;
        }),
        (error) => error === failure,
      );
      await flush();

      assert.equal(recorder.requests.length, 1);
      const { error, context } = recorder.requests[0].body;
      assert.deepEqual(
        [error.type, error.severity, error.action],
        ['TypeError', 'critical', 'bootstrap'],
      );
      assert.equal(context?.tags, undefined);
    });

    /**
     * A bootstrap that waits until the test finishes it, and is finished at
     * the latest when the test ends, so a failed assertion cannot leave a
     * start pending for the tests after it.
     *
     * @param {import('node:test').TestContext} context
     */
    function pendingBootstrap(context) {
      let resolveBootstrap = () => {};
      const bootstrapped = bootstrapWithReporting(
        () => new Promise((resolve) => (resolveBootstrap = resolve)),
      );
      const finish = async () => {
        resolveBootstrap();
        await bootstrapped;
      };
      context.after(finish);
      return { finish };
    }

    test('an offline network failure that stops the bootstrap is not reported', async (context) => {
      const switchableNavigator = useSwitchableNavigator(context);
      const handler = new ReportingErrorHandler();
      const request = { method: 'GET', url: '/api/config' };
      const withInterceptor = httpErrorResponse(0, '/api/config');
      const withoutInterceptor = httpErrorResponse(0, '/api/config');
      const beforeErrorHandler = httpErrorResponse(0, '/api/config');
      switchableNavigator.onLine = false;

      reportHttpErrorResponse(withInterceptor, request);
      await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, withInterceptor)));
      await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, withoutInterceptor)));
      await assert.rejects(
        bootstrapWithReporting(() => {
          throw beforeErrorHandler;
        }),
      );
      switchableNavigator.onLine = true;
      await flush();

      assert.deepEqual(reportedEvents(recorder), []);
    });

    test('a 5xx or an online network failure that stops the bootstrap keeps its HTTP event', async () => {
      const handler = new ReportingErrorHandler();
      const request = { method: 'GET', url: '/api/config' };
      for (const status of [503, 0]) {
        const response = httpErrorResponse(status, '/api/config');
        reportHttpErrorResponse(response, request);
        await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, response)));
      }
      await flush();

      assert.deepEqual(reportedEvents(recorder), [
        ['HttpError', 'HTTP_503', 'error', 'GET /api/config'],
        ['NetworkError', 'NETWORK_ERROR', 'warning', 'GET /api/config'],
      ]);
    });

    test('an ApiError the app passed to reportHttpError follows its status', async () => {
      const handler = new ReportingErrorHandler();
      const unauthorized = Object.assign(new Error('Unauthorized'), { name: 'ApiError' });
      const unavailable = Object.assign(new Error('Service Unavailable'), { name: 'ApiError' });
      reportHttpError({ method: 'GET', urlTemplate: '/api/me', status: 401, error: unauthorized });
      reportHttpError({ method: 'GET', urlTemplate: '/api/me', status: 503, error: unavailable });
      await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, unauthorized)));
      await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, unavailable)));
      await flush();

      assert.deepEqual(reportedEvents(recorder), [
        ['HttpError', 'HTTP_503', 'error', 'GET /api/me'],
        ['ApiError', undefined, 'critical', 'bootstrap'],
      ]);
      assert.deepEqual(recorder.requests[1].body.context.tags, {
        mechanism: 'angular.ErrorHandler',
      });
    });

    test('other errors met while bootstrapping keep their severity', async (context) => {
      const handler = new ReportingErrorHandler();
      const failure = new Error('APP_INITIALIZER failed');
      await assert.rejects(
        bootstrapWithReporting(async () => {
          await Promise.resolve();
          handler.handleError(new Error('ResizeObserver loop limit exceeded'));
          handler.handleError(failure);
          throw failure;
        }),
      );
      const succeeding = pendingBootstrap(context);
      handler.handleError(new Error('third-party script error'));
      await flush();
      assert.equal(recorder.requests.length, 2, 'held until the bootstrap settles');

      await succeeding.finish();
      await flush();
      assert.deepEqual(
        recorder.requests.map(({ body }) => [body.error.message, body.error.severity]),
        [
          ['APP_INITIALIZER failed', 'critical'],
          ['ResizeObserver loop limit exceeded', 'error'],
          ['third-party script error', 'error'],
        ],
      );
      assert.equal(recorder.requests[2].body.error.action, undefined);
    });

    test('a bootstrap that does not settle holds an error for the hold limit at most', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const handler = new ReportingErrorHandler();
      pendingBootstrap(context);
      handler.handleError(new Error('while the start hangs'));

      context.mock.timers.tick(HOLD_LIMIT_MILLISECONDS - 1);
      await flush();
      assert.equal(recorder.requests.length, 0);
      context.mock.timers.tick(1);
      await flush();
      assert.deepEqual(
        recorder.requests.map(({ body }) => [body.error.message, body.error.severity]),
        [['while the start hangs', 'error']],
      );
    });

    test('a 4xx that stops the bootstrap is reported as critical', async () => {
      const handler = new ReportingErrorHandler();
      const response = httpErrorResponse(404, 'https://api.example/api/config');
      await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, response)));
      await flush();

      assert.equal(recorder.requests.length, 1);
      assert.equal(recorder.requests[0].body.error.type, 'HttpErrorResponse');
      assert.equal(recorder.requests[0].body.error.severity, 'critical');
    });

    test('an error a beforeHandle hook handled is not reported by the helper', async () => {
      const handler = new ReportingErrorHandler({ beforeHandle: () => 'handled' });
      const chunkLoadError = Object.assign(new Error('Loading chunk 1 failed'), {
        name: 'ChunkLoadError',
      });
      await assert.rejects(bootstrapWithReporting(failingBootstrap(handler, chunkLoadError)));
      await flush();
      assert.equal(recorder.requests.length, 0);
    });

    test('resolves with the result of the bootstrap', async () => {
      const applicationReference = { destroy() {} };
      assert.equal(
        await bootstrapWithReporting(async () => applicationReference),
        applicationReference,
      );
      new ReportingErrorHandler().handleError(new Error('while running'));
      await flush();
      assert.equal(recorder.requests[0].body.error.severity, 'error');
    });
  });

  test('reportHttpErrorResponse ignores anything that is not an HttpErrorResponse', () => {
    assert.equal(reportHttpErrorResponse(new Error('plain')), false);
    assert.equal(reportHttpErrorResponse(null), false);
    assert.equal(isHttpErrorResponse({ name: 'HttpErrorResponse' }), false);
  });
});
