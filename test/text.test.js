import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  stripUrlQueriesInText,
  stripUrlQuery,
  truncateBytes,
  truncateCharacters,
  utf8ByteLength,
} from '../src/text.js';

describe('truncateBytes', () => {
  test('keeps text that fits', () => {
    assert.equal(truncateBytes('hello', 5), 'hello');
  });

  test('cuts ASCII at the byte limit', () => {
    assert.equal(truncateBytes('abcdef'.repeat(100), 10), 'abcdefabcd');
  });

  test('never splits a multi-byte character', () => {
    // "ő" is 2 bytes, "€" is 3 bytes, "😀" is 4 bytes in UTF-8.
    const text = 'őőő€€😀'.repeat(50);
    for (let limit = 0; limit < 40; limit += 1) {
      const cut = truncateBytes(text, limit);
      assert.ok(utf8ByteLength(cut) <= limit, `limit ${limit}`);
      assert.ok(text.startsWith(cut), `limit ${limit} produced a replacement character`);
      assert.ok(!cut.includes('�'));
    }
  });
});

describe('truncateCharacters', () => {
  test('counts code points, not UTF-16 units', () => {
    assert.equal(truncateCharacters('😀😀😀', 2), '😀😀');
    assert.equal(truncateCharacters('abc', 5), 'abc');
  });
});

describe('stripUrlQuery', () => {
  test('drops query and fragment', () => {
    assert.equal(
      stripUrlQuery('https://app.example/vault/42?token=secret#details'),
      'https://app.example/vault/42',
    );
    assert.equal(stripUrlQuery('/api/items?page=2'), '/api/items');
    assert.equal(stripUrlQuery('/vault/:id'), '/vault/:id');
  });
});

describe('stripUrlQueriesInText', () => {
  test('removes queries from URLs inside a message', () => {
    assert.equal(
      stripUrlQueriesInText(
        'Http failure response for https://api.example/items?email=a@b.hu&token=x: 500 Internal',
      ),
      'Http failure response for https://api.example/items: 500 Internal',
    );
  });

  test('keeps line and column of stack frames', () => {
    const trace = [
      'TypeError: x is undefined',
      '    at render (https://app.example/main-ABC.js?v=3:10:5)',
      '    at https://app.example/chunk.js#hash:1:2',
      'loadItems@https://app.example/app.js?cache=1:44:12',
    ].join('\n');
    assert.equal(
      stripUrlQueriesInText(trace),
      [
        'TypeError: x is undefined',
        '    at render (https://app.example/main-ABC.js:10:5)',
        '    at https://app.example/chunk.js:1:2',
        'loadItems@https://app.example/app.js:44:12',
      ].join('\n'),
    );
  });

  test('leaves text without URL queries alone', () => {
    const text = 'Vault sync failed for item 8812 at https://app.example/vault';
    assert.equal(stripUrlQueriesInText(text), text);
  });

  test('removes queries from root-relative paths', () => {
    assert.equal(
      stripUrlQueriesInText('GET /api/items?email=john@x.com failed'),
      'GET /api/items failed',
    );
    assert.equal(
      stripUrlQueriesInText(
        'Http failure response for /api/items?page=2: 500 Internal Server Error',
      ),
      'Http failure response for /api/items: 500 Internal Server Error',
    );
    assert.equal(stripUrlQueriesInText('redirect=/login?next=/vault'), 'redirect=/login');
  });

  test('leaves text that only looks like a path alone', () => {
    for (const text of [
      'Expected /^a?b/ to match',
      'webpack:///./src/app.ts?abcd:10:5',
      'either/or? neither',
    ]) {
      assert.equal(stripUrlQueriesInText(text), text);
    }
  });

  test('takes linear time on long runs of URL-like text', () => {
    const text = 'http://x/'.repeat(20_000);
    const startedAt = performance.now();
    assert.equal(stripUrlQueriesInText(text), text);
    assert.ok(performance.now() - startedAt < 500, 'a backtracking scan takes seconds here');
  });
});
