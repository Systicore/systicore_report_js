import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  DEFAULT_NOISE_POLICY,
  classifyFailure,
  failureKindOf,
  hasExtensionFrame,
  isBotNavigator,
  resolveNoiseConfiguration,
} from '../src/noise.js';
import { createReporter } from '../src/reporter.js';
import { VALID_OPTIONS, createTestRuntime } from './support/fake-runtime.js';

const reporters = [];

/**
 * @param {object} [options] init() options over VALID_OPTIONS
 * @param {(harness: ReturnType<typeof createTestRuntime>) => void} [prepare] runs before the reporter is created
 */
function setUp(options = {}, prepare = () => {}) {
  const harness = createTestRuntime();
  prepare(harness);
  const reporter = createReporter({ ...VALID_OPTIONS, ...options }, harness.runtime);
  reporters.push(reporter);
  return { ...harness, reporter };
}

afterEach(() => {
  while (reporters.length > 0) {
    reporters.pop().dispose();
  }
});

function domException(name, message) {
  return Object.assign(new Error(message), { name });
}

const ONLINE = { online: true, leaving: false, bot: false };

describe('classifyFailure', () => {
  const cases = [
    ['a plain error', { error: new Error('x is undefined') }, ONLINE, 'defect'],
    [
      'a status-less call while offline',
      { httpNetworkFailure: true },
      { ...ONLINE, online: false },
      'offline',
    ],
    [
      'Failed to fetch while offline',
      { error: new TypeError('Failed to fetch') },
      { ...ONLINE, online: false },
      'offline',
    ],
    [
      'an AbortError',
      { error: domException('AbortError', 'The user aborted a request.') },
      ONLINE,
      'aborted',
    ],
    ['Safari cancelled', { error: new TypeError('cancelled') }, ONLINE, 'aborted'],
    [
      'a network failure while the page is leaving',
      { error: new TypeError('Load failed') },
      { ...ONLINE, leaving: true },
      'aborted',
    ],
    [
      'a TimeoutError',
      { error: domException('TimeoutError', 'signal timed out') },
      ONLINE,
      'timeout',
    ],
    [
      'ETIMEDOUT',
      { error: Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' }) },
      ONLINE,
      'timeout',
    ],
    [
      'a timeout while leaving',
      { error: domException('TimeoutError', 'signal timed out') },
      { ...ONLINE, leaving: true },
      'timeout',
    ],
    ['Chrome Failed to fetch', { error: new TypeError('Failed to fetch') }, ONLINE, 'network'],
    [
      'Chrome Failed to fetch with host',
      { error: new TypeError('Failed to fetch (api.example)') },
      ONLINE,
      'network',
    ],
    ['Safari Load failed', { error: new TypeError('Load failed') }, ONLINE, 'network'],
    [
      'Firefox NetworkError',
      { error: new TypeError('NetworkError when attempting to fetch resource.') },
      ONLINE,
      'network',
    ],
    ['a status-less call', { httpNetworkFailure: true }, ONLINE, 'network'],
    [
      'a failed dynamic import',
      {
        error: new TypeError(
          'Failed to fetch dynamically imported module: https://app.example/chunk.js',
        ),
      },
      ONLINE,
      'defect',
    ],
    [
      'an extension frame',
      {
        error: new Error('boom'),
        trace: 'Error: boom\n    at x (chrome-extension://abc/content.js:1:2)',
      },
      ONLINE,
      'extension',
    ],
    [
      'a Safari web extension frame',
      { trace: 'x@safari-web-extension://ABC/script.js:3:4' },
      ONLINE,
      'extension',
    ],
    ['a defect from a bot', { error: new Error('boom') }, { ...ONLINE, bot: true }, 'bot'],
    [
      'an extension frame from a bot',
      { trace: 'at moz-extension://abc/x.js:1:1' },
      { ...ONLINE, bot: true },
      'extension',
    ],
  ];
  for (const [description, input, signals, expected] of cases) {
    test(`${description} → ${expected}`, () => {
      assert.equal(classifyFailure(input, signals), expected);
    });
  }

  test("reads Angular's HttpErrorResponse.error ProgressEvent", () => {
    const response = (type) => ({
      name: 'HttpErrorResponse',
      status: 0,
      message: 'Http failure response for /api: 0 Unknown Error',
      error: { type },
    });
    assert.equal(failureKindOf(response('abort')), 'aborted');
    assert.equal(failureKindOf(response('timeout')), 'timeout');
    assert.equal(failureKindOf(response('error')), undefined);
  });

  test('reads one cause', () => {
    const wrapped = new Error('sync failed', { cause: domException('AbortError', 'aborted') });
    assert.equal(failureKindOf(wrapped), 'aborted');
  });
});

describe('noise signals', () => {
  test('bots by user agent and webdriver', () => {
    assert.equal(
      isBotNavigator({
        userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      }),
      true,
    );
    assert.equal(
      isBotNavigator({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36',
      }),
      true,
    );
    assert.equal(
      isBotNavigator({
        userAgent:
          'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      }),
      true,
    );
    assert.equal(
      isBotNavigator({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      }),
      false,
    );
    assert.equal(
      isBotNavigator({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36',
        webdriver: true,
      }),
      true,
    );
    assert.equal(isBotNavigator(undefined), false);
  });

  test('extension frames', () => {
    assert.equal(hasExtensionFrame('at https://app.example/main.js:1:1'), false);
    assert.equal(hasExtensionFrame('at chrome-extension://abc/inject.js:1:1'), true);
    assert.equal(hasExtensionFrame(undefined), false);
  });
});

describe('noise configuration', () => {
  test('defaults: on, offline and aborted dropped, the rest reported low', () => {
    const noise = resolveNoiseConfiguration(undefined);
    assert.equal(noise.enabled, true);
    assert.deepEqual(noise.policy, DEFAULT_NOISE_POLICY);
    assert.deepEqual(noise.policy, {
      offline: 'drop',
      aborted: 'drop',
      network: 'report_low',
      timeout: 'report_low',
      extension: 'report_low',
      bot: 'report_low',
    });
  });

  test('policy overrides; unknown actions and classes are ignored', () => {
    const noise = resolveNoiseConfiguration({
      policy: { network: 'drop', offline: 'report', bot: 'ignore', defect: 'drop' },
    });
    assert.equal(noise.policy.network, 'drop');
    assert.equal(noise.policy.offline, 'report');
    assert.equal(noise.policy.bot, 'report_low');
    assert.equal(/** @type {any} */ (noise.policy).defect, undefined);
  });

  test('false and { enabled: false } switch classification off', () => {
    assert.equal(resolveNoiseConfiguration(false).enabled, false);
    assert.equal(resolveNoiseConfiguration({ enabled: false }).enabled, false);
  });
});

describe('reporter with noise classification', () => {
  test('drops a network failure while offline, counts it and tells onSuppressed', async () => {
    const suppressed = [];
    const harness = setUp({ noise: { onSuppressed: (event) => suppressed.push(event) } });
    harness.goOffline();
    const error = new TypeError('Failed to fetch');
    assert.equal(
      harness.reporter.reportHttpError({ method: 'GET', url: '/api/v1/user', status: 0, error }),
      false,
    );
    assert.equal(
      harness.reporter.reportHttpError({ method: 'GET', url: '/assets/i18n/hu.json', status: 0 }),
      false,
    );
    harness.goOnline();
    await harness.reporter.flush();

    assert.equal(harness.requests.length, 0);
    assert.deepEqual(
      suppressed.map(({ classification, count, message, action }) => ({
        classification,
        count,
        message,
        action,
      })),
      [
        {
          classification: 'offline',
          count: 1,
          message: 'GET /api/v1/user failed: network error',
          action: 'GET /api/v1/user',
        },
        {
          classification: 'offline',
          count: 2,
          message: 'GET /assets/i18n/hu.json failed: network error',
          action: 'GET /assets/i18n/hu.json',
        },
      ],
    );
    assert.equal(suppressed[0].error, error);
  });

  test('drops an aborted request', async () => {
    const harness = setUp();
    harness.reporter.reportHttpError({
      method: 'GET',
      url: '/api/items',
      status: 0,
      error: domException('AbortError', 'The user aborted a request.'),
    });
    await harness.reporter.flush();
    assert.equal(harness.requests.length, 0);
  });

  test('drops status-0 failures after pagehide, until pageshow', async () => {
    const harness = setUp();
    harness.windowTarget.dispatchEvent(new Event('pagehide'));
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 0 });
    harness.windowTarget.dispatchEvent(new Event('pageshow'));
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/b', status: 0 });
    await harness.reporter.flush();

    assert.deepEqual(
      harness.requests.map((request) => [
        request.body.error.action,
        request.body.error.classification,
      ]),
      [['GET /api/b', 'network']],
    );
  });

  test('treats a beforeunload as leaving for 10 s only', async () => {
    const harness = setUp();
    harness.windowTarget.dispatchEvent(new Event('beforeunload'));
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 0 });
    await harness.clock.advance(10_000);
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/b', status: 0 });
    await harness.reporter.flush();

    assert.deepEqual(
      harness.requests.map((request) => request.body.error.action),
      ['GET /api/b'],
    );
  });

  test('drops status-0 failures while the document is hidden', async () => {
    const harness = setUp();
    harness.documentTarget.visibilityState = 'hidden';
    harness.documentTarget.dispatchEvent(new Event('visibilitychange'));
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 0 });
    harness.documentTarget.visibilityState = 'visible';
    harness.documentTarget.dispatchEvent(new Event('visibilitychange'));
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/b', status: 0 });
    await harness.reporter.flush();

    assert.deepEqual(
      harness.requests.map((request) => request.body.error.action),
      ['GET /api/b'],
    );
  });

  test('a page leaving never hides a 5xx', async () => {
    const harness = setUp();
    harness.windowTarget.dispatchEvent(new Event('pagehide'));
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 503 });
    harness.windowTarget.dispatchEvent(new Event('pageshow'));
    await harness.reporter.flush();

    assert.equal(harness.requests[0].body.error.classification, 'defect');
    assert.equal(harness.requests[0].body.error.severity, 'error');
  });

  test('reports a timeout low', async () => {
    const harness = setUp();
    harness.reporter.reportHttpError({
      method: 'GET',
      url: '/api/a',
      status: 0,
      error: domException('TimeoutError', 'signal timed out'),
    });
    await harness.reporter.flush();
    assert.equal(harness.requests[0].body.error.classification, 'timeout');
    assert.equal(harness.requests[0].body.error.severity, 'warning');
  });

  test('classifies an uncaught fetch failure and an extension error, lowering their severity', async () => {
    const harness = setUp();
    harness.reporter.captureUncaughtError(new TypeError('Load failed'));
    const extensionError = new Error('Cannot read properties of null');
    extensionError.stack =
      'TypeError: Cannot read properties of null\n    at inject (chrome-extension://abcdef/content.js:10:5)';
    harness.reporter.captureException(extensionError, { severity: 'critical' });
    await harness.reporter.flush();

    assert.deepEqual(
      harness.requests.map(({ body }) => [body.error.classification, body.error.severity]),
      [
        ['network', 'warning'],
        ['extension', 'warning'],
      ],
    );
  });

  test('reports everything from a bot low, also a 5xx and a message', async () => {
    const harness = setUp({}, (prepared) => {
      prepared.navigator.userAgent =
        'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
    });
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 500 });
    harness.reporter.captureMessage('hello');
    await harness.reporter.flush();

    assert.deepEqual(
      harness.requests.map(({ body }) => [body.error.classification, body.error.severity]),
      [
        ['bot', 'warning'],
        ['bot', 'warning'],
      ],
    );
  });

  test('policy "report" keeps the severity, "drop" drops, "report" for offline sends it', async () => {
    const harness = setUp({
      noise: { policy: { extension: 'report', network: 'drop', offline: 'report' } },
    });
    const extensionError = new Error('boom');
    extensionError.stack = 'Error: boom\n    at moz-extension://abc/x.js:1:1';
    harness.reporter.captureException(extensionError);
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 0 });
    harness.goOffline();
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/b', status: 0 });
    harness.goOnline();
    await harness.reporter.flush();

    assert.deepEqual(
      harness.requests.map(({ body }) => [
        body.error.action ?? body.error.message,
        body.error.classification,
        body.error.severity,
      ]),
      [
        ['boom', 'extension', 'error'],
        ['GET /api/b', 'offline', 'warning'],
      ],
    );
  });

  test('noise: false sends no classification and keeps the 0.2 behaviour', async () => {
    const harness = setUp({ noise: false });
    harness.reporter.reportHttpError({
      method: 'GET',
      url: '/api/a',
      status: 0,
      error: domException('AbortError', 'aborted'),
    });
    harness.goOffline();
    assert.equal(
      harness.reporter.reportHttpError({ method: 'GET', url: '/api/b', status: 0 }),
      false,
    );
    harness.goOnline();
    await harness.reporter.flush();

    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.requests[0].body.error, {
      type: 'NetworkError',
      code: 'NETWORK_ERROR',
      message: 'GET /api/a failed: network error',
      action: 'GET /api/a',
      severity: 'warning',
    });
  });

  test('beforeSend sees the classification; an unknown one is not sent', async () => {
    const seen = [];
    const harness = setUp({
      beforeSend: (event) => {
        seen.push(event.error.classification);
        return { ...event, error: { ...event.error, classification: 'whatever' } };
      },
    });
    harness.reporter.captureException(new Error('boom'));
    await harness.reporter.flush();

    assert.deepEqual(seen, ['defect']);
    assert.equal(harness.requests[0].body.error.classification, undefined);
  });

  test('a dropped HTTP failure is not reported again as an uncaught error', async () => {
    const harness = setUp();
    const error = domException('AbortError', 'aborted');
    harness.reporter.reportHttpError({ method: 'GET', url: '/api/a', status: 0, error });
    assert.equal(harness.reporter.captureUncaughtError(error), false);
    await harness.reporter.flush();
    assert.equal(harness.requests.length, 0);
  });
});
