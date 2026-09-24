import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';

import {
  ReportingErrorHandler,
  isHttpErrorResponse,
  reportHttpErrorResponse,
} from '../src/angular.js';
import { flush, init } from '../src/index.js';
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

  test('reportHttpErrorResponse ignores anything that is not an HttpErrorResponse', () => {
    assert.equal(reportHttpErrorResponse(new Error('plain')), false);
    assert.equal(reportHttpErrorResponse(null), false);
    assert.equal(isHttpErrorResponse({ name: 'HttpErrorResponse' }), false);
  });
});
