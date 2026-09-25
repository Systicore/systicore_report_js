import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { FIELD_BYTE_LIMITS, MAX_BODY_BYTES } from '../src/limits.js';
import { createReporter } from '../src/reporter.js';
import { utf8ByteLength } from '../src/text.js';
import { VALID_OPTIONS, createTestRuntime } from './support/fake-runtime.js';

/** @type {Array<{ dispose(): void }>} */
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

class StateError extends Error {
  name = 'StateError';
}

describe('ingest payload (contract §3)', () => {
  test('captureException sends exactly the contract shape', async () => {
    const { reporter, requests } = setUp();
    reporter.setUser({ id: 42, issuer: 'https://auth.example' });
    reporter.addBreadcrumb({
      category: 'nav',
      message: 'opened https://app.example/vault/42?tab=keys',
    });
    const error = new StateError('Vault sync failed for item 8812');
    error.stack =
      'StateError: Vault sync failed for item 8812\n    at syncVault (https://app.example/main.js?v=3:10:5)';

    const queued = reporter.captureException(error, {
      code: 'VAULT_SYNC_FAILED',
      action: 'GET /api/vault/:id',
      severity: 'critical',
      fingerprint: 'vault.sync:v1',
      route: '/vault/:id',
      requestId: 'req-1',
      tags: { feature: 'vault' },
    });
    await reporter.flush();

    assert.equal(queued, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, {
      error: {
        type: 'StateError',
        code: 'VAULT_SYNC_FAILED',
        message: 'Vault sync failed for item 8812',
        trace:
          'StateError: Vault sync failed for item 8812\n    at syncVault (https://app.example/main.js:10:5)',
        action: 'GET /api/vault/:id',
        severity: 'critical',
        fingerprint: 'vault.sync:v1',
      },
      release: { version: '1.4.2+17', commit: 'abc1234', buildTime: '2026-09-24T09:00:00Z' },
      environment: 'production',
      platform: 'web',
      device: {
        brand: 'Chrome',
        model: '128',
        osVersion: 'Windows 10.0',
        appVersion: '1.4.2+17',
        installId: 'id-1',
      },
      user: { id: '42', issuer: 'https://auth.example' },
      context: {
        route: '/vault/:id',
        url: 'https://app.example/vault/42',
        requestId: 'req-1',
        tags: { feature: 'vault' },
        breadcrumbs: [
          {
            ts: '2026-09-24T10:00:00.000Z',
            category: 'nav',
            message: 'opened https://app.example/vault/42',
          },
        ],
      },
    });
  });

  test('captureMessage sends a message-only error with the default severity', async () => {
    const { reporter, requests } = setUp({ release: undefined, environment: undefined });
    reporter.captureMessage('Cache rebuilt from scratch', {
      code: 'CACHE_REBUILT',
      action: 'startup',
    });
    await reporter.flush();

    assert.deepEqual(requests[0].body.error, {
      code: 'CACHE_REBUILT',
      message: 'Cache rebuilt from scratch',
      action: 'startup',
      severity: 'error',
    });
    assert.equal(requests[0].body.release, undefined);
    assert.equal(requests[0].body.environment, undefined);
    assert.equal(requests[0].body.user, undefined);
  });

  test('is posted as a simple CORS request without cookies or key headers', async () => {
    const { reporter, requests } = setUp({ url: 'https://reports.example/' });
    reporter.captureMessage('boom');
    await reporter.flush();

    const { url, init } = requests[0];
    assert.equal(
      url,
      'https://reports.example/api/v1/ingest?key=scpk_test_0123456789abcdefghijklmnopqrstuv',
    );
    assert.equal(init.method, 'POST');
    assert.equal(init.keepalive, true);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.mode, 'cors');
    assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=UTF-8' });
    assert.equal(typeof init.body, 'string');
  });

  test('strips query strings and fragments from the page URL, route and action', async () => {
    const { reporter, requests } = setUp(
      {},
      { location: { href: 'https://app.example/a/b?session=xyz#frag' } },
    );
    reporter.captureMessage('boom', { action: 'GET /api/items?page=2', route: '/items#top' });
    await reporter.flush();

    const body = requests[0].body;
    assert.equal(body.context.url, 'https://app.example/a/b');
    assert.equal(body.context.route, '/items');
    assert.equal(body.error.action, 'GET /api/items');
  });

  test('truncates fields to the contract caps on character boundaries', async () => {
    const { reporter, requests } = setUp();
    reporter.captureException(
      Object.assign(new Error('ő'.repeat(10_000)), {
        name: 'T'.repeat(300),
        stack: '€'.repeat(20_000),
      }),
      { code: 'C'.repeat(150), action: 'a'.repeat(300), requestId: 'r'.repeat(150) },
    );
    await reporter.flush();

    const { error, context } = requests[0].body;
    assert.equal(utf8ByteLength(error.type), FIELD_BYTE_LIMITS.type);
    assert.equal(utf8ByteLength(error.code), FIELD_BYTE_LIMITS.code);
    assert.equal(utf8ByteLength(error.message), FIELD_BYTE_LIMITS.message);
    assert.ok(utf8ByteLength(error.trace) <= FIELD_BYTE_LIMITS.trace);
    assert.ok(/^€+$/.test(error.trace));
    assert.equal(utf8ByteLength(error.action), FIELD_BYTE_LIMITS.action);
    assert.equal(utf8ByteLength(context.requestId), FIELD_BYTE_LIMITS.requestId);
  });

  test('limits tags and breadcrumbs', async () => {
    const { reporter, requests } = setUp();
    for (let index = 0; index < 25; index += 1) {
      reporter.addBreadcrumb({
        category: index % 2 ? 'ui' : 'unknown',
        message: `step ${index} ${'x'.repeat(300)}`,
      });
    }
    const tags = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`tag${index}`, 'v'.repeat(200)]),
    );
    reporter.captureMessage('boom', {
      tags: { ['k'.repeat(40)]: 'value', skipped: null, ...tags },
    });
    await reporter.flush();

    const { context } = requests[0].body;
    assert.equal(Object.keys(context.tags).length, 10);
    assert.ok(Object.keys(context.tags).every((key) => key.length <= 32));
    assert.ok(Object.values(context.tags).every((value) => value.length <= 128));
    assert.equal(context.tags.skipped, undefined);
    assert.equal(context.breadcrumbs.length, 20);
    assert.ok(context.breadcrumbs[0].message.startsWith('step 5 '));
    assert.ok(context.breadcrumbs.every((breadcrumb) => breadcrumb.message.length <= 200));
    assert.equal(context.breadcrumbs[0].category, 'ui');
    assert.equal(context.breadcrumbs[1].category, 'log');
  });

  test('keeps tag keys named like Object.prototype members', async () => {
    const { reporter, requests } = setUp();
    const tags = {
      constructor: 'a',
      toString: 'b',
      valueOf: 'c',
      hasOwnProperty: 'd',
      ['__proto__']: 'e',
    };
    reporter.captureMessage('boom', { tags });
    await reporter.flush();

    const sent = requests[0].body.context.tags;
    assert.deepEqual(Object.keys(sent), Object.keys(tags));
    assert.deepEqual(Object.values(sent), ['a', 'b', 'c', 'd', 'e']);
  });

  test('removes relative URL queries from messages, tags and breadcrumbs', async () => {
    const { reporter, requests } = setUp();
    reporter.addBreadcrumb({ category: 'http', message: 'GET /api/items?email=john@x.com' });
    reporter.captureMessage('Loading /api/items?email=john@x.com failed', {
      tags: { source: '/api/items?email=john@x.com' },
    });
    await reporter.flush();

    const { error, context } = requests[0].body;
    assert.equal(error.message, 'Loading /api/items failed');
    assert.equal(context.tags.source, '/api/items');
    assert.equal(context.breadcrumbs[0].message, 'GET /api/items');
  });

  test('a huge message is capped without stalling the capture', async () => {
    const { reporter, requests } = setUp();
    reporter.captureMessage(`${'https://x/a,'.repeat(200_000)}end`);
    await reporter.flush();

    const { message } = requests[0].body.error;
    assert.equal(utf8ByteLength(message), FIELD_BYTE_LIMITS.message);
    assert.ok(message.startsWith('https://x/a,'));
  });

  test('keeps the whole body under the size limit', async () => {
    const { reporter, requests } = setUp();
    for (let index = 0; index < 20; index += 1) {
      reporter.addBreadcrumb(`${index}${'😀'.repeat(199)}`);
    }
    reporter.captureException(
      Object.assign(new Error('😀'.repeat(3000)), { stack: '\u0001'.repeat(40_000) }),
      {
        tags: Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [`t${index}`, '😀'.repeat(128)]),
        ),
      },
    );
    await reporter.flush();

    assert.equal(requests.length, 1);
    assert.ok(utf8ByteLength(requests[0].init.body) <= MAX_BODY_BYTES);
    assert.equal(requests[0].body.context.breadcrumbs, undefined);
    assert.ok(requests[0].body.error.message.length > 0);
  });

  test('unknown severities become "error" and invalid fingerprints are dropped', async () => {
    const { reporter, requests } = setUp();
    reporter.captureMessage('boom', { severity: 'fatal', fingerprint: 'has spaces' });
    await reporter.flush();

    assert.equal(requests[0].body.error.severity, 'error');
    assert.equal(requests[0].body.error.fingerprint, undefined);
  });

  test('describes thrown non-Error values', async () => {
    const { reporter, requests } = setUp();
    reporter.captureException('plain string');
    reporter.captureException({ reason: 'object' });
    reporter.captureException(undefined);
    await reporter.flush();

    assert.deepEqual(
      requests.map((request) => [request.body.error.type, request.body.error.message]),
      [
        ['Error', 'plain string'],
        ['NonError', '{"reason":"object"}'],
        ['NonError', 'undefined'],
      ],
    );
  });

  test('appends the cause chain to the trace', async () => {
    const { reporter, requests } = setUp();
    const cause = new TypeError('socket closed');
    cause.stack = 'TypeError: socket closed\n    at read (https://app.example/net.js:1:1)';
    const error = new Error('save failed', { cause });
    error.stack = 'Error: save failed\n    at save (https://app.example/app.js:2:2)';
    reporter.captureException(error);
    await reporter.flush();

    assert.equal(
      requests[0].body.error.trace,
      'Error: save failed\n    at save (https://app.example/app.js:2:2)\n' +
        'Caused by: TypeError: socket closed\n    at read (https://app.example/net.js:1:1)',
    );
  });
});

describe('user attribution', () => {
  test('userProvider wins over setUser and is read at capture time', async () => {
    let currentUser = { id: 'u-1' };
    const { reporter, requests } = setUp({ userProvider: () => currentUser });
    reporter.setUser({ id: 'explicit' });
    reporter.captureMessage('first');
    currentUser = null;
    reporter.captureMessage('second');
    await reporter.flush();

    assert.deepEqual(requests[0].body.user, { id: 'u-1' });
    assert.deepEqual(requests[1].body.user, { id: 'explicit' });
  });

  test('a throwing userProvider does not stop the report', async () => {
    const { reporter, requests } = setUp({
      userProvider: () => {
        throw new Error('store not ready');
      },
    });
    assert.equal(reporter.captureMessage('boom'), true);
    await reporter.flush();
    assert.equal(requests[0].body.user, undefined);
  });

  test('routeProvider fills the route when the capture has none', async () => {
    const { reporter, requests } = setUp({ routeProvider: () => '/vault/:id' });
    reporter.captureMessage('boom');
    reporter.captureMessage('other', { route: '/explicit' });
    await reporter.flush();
    assert.equal(requests[0].body.context.route, '/vault/:id');
    assert.equal(requests[1].body.context.route, '/explicit');
  });
});

describe('global tags', () => {
  test('are added to every event; a capture wins a key clash', async () => {
    const globalTags = { image: 'tarp-planner_web:1.4.2', feature: 'global', empty: null };
    const { reporter, requests } = setUp({ tags: globalTags });
    reporter.captureMessage('first');
    globalTags.image = 'changed after init';
    reporter.captureMessage('second', { tags: { feature: 'vault', attempt: 2 } });
    await reporter.flush();

    assert.deepEqual(requests[0].body.context.tags, {
      image: 'tarp-planner_web:1.4.2',
      feature: 'global',
    });
    assert.deepEqual(requests[1].body.context.tags, {
      feature: 'vault',
      attempt: '2',
      image: 'tarp-planner_web:1.4.2',
    });
  });

  test("the capture's own tags are kept first under the 10-tag limit", async () => {
    const globalTags = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`global${index}`, 'g']),
    );
    const { reporter, requests } = setUp({ tags: globalTags });
    reporter.captureMessage('boom', { tags: { mechanism: 'window.error' } });
    await reporter.flush();

    const sentKeys = Object.keys(requests[0].body.context.tags);
    assert.equal(sentKeys.length, 10);
    assert.equal(sentKeys[0], 'mechanism');
    assert.ok(!sentKeys.includes('global9'));
  });

  test('ignore anything that is not a plain object', async () => {
    const { reporter, requests } = setUp({ tags: ['not', 'tags'] });
    reporter.captureMessage('boom');
    await reporter.flush();
    assert.equal(requests[0].body.context.tags, undefined);
  });
});

describe('breadcrumbsProvider', () => {
  test('is read at capture time and merged with the trail by time', async () => {
    /** @type {Array<unknown>} */
    const sessionSteps = [];
    const harness = setUp({ breadcrumbsProvider: () => sessionSteps });
    const { reporter, requests, clock } = harness;
    sessionSteps.push({ category: 'ui', message: 'opened planner', ts: clock.now });
    await clock.advance(1_000);
    reporter.addBreadcrumb({ category: 'nav', message: '/plans' });
    await clock.advance(1_000);
    sessionSteps.push({ message: 'saved plan', ts: new Date(clock.now).toISOString() });
    sessionSteps.push('picked a date');
    reporter.captureMessage('boom');
    await reporter.flush();

    assert.deepEqual(requests[0].body.context.breadcrumbs, [
      { ts: '2026-09-24T10:00:00.000Z', category: 'ui', message: 'opened planner' },
      { ts: '2026-09-24T10:00:01.000Z', category: 'nav', message: '/plans' },
      { ts: '2026-09-24T10:00:02.000Z', category: 'log', message: 'saved plan' },
      { ts: '2026-09-24T10:00:02.000Z', category: 'log', message: 'picked a date' },
    ]);
  });

  test('only the newest 20 of trail and provided steps are sent', async () => {
    const providedSteps = Array.from({ length: 500 }, (_, index) => ({
      message: `step ${index}`,
      ts: index,
    }));
    const { reporter, requests } = setUp({ breadcrumbsProvider: () => providedSteps });
    reporter.addBreadcrumb('newest');
    reporter.captureMessage('boom');
    await reporter.flush();

    const messages = requests[0].body.context.breadcrumbs.map((breadcrumb) => breadcrumb.message);
    assert.equal(messages.length, 20);
    assert.equal(messages[0], 'step 481');
    assert.equal(messages.at(-1), 'newest');
  });

  test('entries without a message or a valid time are skipped or get the capture time', async () => {
    const { reporter, requests } = setUp({
      breadcrumbsProvider: () => [null, { category: 'ui' }, { message: 'no time', ts: 'soon' }],
    });
    reporter.captureMessage('boom');
    await reporter.flush();
    assert.deepEqual(requests[0].body.context.breadcrumbs, [
      { ts: '2026-09-24T10:00:00.000Z', category: 'log', message: 'no time' },
    ]);
  });

  test('a throwing provider or unreadable entries do not stop the report', async () => {
    const hostileEntry = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    for (const breadcrumbsProvider of [
      () => {
        throw new Error('logger not ready');
      },
      () => [hostileEntry],
    ]) {
      const { reporter, requests } = setUp({ breadcrumbsProvider });
      reporter.addBreadcrumb('kept');
      assert.equal(reporter.captureMessage('boom'), true);
      await reporter.flush();
      assert.deepEqual(
        requests[0].body.context.breadcrumbs.map((breadcrumb) => breadcrumb.message),
        ['kept'],
      );
    }
  });
});

describe('beforeSend', () => {
  test('can change the event, and its result is limited again', async () => {
    const { reporter, requests } = setUp({
      beforeSend: (event) => ({
        ...event,
        error: { ...event.error, message: `${event.error.message} ${'x'.repeat(10_000)}` },
      }),
    });
    reporter.captureMessage('boom');
    await reporter.flush();
    assert.equal(utf8ByteLength(requests[0].body.error.message), FIELD_BYTE_LIMITS.message);
  });

  test('can drop the event', async () => {
    const { reporter, requests } = setUp({ beforeSend: () => null });
    assert.equal(reporter.captureMessage('boom'), false);
    await reporter.flush();
    assert.equal(requests.length, 0);
  });

  test('a throwing hook drops the event instead of throwing', async () => {
    const { reporter, requests } = setUp({
      beforeSend: () => {
        throw new Error('hook bug');
      },
    });
    assert.equal(reporter.captureMessage('boom'), false);
    await reporter.flush();
    assert.equal(requests.length, 0);
  });
});
