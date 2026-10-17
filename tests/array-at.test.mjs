// Unit tests for src/lib/arrayAt.ts — the Array.prototype.at polyfill that
// stops web-vitals' CLS tracker throwing "this.o.at is not a function" in
// engines without it (Trello XzwkYl7L).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/arrayAt.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const moduleUrl = (tag = '') =>
  `data:text/javascript;base64,${Buffer.from(`${outputText}\n// ${tag}`).toString('base64')}`;
const { installArrayAt } = await import(moduleUrl());

// Runs fn with Array.prototype.at removed, then puts the native one back.
async function withoutNativeAt(fn) {
  const native = Object.getOwnPropertyDescriptor(Array.prototype, 'at');
  delete Array.prototype.at;
  try {
    await fn();
  } finally {
    Object.defineProperty(Array.prototype, 'at', native);
  }
}

test('leaves a native Array.prototype.at alone', () => {
  const native = Array.prototype.at;
  installArrayAt();
  assert.equal(Array.prototype.at, native);
});

test('adds an at() that matches the native one', async () => {
  const native = Array.prototype.at;
  const arrays = [[], [1], [1, 2, 3], [, 'hole']];
  const indexes = [0, 1, 2, 3, -1, -2, -3, -4, 1.7, -1.7, NaN, '1', undefined, Infinity, -Infinity];
  await withoutNativeAt(() => {
    installArrayAt();
    assert.notEqual(Array.prototype.at, native);
    for (const a of arrays) {
      for (const i of indexes) assert.equal(a.at(i), native.call(a, i), `[${a}].at(${String(i)})`);
    }
    // ToNumber throws on a BigInt, natively too.
    assert.throws(() => [1, 2].at(1n), TypeError);
  });
});

test('importing the module patches .at (as monitoringSetup.ts does)', async () => {
  await withoutNativeAt(async () => {
    await import(moduleUrl('fresh copy, not the cached module'));
    assert.equal([1, 2].at(-1), 2);
  });
});

test("isn't enumerable, so for…in over an array doesn't see it", async () => {
  await withoutNativeAt(() => {
    installArrayAt();
    const keys = [];
    for (const k in [1, 2]) keys.push(k);
    assert.deepEqual(keys, ['0', '1']);
  });
});
