import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { MAX_RECORD_AGE_MS } from '../src/event-queue.js';
import { IndexedDbStore, queueDatabaseName } from '../src/indexed-db-store.js';
import { createReporter } from '../src/reporter.js';
import { FakeIndexedDb } from './support/fake-indexed-db.js';
import { START_TIME, VALID_OPTIONS, createTestRuntime, settle } from './support/fake-runtime.js';

const DATABASE_NAME = 'systicore-report:tarp-crm_web';
const reporters = [];

function setUp(indexedDB, options = {}) {
  const harness = createTestRuntime({ indexedDB });
  const reporter = createReporter(
    { ...VALID_OPTIONS, useIndexedDbQueue: true, ...options },
    harness.runtime,
  );
  reporters.push(reporter);
  return { ...harness, reporter };
}

afterEach(() => {
  while (reporters.length > 0) {
    reporters.pop().dispose();
  }
});

describe('IndexedDB queue', () => {
  test('events captured offline survive a reload and are replayed on init', async () => {
    const indexedDB = new FakeIndexedDb();
    const firstPage = setUp(indexedDB);
    firstPage.goOffline();
    firstPage.reporter.captureMessage('captured in the field');
    await settle();
    firstPage.reporter.dispose();

    assert.equal(indexedDB.records(DATABASE_NAME).length, 1);
    assert.equal(firstPage.requests.length, 0);

    const secondPage = setUp(indexedDB);
    await secondPage.reporter.flush();
    assert.equal(secondPage.requests.length, 1);
    assert.equal(secondPage.requests[0].body.error.message, 'captured in the field');
    await settle();
    assert.equal(indexedDB.records(DATABASE_NAME).length, 0, 'delivered events leave the store');
  });

  test('replays on the online event', async () => {
    const indexedDB = new FakeIndexedDb();
    const page = setUp(indexedDB);
    page.goOffline();
    page.reporter.captureMessage('one');
    page.reporter.captureMessage('two');
    await page.reporter.flush();
    assert.equal(page.requests.length, 0);

    page.goOnline();
    await settle();
    assert.deepEqual(
      page.requests.map((request) => request.body.error.message),
      ['one', 'two'],
    );
  });

  test('is not used unless useIndexedDbQueue is set', async () => {
    const indexedDB = new FakeIndexedDb();
    const page = setUp(indexedDB, { useIndexedDbQueue: false });
    page.goOffline();
    page.reporter.captureMessage('memory only');
    await settle();
    assert.equal(indexedDB.databases.size, 0);
  });

  test('falls back to memory when IndexedDB is missing', async () => {
    const page = setUp(undefined);
    page.goOffline();
    assert.equal(page.reporter.captureMessage('boom'), true);
    page.goOnline();
    await settle();
    assert.equal(page.requests.length, 1);
  });
});

describe('IndexedDbStore', () => {
  test('saves, loads and removes records', async () => {
    const store = new IndexedDbStore(new FakeIndexedDb(), queueDatabaseName('tarp-planner_web'));
    store.save({ id: 'a', body: '{}', createdAt: 1, attempts: 0 });
    store.save({ id: 'b', body: '{}', createdAt: 2, attempts: 0 });
    store.remove('a');
    await settle();
    assert.deepEqual(await store.loadAll(), [{ id: 'b', body: '{}', createdAt: 2, attempts: 0 }]);
  });

  test('restore drops expired records', async () => {
    const indexedDB = new FakeIndexedDb();
    const store = new IndexedDbStore(indexedDB, DATABASE_NAME);
    store.save({
      id: 'old',
      body: '{"error":{"message":"old"}}',
      createdAt: START_TIME - MAX_RECORD_AGE_MS - 1,
      attempts: 0,
    });
    store.save({
      id: 'fresh',
      body: '{"error":{"message":"fresh"}}',
      createdAt: START_TIME - 1000,
      attempts: 2,
    });
    await settle();

    const page = setUp(indexedDB);
    await page.reporter.flush();
    assert.deepEqual(
      page.requests.map((request) => request.body.error.message),
      ['fresh'],
    );
    await settle();
    assert.equal(indexedDB.records(DATABASE_NAME).length, 0);
  });

  test('a failing open degrades to an empty store', async () => {
    const brokenFactory = {
      open() {
        throw new Error('SecurityError');
      },
    };
    const store = new IndexedDbStore(/** @type {any} */ (brokenFactory), DATABASE_NAME);
    store.save({ id: 'a', body: '{}', createdAt: 1, attempts: 0 });
    assert.deepEqual(await store.loadAll(), []);
  });

  test('the database name is namespaced by source', () => {
    assert.equal(queueDatabaseName('tarp-planner_web'), 'systicore-report:tarp-planner_web');
    assert.equal(queueDatabaseName(undefined), 'systicore-report');
  });
});
