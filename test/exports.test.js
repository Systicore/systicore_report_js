import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { describe, test } from 'node:test';

/**
 * The hand-written declarations and the modules must export the same
 * runtime names, or an app compiles against a function that is not there.
 */
const ENTRY_POINTS = [
  ['index.d.ts', '../src/index.js'],
  ['angular.d.ts', '../src/angular.js'],
  ['vue.d.ts', '../src/vue.js'],
];

/** @param {string} declarationFile */
async function declaredRuntimeNames(declarationFile) {
  const source = await readFile(new URL(`../${declarationFile}`, import.meta.url), 'utf8');
  const names = [...source.matchAll(/^export declare (?:function|class|const) (\w+)/gm)].map(
    (match) => match[1],
  );
  return [...new Set(names)].sort();
}

describe('declarations match the modules', () => {
  for (const [declarationFile, modulePath] of ENTRY_POINTS) {
    test(declarationFile, async () => {
      const moduleExports = Object.keys(await import(modulePath)).sort();
      assert.deepEqual(await declaredRuntimeNames(declarationFile), moduleExports);
    });
  }
});

/**
 * Module-level mutable state: a top-level `let`, or a top-level collection
 * created empty (constant lookup tables such as `new Set([...])` are fine).
 */
const MODULE_STATE_PATTERN =
  /^(?:let |const \w+ = new (?:WeakMap|WeakSet|Map|Set|PendingCalls)\(\);)/m;

describe('package.json sideEffects', () => {
  test('lists exactly the modules that keep module-level state', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const sourceDirectory = new URL('../src/', import.meta.url);
    const moduleFileNames = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.js'));
    const statefulModules = [];
    for (const fileName of moduleFileNames) {
      const source = await readFile(new URL(fileName, sourceDirectory), 'utf8');
      if (MODULE_STATE_PATTERN.test(source)) {
        statefulModules.push(`./src/${fileName}`);
      }
    }

    assert.ok(Array.isArray(packageJson.sideEffects), 'sideEffects must not be false');
    assert.deepEqual([...packageJson.sideEffects].sort(), statefulModules.sort());
  });
});
