// Unit tests for src/lib/monitoring.ts — what the browser sends to
// monitor-report (FM-2026-10-03-02). Pins down the privacy scrubbing and the
// noise filter, since a regression in either sends data we promised not to,
// or floods the bug board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpile monitoring.ts and its local import into a temp dir, pointing the
// bare 'web-vitals' import at the installed package.
const dir = mkdtempSync(join(tmpdir(), 'monitoring-test-'));
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(`../${path}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
const webVitals = pathToFileURL(new URL('../node_modules/web-vitals/dist/web-vitals.js', import.meta.url).pathname).href;
writeFileSync(join(dir, 'chunkReload.mjs'), transpile('src/lib/chunkReload'));
writeFileSync(join(dir, 'monitor_scrub.mjs'), transpile('supabase/functions/_shared/monitor_scrub'));
writeFileSync(join(dir, 'supabaseProject.mjs'), transpile('src/lib/supabaseProject'));
writeFileSync(
  join(dir, 'monitoring.mjs'),
  transpile('src/lib/monitoring')
    .replace(/from ['"]\.\/chunkReload['"]/, "from './chunkReload.mjs'")
    .replace(/from ['"]\.\/supabaseProject['"]/, "from './supabaseProject.mjs'")
    .replace(/from ['"][./]+supabase\/functions\/_shared\/monitor_scrub\.ts['"]/, "from './monitor_scrub.mjs'")
    .replace(/from ['"]web-vitals['"]/, `from '${webVitals}'`),
);
const { isNoise, describe, buildCrashReport } = await import(pathToFileURL(join(dir, 'monitoring.mjs')).href);
const { scrub, normalizePath, ROUTES } = await import(pathToFileURL(join(dir, 'monitor_scrub.mjs')).href);

test('scrub masks email addresses and strips query strings and fragments', () => {
  assert.equal(
    scrub('Failed for jane.doe+test@example.org: GET https://x.supabase.co/rest/v1/t?email=eq.a@b.org&x=1 (see https://fundermatch.org/p#frag)'),
    'Failed for [email]: GET https://x.supabase.co/rest/v1/t (see https://fundermatch.org/p)',
  );
});

test('normalizePath never lets a share token through', () => {
  assert.equal(normalizePath('/shared/9f3a1c0e5b7d4a2f8e6c1b0a9d8e7f6a'), '/shared/:id');
  assert.equal(normalizePath('/shared/short'), '/shared/:id');
  assert.equal(normalizePath('/projects/new/chat'), '/projects/new/chat');
  assert.equal(normalizePath('/projects/abc/tracker'), '/projects/:id/tracker');
  assert.equal(normalizePath('/onboarding/first-project'), '/onboarding/first-project');
  assert.equal(normalizePath('/not-a-route/abc'), '(other)');
  assert.equal(normalizePath('/Shared/ABCDEF'), '/shared/:id');
});

test("the route list matches App.tsx's routes", async () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const routes = [...app.matchAll(/path="([^"*]+)"/g)].map((m) => m[1].replace(/:\w+/g, ':id'));
  assert.deepEqual([...new Set(routes)].sort(), [...ROUTES].sort());
});

test('scrub handles relative URLs and percent-encoded addresses', () => {
  assert.equal(scrub('GET /rest/v1/x?select=*&email=eq.a failed'), 'GET /rest/v1/x failed');
  assert.equal(scrub('no user a%40b.org'), 'no user [email]');
  assert.equal(scrub('Why? Because.'), 'Why? Because.');
});

test('scrub masks share-link tokens anywhere in the text', () => {
  assert.equal(
    scrub('GET https://fundermatch.org/shared/9f3a1c0e5b7d failed; see /shared/abc123/view'),
    'GET https://fundermatch.org/shared/:id failed; see /shared/:id/view',
  );
});

test('scrub stays fast on long input with no address in it', () => {
  const start = performance.now();
  scrub('a'.repeat(5000) + '@' + 'b'.repeat(5000));
  scrub('@'.repeat(1) + 'x.'.repeat(5000));
  assert.ok(performance.now() - start < 200, `took ${performance.now() - start} ms`);
});

test('normalizePath turns ids into :id so one route is one key', () => {
  assert.equal(normalizePath('/recipient/2da01037-c1bc-4106-8c21-40008ead6ca7'), '/recipient/:id');
  assert.equal(normalizePath('/funder/010224898'), '/funder/:id');
  assert.equal(normalizePath('/funder/01-0224898/'), '/funder/:id');
  assert.equal(normalizePath('/search/'), '/search');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('/projects/2026'), '/projects/:id');
  assert.equal(normalizePath('/search?q=x'), '/search');
});

test('noise: extensions, opaque cross-origin errors, ResizeObserver', () => {
  assert.equal(isNoise(new Error('x'), 'x', 'at f (chrome-extension://abc/content.js:1:1)'), true);
  // Our crash with an extension's wrapper further down the stack is ours.
  const ours = 'TypeError: x\n    at submit (https://fundermatch.org/assets/a.js:1:1)\n    at w (chrome-extension://abc/inject.js:1:1)';
  assert.equal(isNoise(new TypeError('x'), 'x', ours), false);
  // A URL in V8's message line isn't a frame; Firefox-style frames count.
  assert.equal(isNoise(new Error('y'), 'y', 'Error: see chrome-extension://abc/x\n    at f (https://fundermatch.org/assets/a.js:1:1)'), false);
  assert.equal(isNoise(new Error('y'), 'y', 'f@moz-extension://abc/content.js:1:1'), true);
  assert.equal(isNoise(null, 'Script error.', ''), true);
  assert.equal(isNoise(null, 'ResizeObserver loop completed with undelivered notifications.', ''), true);
  assert.equal(isNoise(new TypeError('x is undefined'), 'x is undefined', 'at f (https://fundermatch.org/assets/a.js:1:1)'), false);
});

test('network failures and aborts are noise, in each browser\'s wording', () => {
  for (const msg of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'TypeError: Failed to fetch', 'Failed to fetch (tgtotjvdubhjxzybmdex.supabase.co)', 'Failed to send a request to the Edge Function']) {
    assert.equal(isNoise(new TypeError(msg), msg, ''), true, msg);
  }
  for (const msg of ['The network connection was lost.', 'The Internet connection appears to be offline.', 'cancelled']) {
    assert.equal(isNoise(new TypeError(msg), msg, ''), true, msg);
  }
  assert.equal(isNoise(new DOMException('The user aborted a request.', 'AbortError'), 'The user aborted a request.', ''), true);
  // An empty rejection says nothing; on the error screen it's still a bug.
  assert.equal(isNoise(undefined, 'undefined', ''), true);
  assert.equal(isNoise(undefined, 'undefined', '', false, true), false);
  assert.equal(isNoise(new TypeError('Failed to fetch funders: 500'), 'Failed to fetch funders: 500', ''), false);
  // But a request failure that brought up the error screen is a bug.
  assert.equal(buildCrashReport('boundary', new TypeError('Failed to fetch'), '/search', 'b').message, 'Failed to fetch');
  assert.equal(buildCrashReport('rejection', new TypeError('Failed to fetch'), '/search', 'b'), null);
  // An extension's error is noise even when it reaches the error screen.
  const ext = new TypeError('boom');
  ext.stack = 'TypeError: boom\n    at x (chrome-extension://abc/content.js:1:1)';
  assert.equal(buildCrashReport('boundary', ext, '/', 'b'), null);
});

test('chunk-load failures are noise unless the automatic reload already failed', () => {
  const chunk = new TypeError('Failed to fetch dynamically imported module: https://fundermatch.org/assets/Search-a1b2c3.js');
  assert.equal(isNoise(chunk, chunk.message, ''), true);
  assert.equal(isNoise(chunk, chunk.message, '', true), false);
});

test('describe handles errors, error-like objects, strings and odd values', () => {
  assert.deepEqual(describe('boom'), { name: 'NonError', message: 'boom', stack: '' });
  assert.equal(describe({ name: 'AbortError', message: 'aborted' }).name, 'AbortError');
  // A data object's name field isn't an error type.
  assert.equal(describe({ name: 'Jane Doe', message: 'hi' }).name, 'Error');
  // Only the shape of a non-Error value, never its contents.
  assert.equal(describe({ profile: { name: 'Jane Doe', phone: '555-0100' } }).message, 'object with keys profile');
  assert.equal(describe([1, 2]).message, 'array with keys 0, 1');
  const circular = {};
  circular.self = circular;
  assert.equal(describe(circular).name, 'NonError'); // no throw
  assert.equal(describe(undefined).message, 'undefined');
  assert.equal(describe(42).message, 'number');
});

test('the error name is scrubbed too', () => {
  const err = new Error('x');
  err.name = 'LookupError(jane@example.org)';
  assert.equal(buildCrashReport('error', err, '/', 'b').name, 'LookupError([email])');
});

test('buildCrashReport caps sizes and scrubs every text field', () => {
  const err = new Error(`user a@b.org ${'x'.repeat(2000)}`);
  err.stack = `Error\n    at f (https://fundermatch.org/assets/a.js?v=1:1:1)\n${'y'.repeat(9000)}`;
  const r = buildCrashReport('error', err, '/recipient/2da01037-c1bc-4106-8c21-40008ead6ca7', 'index-abc.js', 'in <Comp> a@b.org');
  assert.equal(r.type, 'crash');
  assert.ok(r.message.startsWith('user [email] '));
  assert.equal(r.message.length, 500);
  assert.equal(r.stack.length, 4000);
  assert.ok(!r.stack.includes('?v=1'));
  assert.equal(r.componentStack, 'in <Comp> [email]');
  assert.equal(r.path, '/recipient/:id');
});

test('buildCrashReport drops noise and keeps odd throws', () => {
  assert.equal(buildCrashReport('rejection', { message: 'Script error.' }, '/', 'b'), null);
  const chunk = new TypeError('Failed to fetch dynamically imported module: https://x/assets/a-1.js');
  assert.equal(buildCrashReport('boundary', chunk, '/', 'b'), null);
  assert.equal(buildCrashReport('boundary', chunk, '/', 'b', '', true).name, 'TypeError');
  // `throw null` that brought up the error screen is still worth knowing
  // about; an empty rejection elsewhere says nothing.
  assert.equal(buildCrashReport('boundary', null, '/', 'b').name, 'NonError');
  assert.equal(buildCrashReport('rejection', null, '/', 'b'), null);
});
