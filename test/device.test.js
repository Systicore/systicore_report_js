import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describeDevice, resolveInstallId } from '../src/device.js';
import { createRandomId } from '../src/runtime.js';
import { createMemoryStorage } from './support/fake-runtime.js';

describe('describeDevice', () => {
  const cases = [
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      { brand: 'Chrome', model: '128', osVersion: 'Windows 10.0' },
    ],
    [
      'Edge on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42',
      { brand: 'Edge', model: '128', osVersion: 'Windows 10.0' },
    ],
    [
      'Firefox on Linux',
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      { brand: 'Firefox', model: '131', osVersion: 'Linux' },
    ],
    [
      'Safari on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      { brand: 'Safari', model: '17', osVersion: 'macOS 10.15.7' },
    ],
    [
      'Safari on iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      { brand: 'Safari', model: '17', osVersion: 'iOS 17.5' },
    ],
    [
      'Samsung Internet on Android',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      { brand: 'Samsung Internet', model: '25', osVersion: 'Android 14' },
    ],
  ];

  for (const [description, userAgent, expected] of cases) {
    test(description, () => {
      assert.deepEqual(describeDevice(userAgent, '1.0.0', 'install'), {
        ...expected,
        appVersion: '1.0.0',
        installId: 'install',
      });
    });
  }

  test('an unknown agent leaves the browser fields empty', () => {
    assert.deepEqual(describeDevice(undefined, undefined, 'install'), {
      brand: undefined,
      model: undefined,
      osVersion: undefined,
      appVersion: undefined,
      installId: 'install',
    });
  });
});

describe('resolveInstallId', () => {
  test('creates the id once and keeps it in storage', () => {
    const storage = createMemoryStorage();
    let created = 0;
    const createId = () => `id-${++created}`;
    assert.equal(resolveInstallId(storage, createId), 'id-1');
    assert.equal(resolveInstallId(storage, createId), 'id-1');
    assert.equal(created, 1);
  });

  test('works without usable storage', () => {
    const throwingStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    };
    assert.equal(
      resolveInstallId(throwingStorage, () => 'page-id'),
      'page-id',
    );
    assert.equal(
      resolveInstallId(undefined, () => 'page-id'),
      'page-id',
    );
  });

  test('random ids are v4 UUIDs', () => {
    assert.match(
      createRandomId(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
