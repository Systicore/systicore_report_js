import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
