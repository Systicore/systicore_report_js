import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveConfiguration } from '../src/configuration.js';
import { createReporter } from '../src/reporter.js';
import { VALID_OPTIONS, createTestRuntime, settle } from './support/fake-runtime.js';

/** The 32 base62 characters after a key's type and environment. */
const RANDOM_PART = '0123456789abcdefghijklmnopqrstuv';

/**
 * Keys are assembled from their parts, so the retired sk_ spelling never
 * appears as a literal that secret scanners (gitleaks) flag as a Stripe key.
 *
 * @param {string} type e.g. "scpk"
 * @param {string} environment e.g. "live"
 * @param {string} [randomPart]
 * @returns {string}
 */
function ingestKey(type, environment, randomPart = RANDOM_PART) {
  return `${type}_${environment}_${randomPart}`;
}

describe('disabled reporting is a no-op', () => {
  const disabledCases = [
    ['enabled is false', { enabled: false }],
    ['enabled is missing', { enabled: undefined }],
    ['enabled is the string "false"', { enabled: 'false' }],
    ['the URL is empty', { url: '' }],
    ['the key is empty', { key: '   ' }],
    ['the URL is not http(s)', { url: 'ftp://reports.example' }],
    ['the key is a secret scsk_ key', { key: ingestKey('scsk', 'live') }],
    ['the key is a retired public pk_ key', { key: ingestKey('pk', 'live') }],
    ['the key is a retired secret sk_ key', { key: ingestKey('sk', 'live') }],
    ['the key has an unknown environment', { key: ingestKey('scpk', 'prod') }],
    ['the key is too short', { key: ingestKey('scpk', 'live', RANDOM_PART.slice(1)) }],
    ['the key is not base62', { key: ingestKey('scpk', 'live', `${RANDOM_PART.slice(1)}-`) }],
  ];

  for (const [description, override] of disabledCases) {
    test(`when ${description}`, async () => {
      const harness = createTestRuntime();
      const reporter = createReporter({ ...VALID_OPTIONS, ...override }, harness.runtime);

      assert.equal(reporter.enabled, false);
      assert.equal(reporter.captureException(new Error('boom')), false);
      assert.equal(reporter.captureMessage('boom'), false);
      assert.equal(
        reporter.reportHttpError({ method: 'GET', urlTemplate: '/x', status: 500 }),
        false,
      );
      reporter.setUser({ id: 1 });
      reporter.addBreadcrumb('crumb');
      harness.windowTarget.dispatchEvent(new Event('pagehide'));
      await reporter.flush();
      await harness.clock.advance(60_000);
      await settle();

      assert.equal(harness.requests.length, 0);
      assert.equal(harness.beacons.length, 0);
      assert.equal(harness.clock.pendingTimers, 0);
      reporter.dispose();
    });
  }

  test('without fetch', () => {
    const harness = createTestRuntime({ fetch: undefined });
    assert.equal(createReporter(VALID_OPTIONS, harness.runtime).enabled, false);
  });

  test('without an options object', () => {
    const harness = createTestRuntime();
    assert.equal(createReporter(undefined, harness.runtime).enabled, false);
  });
});

describe('resolveConfiguration', () => {
  test('accepts public scpk_ keys of both environments, trimmed', () => {
    for (const environment of ['live', 'test']) {
      const key = ingestKey('scpk', environment);
      const { configuration } = resolveConfiguration({ ...VALID_OPTIONS, key: ` ${key}\n` });
      assert.equal(configuration?.key, key);
    }
  });

  test('names the reason a key is refused', () => {
    const expectedReasons = [
      [ingestKey('scsk', 'live'), /secret scsk_ key/],
      [ingestKey('scsk', 'test'), /secret scsk_ key/],
      [ingestKey('pk', 'test'), /retired pk_\/sk_ format/],
      [ingestKey('sk', 'test'), /retired pk_\/sk_ format/],
      [ingestKey('scpk', 'live', 'short'), /32 base62 characters/],
    ];
    for (const [key, expectedReason] of expectedReasons) {
      const { configuration, disabledReason } = resolveConfiguration({ ...VALID_OPTIONS, key });
      assert.equal(configuration, undefined);
      assert.match(disabledReason ?? '', expectedReason);
    }
  });

  test('accepts the string spellings env files produce', () => {
    for (const enabled of ['true', 'TRUE', '1', 'yes', ' on ']) {
      assert.ok(resolveConfiguration({ ...VALID_OPTIONS, enabled }).configuration, enabled);
    }
  });

  test('normalizes the URL and applies defaults', () => {
    const { configuration } = resolveConfiguration({
      ...VALID_OPTIONS,
      url: 'https://reports.example///',
    });
    assert.equal(configuration?.url, 'https://reports.example');
    assert.equal(configuration?.maxQueue, 30);
    assert.equal(configuration?.rateLimitPerMinute, 20);
    assert.equal(configuration?.useIndexedDbQueue, false);
  });

  test('replaces invalid numbers with the defaults', () => {
    const { configuration } = resolveConfiguration({
      ...VALID_OPTIONS,
      maxQueue: -5,
      rateLimitPerMinute: 'many',
    });
    assert.equal(configuration?.maxQueue, 30);
    assert.equal(configuration?.rateLimitPerMinute, 20);
  });
});
