import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../src/lib/safeStorage.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: 'ESNext', target: 'ES2020' } }).outputText;
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const { safeSession } = mod;

test('does not throw when window.sessionStorage getter throws', () => {
  globalThis.window = {};
  Object.defineProperty(globalThis.window, 'sessionStorage', {
    configurable: true, get() { throw new DOMException('denied', 'SecurityError'); },
  });
  safeSession.setItem('a', '1');
  assert.equal(safeSession.getItem('a'), '1');
  safeSession.removeItem('a');
  assert.equal(safeSession.getItem('a'), null);
});

test('falls back to memory when setItem hits quota', () => {
  const data = new Map();
  globalThis.window = { sessionStorage: {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem() { throw new DOMException('full', 'QuotaExceededError'); },
    removeItem: k => data.delete(k),
  } };
  safeSession.setItem('q', 'v');
  assert.equal(safeSession.getItem('q'), 'v');
});
