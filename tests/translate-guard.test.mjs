// Unit tests for src/lib/translateGuard.ts — the DOM patch that stops page
// translators (Google Translate's <font> wrappers) from crashing React with
// "NotFoundError: Failed to execute 'insertBefore' on 'Node'".
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/translateGuard.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { installTranslateGuard } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

// A minimal DOM: just the tree and the two methods the guard wraps, which
// throw NotFoundError on a parent mismatch the way browsers do. (Hermetic, like
// prerender.test.mjs: no jsdom, whose pinned transitive deps don't load here.)
class Node {
  constructor(nodeName, nodeValue = null) {
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  set textContent(text) { this.childNodes = []; this.append(new Node('#text', text)); }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
  insertBefore(node, ref) {
    if (ref && ref.parentNode !== this) throw new Error('NotFoundError: insertBefore');
    node.parentNode?.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(child) {
    if (child.parentNode !== this) throw new Error('NotFoundError: removeChild');
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(node, old) {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }
}
const document = {
  createElement: (name) => new Node(name.toUpperCase()),
  createTextNode: (text) => new Node('#text', text),
};
let warnings = 0;

// Control, before the guard goes in: the stand-in really throws on a mismatch.
const throwsUnguarded = (call) => { try { call(); return false; } catch { return true; } };
const unguarded = {
  removeChild: throwsUnguarded(() => new Node('DIV').removeChild(new Node('B'))),
  insertBefore: throwsUnguarded(() => new Node('DIV').insertBefore(new Node('B'), new Node('I'))),
};

before(() => {
  globalThis.Node = Node;
  const warn = console.warn;
  console.warn = (...args) => { if (String(args[0]).startsWith('translateGuard:')) warnings++; else warn(...args); };
  installTranslateGuard();
  installTranslateGuard(); // second call is a no-op, not a double wrap
});

test('without the guard the same calls throw NotFoundError', () => {
  assert.deepEqual(unguarded, { removeChild: true, insertBefore: true });
});

// A button as React rendered it: <svg/> then the bare text node "Save".
function button() {
  const el = document.createElement('button');
  const icon = document.createElement('i');
  const text = document.createTextNode('Save');
  el.append(icon, text);
  return { el, icon, text };
}

// What Google Translate does: swap the text node for <font><font>…</font></font>.
function translate(text) {
  const outer = document.createElement('font');
  const inner = document.createElement('font');
  inner.textContent = `[${text.nodeValue}]`;
  outer.append(inner);
  text.parentNode.replaceChild(outer, text);
  return outer;
}

test('insertBefore a translated-away text node appends instead of throwing', () => {
  // React's icon swap: delete the old icon, insert the new one before the
  // text node, which the translator has already replaced and detached.
  const { el, icon, text } = button();
  const font = translate(text);
  el.removeChild(icon);
  const next = document.createElement('b');
  assert.equal(el.insertBefore(next, text), next);
  assert.deepEqual([...el.childNodes], [font, next]);
});

test('insertBefore a node wrapped in place goes before the wrapper', () => {
  const { el, text } = button();
  const wrap = document.createElement('font');
  el.replaceChild(wrap, text);
  wrap.append(text); // text is now a grandchild of el
  const next = document.createElement('b');
  el.insertBefore(next, text);
  assert.equal(next.nextSibling, wrap);
});

test('removeChild a translated-away text node is a no-op instead of throwing', () => {
  const { el, icon, text } = button();
  const font = translate(text);
  assert.equal(el.removeChild(text), text);
  assert.deepEqual([...el.childNodes], [icon, font]);
});

test('removeChild a node wrapped in place removes it from the wrapper', () => {
  const { el, text } = button();
  const wrap = document.createElement('font');
  el.replaceChild(wrap, text);
  wrap.append(text);
  el.removeChild(text);
  assert.equal(text.parentNode, null);
});

test('removeChild of a node from an unrelated tree is left alone', () => {
  const { el } = button();
  const other = document.createElement('div');
  const stranger = document.createElement('span');
  other.append(stranger);
  el.removeChild(stranger);
  assert.equal(stranger.parentNode, other);
});

test('normal DOM calls are unchanged', () => {
  const { el, icon, text } = button();
  const next = document.createElement('b');
  el.insertBefore(next, text);
  assert.deepEqual([...el.childNodes], [icon, next, text]);
  el.insertBefore(document.createElement('u'), null);
  assert.equal(el.lastChild.nodeName, 'U');
  el.removeChild(icon);
  assert.equal(el.firstChild, next);
});

test('warns once, not on every recovery', () => {
  assert.equal(warnings, 1);
});
