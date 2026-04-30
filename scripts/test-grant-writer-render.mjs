#!/usr/bin/env node
/**
 * Sanity check for the GrantWriter markdown renderer.
 *
 * Feeds a battery of XSS payloads through a port of the renderer in
 * src/pages/GrantWriter.tsx, then parses the resulting HTML and asserts
 * the parsed DOM contains:
 *   - no <script>, <iframe>, <svg>, <object>, <embed>, <link>, <style> elements,
 *   - no element with any on* event-handler attribute,
 *   - no anchor href starting with `javascript:` or `data:text/html`.
 *
 * Run: node scripts/test-grant-writer-render.mjs
 */
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// KEEP THIS PORT IN SYNC WITH src/pages/GrantWriter.tsx renderMarkdown().
function renderMarkdown(text) {
  const lines = text.split('\n');
  const parts = [];
  for (const rawLine of lines) {
    const esc = rawLine
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const inl = esc.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-white">$1</strong>');
    if (rawLine.startsWith('### '))      parts.push(`<h3 class="...">${inl.slice(4)}</h3>`);
    else if (rawLine.startsWith('## '))  parts.push(`<h2 class="...">${inl.slice(3)}</h2>`);
    else if (rawLine === '---')          parts.push('<hr class="...">');
    else if (rawLine.startsWith('- [x] ')) parts.push(`<div class="..."><span>✓</span><span>${inl.slice(6)}</span></div>`);
    else if (rawLine.startsWith('- [ ] ')) parts.push(`<div class="..."><span>○</span><span>${inl.slice(6)}</span></div>`);
    else if (rawLine.startsWith('  - '))   parts.push(`<div class="..."><span>–</span><span>${inl.slice(4)}</span></div>`);
    else if (rawLine.startsWith('- '))     parts.push(`<div class="..."><span>•</span><span>${inl.slice(2)}</span></div>`);
    else if (rawLine === '')               parts.push('<div class="..."></div>');
    else                                   parts.push(`<p class="...">${inl}</p>`);
  }
  return DOMPurify.sanitize(parts.join(''), {
    ALLOWED_TAGS: ['h2', 'h3', 'p', 'span', 'div', 'strong', 'em', 'hr', 'br'],
    ALLOWED_ATTR: ['class'],
    USE_PROFILES: { html: true },
  });
}

const FORBIDDEN_TAGS = ['script', 'iframe', 'svg', 'object', 'embed', 'link', 'style', 'img', 'a'];

function liveSinks(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  const issues = [];
  for (const el of root.querySelectorAll('*')) {
    if (FORBIDDEN_TAGS.includes(el.tagName.toLowerCase())) {
      issues.push(`disallowed tag: <${el.tagName.toLowerCase()}>`);
    }
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) {
        issues.push(`event handler: ${el.tagName.toLowerCase()} ${attr.name}=`);
      }
      if (attr.name.toLowerCase() === 'href' || attr.name.toLowerCase() === 'src') {
        const v = attr.value.trim().toLowerCase();
        if (v.startsWith('javascript:') || v.startsWith('data:text/html')) {
          issues.push(`dangerous URL on ${el.tagName.toLowerCase()}.${attr.name}: ${v.slice(0, 40)}…`);
        }
      }
    }
  }
  return issues;
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="data:text/html,<script>alert(1)</script>">click</a>',
  'plain & < > " \' text',
  '## **bold** in heading <img src=x onerror=alert(1)>',
  '- [x] task with <script>',
  '<style>body{background:url("javascript:alert(1)")}</style>',
  '<a href="javascript&colon;alert(1)">obfuscated</a>',
  '<IMG SRC="jav\\tascript:alert(1)">',
  '<a xlink:href="javascript:alert(1)">svg-style</a>',
];

let pass = 0, fail = 0;
for (const payload of PAYLOADS) {
  const out = renderMarkdown(payload);
  const issues = liveSinks(out);
  if (issues.length === 0) {
    pass += 1;
    console.log('PASS:', JSON.stringify(payload).slice(0, 80));
  } else {
    fail += 1;
    console.log('FAIL:', JSON.stringify(payload).slice(0, 80));
    console.log('  output:', out);
    issues.forEach(i => console.log('  -', i));
  }
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
