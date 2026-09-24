import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { toUrlTemplate } from '../src/http-failure.js';
import { createReporter } from '../src/reporter.js';
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

describe('reportHttpError', () => {
  test('reports a 5xx with the method and the route template', async () => {
    const { reporter, requests } = setUp();
    const reported = reporter.reportHttpError({
      method: 'get',
      urlTemplate: '/api/vault/:id?include=keys',
      status: 502,
      requestId: 'req-9',
      error: new Error('Http failure response'),
    });
    await reporter.flush();

    assert.equal(reported, true);
    const { error, context } = requests[0].body;
    assert.deepEqual(error, {
      type: 'HttpError',
      code: 'HTTP_502',
      message: 'GET /api/vault/:id failed with HTTP 502',
      action: 'GET /api/vault/:id',
      severity: 'error',
    });
    assert.equal(context.requestId, 'req-9');
    assert.deepEqual(context.tags, { mechanism: 'http', 'http.status': '502' });
  });

  test('reports a network failure as a warning', async () => {
    const { reporter, requests } = setUp();
    reporter.reportHttpError({
      method: 'POST',
      urlTemplate: '/api/items',
      status: 0,
      error: new TypeError('Failed to fetch'),
    });
    await reporter.flush();

    assert.deepEqual(requests[0].body.error, {
      type: 'NetworkError',
      code: 'NETWORK_ERROR',
      message: 'POST /api/items failed: network error',
      action: 'POST /api/items',
      severity: 'warning',
    });
    assert.equal(requests[0].body.context.tags['http.error'], 'TypeError');
  });

  test('does not report 4xx, but keeps every call as a breadcrumb', async () => {
    const { reporter, requests } = setUp();
    assert.equal(
      reporter.reportHttpError({ method: 'GET', urlTemplate: '/api/items/:id', status: 404 }),
      false,
    );
    assert.equal(
      reporter.reportHttpError({ method: 'POST', urlTemplate: '/api/login', status: 401 }),
      false,
    );
    reporter.captureMessage('later failure');
    await reporter.flush();

    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0].body.context.breadcrumbs.map((breadcrumb) => [
        breadcrumb.category,
        breadcrumb.message,
      ]),
      [
        ['http', 'GET /api/items/:id → 404'],
        ['http', 'POST /api/login → 401'],
      ],
    );
  });

  test('derives a template from a concrete URL', async () => {
    const { reporter, requests } = setUp();
    reporter.reportHttpError({
      method: 'DELETE',
      url: 'https://api.example/api/vault/8812/items/3f2b9c1e-8a7d-4c1e-9b2a-1c2d3e4f5a6b?force=true',
      status: 500,
    });
    await reporter.flush();
    assert.equal(requests[0].body.error.action, 'DELETE /api/vault/:id/items/:id');
  });

  test('skips network failures while the browser is offline', async () => {
    const harness = setUp();
    harness.goOffline();
    assert.equal(
      harness.reporter.reportHttpError({ method: 'GET', urlTemplate: '/api/items', status: 0 }),
      false,
    );
  });

  test('never reports failures of the reports backend itself', () => {
    const { reporter } = setUp();
    assert.equal(
      reporter.reportHttpError({
        method: 'POST',
        url: 'https://reports.example/api/v1/ingest?key=scpk_x',
        status: 503,
      }),
      false,
    );
  });

  test('an error object reported by an interceptor is not reported again', async () => {
    const { reporter, requests } = setUp();
    const failure = new Error('Http failure response');
    assert.equal(
      reporter.reportHttpError({
        method: 'GET',
        urlTemplate: '/api/a',
        status: 500,
        error: failure,
      }),
      true,
    );
    assert.equal(reporter.captureException(failure), false);
    await reporter.flush();
    assert.equal(requests.length, 1);
  });
});

describe('toUrlTemplate', () => {
  const cases = [
    ['https://api.example/api/users/42', '/api/users/:id'],
    ['/api/users/42/orders?page=2', '/api/users/:id/orders'],
    ['/api/users/deadbeefcafe0123/avatar', '/api/users/:id/avatar'],
    ['/api/share/V1StGXR8_Z5jdHi6B-myT', '/api/share/:id'],
    ['/api/people/jane%40example.com', '/api/people/:id'],
    ['/api/reports/stats', '/api/reports/stats'],
    ['https://api.example', '/'],
  ];
  for (const [url, expected] of cases) {
    test(`${url} → ${expected}`, () => {
      assert.equal(toUrlTemplate(url), expected);
    });
  }
});
