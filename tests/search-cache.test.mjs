// Unit tests for src/lib/searchCache.ts — the per-tab cache that lets the
// search box show a query it already ran without another round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/searchCache.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { SearchCache, searchKey } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('whitespace runs and ends are normalized, case is kept', () => {
  assert.equal(searchKey('  red   cross '), 'red cross');
  assert.equal(searchKey('red\tcross'), 'red cross');
  // Ranking splits camelCase, so these are different searches.
  assert.notEqual(searchKey('SitStayRead'), searchKey('sitstayread'));
});

test('returns what was stored for the same query', () => {
  const cache = new SearchCache();
  assert.equal(cache.get('red cross'), undefined);
  cache.set('red cross', ['a']);
  assert.deepEqual(cache.get(' red  cross'), ['a']);
  assert.equal(cache.get('Red Cross'), undefined);
});

test('an empty result is cached too', () => {
  const cache = new SearchCache();
  cache.set('zzz nothing', []);
  assert.deepEqual(cache.get('zzz nothing'), []);
});

test('entries expire after the TTL', () => {
  let now = 0;
  const cache = new SearchCache(50, 1000, () => now);
  cache.set('q', [1]);
  now = 1000;
  assert.deepEqual(cache.get('q'), [1]);
  now = 1001;
  assert.equal(cache.get('q'), undefined);
});

test('past the cap the least recently used entry goes first', () => {
  const cache = new SearchCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // a is now more recent than b
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('re-setting a query refreshes its value and age', () => {
  let now = 0;
  const cache = new SearchCache(50, 1000, () => now);
  cache.set('q', 1);
  now = 900;
  cache.set('q', 2);
  now = 1500;
  assert.equal(cache.get('q'), 2);
});
