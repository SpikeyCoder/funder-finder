#!/usr/bin/env node
/**
 * Quick diagnostic: fetch a Google search and analyze the HTML structure.
 * Usage: node scripts/debug-google-html.js "1 Care Premier Foundation"
 */

import { writeFileSync } from 'fs';

const query = process.argv[2] || '1 Care Premier Foundation';

async function main() {
  console.log(`Fetching Google search for: "${query}"\n`);

  const res = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  console.log(`Status: ${res.status}`);
  console.log(`Content-Type: ${res.headers.get('content-type')}`);

  const html = await res.text();
  console.log(`HTML length: ${html.length} chars\n`);

  // Save full HTML for manual inspection
  writeFileSync('/tmp/google-debug.html', html, 'utf8');
  console.log('Full HTML saved to /tmp/google-debug.html\n');

  // Check for blocking
  const blockSignals = ['captcha', 'unusual traffic', 'consent.google', 'sorry/index',
    'sorry.google', 'automated requests', 'detected unusual traffic'];
  for (const sig of blockSignals) {
    if (html.includes(sig)) console.log(`⚠ BLOCK SIGNAL FOUND: "${sig}"`);
  }

  // Analyze what patterns exist in the HTML
  console.log('\n── Pattern Analysis ──');

  // Pattern 1: /url?q=
  const p1 = (html.match(/\/url\?q=/g) || []).length;
  console.log(`/url?q= occurrences: ${p1}`);

  // Pattern 2: yuRUbf
  const p2 = (html.match(/yuRUbf/g) || []).length;
  console.log(`yuRUbf class occurrences: ${p2}`);

  // Pattern 2b: class="g"
  const p2b = (html.match(/class="g"/g) || []).length;
  console.log(`class="g" occurrences: ${p2b}`);

  // Pattern 2c: data-href
  const p2c = (html.match(/data-href/g) || []).length;
  console.log(`data-href occurrences: ${p2c}`);

  // Count all href="https://..."
  const allHrefs = html.match(/href="(https?:\/\/[^"]+)"/g) || [];
  console.log(`\nTotal href="https://..." occurrences: ${allHrefs.length}`);

  // Show unique external domains found in hrefs
  const domains = new Set();
  const externalUrls = [];
  for (const h of allHrefs) {
    const m = h.match(/href="(https?:\/\/[^"]+)"/);
    if (m) {
      try {
        const url = new URL(m[1]);
        const host = url.hostname;
        if (!host.includes('google') && !host.includes('gstatic') && !host.includes('googleapis')) {
          domains.add(host);
          externalUrls.push(m[1]);
        }
      } catch {}
    }
  }
  console.log(`External (non-Google) domains in hrefs: ${domains.size}`);
  for (const d of [...domains].slice(0, 20)) {
    console.log(`  - ${d}`);
  }

  if (externalUrls.length > 0) {
    console.log(`\nFirst 10 external URLs:`);
    for (const u of externalUrls.slice(0, 10)) {
      console.log(`  ${u}`);
    }
  }

  // Look for other link patterns Google might use
  console.log('\n── Alternative Link Patterns ──');

  // data-url
  const dataUrl = (html.match(/data-url="(https?:\/\/[^"]+)"/g) || []);
  console.log(`data-url= occurrences: ${dataUrl.length}`);
  dataUrl.slice(0, 5).forEach(u => console.log(`  ${u}`));

  // data-lpage
  const dataLpage = (html.match(/data-lpage="(https?:\/\/[^"]+)"/g) || []);
  console.log(`data-lpage= occurrences: ${dataLpage.length}`);

  // ping= attribute (Google sometimes uses this for click tracking)
  const ping = (html.match(/ping="[^"]*"/g) || []).length;
  console.log(`ping= occurrences: ${ping}`);

  // <cite> tags (Google shows URL in cite elements)
  const cites = html.match(/<cite[^>]*>[^<]*<\/cite>/g) || [];
  console.log(`<cite> tags: ${cites.length}`);
  cites.slice(0, 5).forEach(c => console.log(`  ${c}`));

  // Look for JSON-LD or structured data
  const jsonLd = (html.match(/application\/ld\+json/g) || []).length;
  console.log(`JSON-LD blocks: ${jsonLd}`);

  // Look for data-ved (Google tracking param, usually near result links)
  const dataVed = (html.match(/data-ved/g) || []).length;
  console.log(`data-ved occurrences: ${dataVed}`);

  // Show a snippet around the first external URL to see its context
  if (externalUrls.length > 0) {
    const firstUrl = externalUrls[0];
    const idx = html.indexOf(firstUrl);
    if (idx >= 0) {
      const context = html.slice(Math.max(0, idx - 200), idx + firstUrl.length + 100);
      console.log(`\n── Context around first external URL ──`);
      console.log(context);
      console.log(`── End context ──`);
    }
  }

  // Look for URLs ANYWHERE in the raw HTML (including inside <script> blocks)
  console.log('\n── URLs in raw text (including script blocks) ──');
  const rawUrlPattern = /https?:\/\/[a-zA-Z0-9._~:/?#\[\]@!$&\'()*+,;=%-]{5,200}/g;
  const rawUrls = html.match(rawUrlPattern) || [];
  const rawDomains = {};
  for (const u of rawUrls) {
    try {
      const host = new URL(u).hostname;
      if (!host.includes('google') && !host.includes('gstatic') && !host.includes('googleapis')) {
        rawDomains[host] = (rawDomains[host] || 0) + 1;
      }
    } catch {}
  }
  console.log(`Total raw URLs found: ${rawUrls.length}`);
  console.log(`External domains:`);
  const sortedDomains = Object.entries(rawDomains).sort((a, b) => b[1] - a[1]);
  for (const [domain, count] of sortedDomains.slice(0, 30)) {
    console.log(`  ${count}x ${domain}`);
  }

  // Search for the specific target domain we EXPECT to find
  const target = '1carepremier';
  const targetMatches = rawUrls.filter(u => u.toLowerCase().includes(target));
  console.log(`\nURLs containing "${target}": ${targetMatches.length}`);
  targetMatches.forEach(u => console.log(`  ${u}`));

  // Look for URLs inside script tags specifically
  console.log('\n── Script tag analysis ──');
  const scriptBlocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  console.log(`Number of <script> blocks: ${scriptBlocks.length}`);
  let totalScriptChars = 0;
  for (const block of scriptBlocks) {
    totalScriptChars += block.length;
  }
  console.log(`Total script content: ${totalScriptChars} chars (${Math.round(totalScriptChars/html.length*100)}% of page)`);

  // Find external URLs inside script blocks
  const scriptUrls = [];
  for (const block of scriptBlocks) {
    const matches = block.match(rawUrlPattern) || [];
    for (const u of matches) {
      try {
        const host = new URL(u).hostname;
        if (!host.includes('google') && !host.includes('gstatic') && !host.includes('googleapis')) {
          scriptUrls.push(u);
        }
      } catch {}
    }
  }
  console.log(`External URLs inside <script> blocks: ${scriptUrls.length}`);
  const uniqueScriptUrls = [...new Set(scriptUrls)];
  uniqueScriptUrls.slice(0, 20).forEach(u => console.log(`  ${u}`));

  // Look for escaped URL patterns (Google often escapes URLs in JS)
  console.log('\n── Escaped URL patterns ──');
  // \\x2F = /, \\x3A = :, \\u002F = /
  const escapedHttps = (html.match(/https?:\\x2F\\x2F/g) || []).length;
  console.log(`https:\\x2F\\x2F occurrences: ${escapedHttps}`);
  const escapedHttps2 = (html.match(/https?:\\u002F\\u002F/g) || []).length;
  console.log(`https:\\u002F\\u002F occurrences: ${escapedHttps2}`);
  const escapedHttps3 = (html.match(/https?:\/\\\//g) || []).length;
  console.log(`https:\\/\\/ occurrences: ${escapedHttps3}`);

  // Try to find and decode escaped URLs
  const escapedPattern = /https?:\\x2F\\x2F[\\xa-fA-F0-9./_~:?#\[\]@!$&'()*+,;=%-]+/g;
  const escapedUrls = html.match(escapedPattern) || [];
  console.log(`Escaped URLs found: ${escapedUrls.length}`);
  // Decode \x2F -> / etc
  for (const eu of escapedUrls.slice(0, 15)) {
    const decoded = eu.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    try {
      const host = new URL(decoded).hostname;
      if (!host.includes('google') && !host.includes('gstatic')) {
        console.log(`  ${decoded}`);
      }
    } catch {}
  }

  // Also check for unicode-escaped URLs
  const unicodePattern = /https?:\\u002F\\u002F[\\ua-fA-F0-9./_~:?#\[\]@!$&'()*+,;=%-]+/g;
  const unicodeUrls = html.match(unicodePattern) || [];
  console.log(`Unicode-escaped URLs: ${unicodeUrls.length}`);

  // Show first 2000 non-google chars to see overall structure
  console.log('\n── First 2000 chars of HTML ──');
  console.log(html.slice(0, 2000));

  // Show a middle section to see if results data is there
  console.log('\n── Chars 30000-32000 (mid-page) ──');
  console.log(html.slice(30000, 32000));
}

main().catch(e => console.error('Error:', e.message));
