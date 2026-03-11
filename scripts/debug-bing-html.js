#!/usr/bin/env node
/**
 * Quick diagnostic: fetch a Bing search and analyze the HTML structure.
 * Usage: node scripts/debug-bing-html.js "Adams Temple School Fund"
 */

import { writeFileSync } from 'fs';

const query = process.argv[2] || 'Adams Temple School Fund nonprofit';

async function main() {
  console.log(`Fetching Bing search for: "${query}"\n`);

  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  console.log(`Status: ${res.status}`);
  const html = await res.text();
  console.log(`HTML length: ${html.length} chars\n`);

  writeFileSync('/tmp/bing-debug.html', html, 'utf8');
  console.log('Full HTML saved to /tmp/bing-debug.html\n');

  // Check key patterns
  console.log('── Bing Pattern Analysis ──');
  const bAlgo = (html.match(/class="b_algo"/g) || []).length;
  console.log(`class="b_algo" occurrences: ${bAlgo}`);

  const bResults = (html.match(/class="b_results"/g) || []).length;
  console.log(`class="b_results" occurrences: ${bResults}`);

  const cites = (html.match(/<cite/g) || []).length;
  console.log(`<cite> tags: ${cites}`);

  // All href="https://..." that are NOT bing
  const allHrefs = html.match(/href="(https?:\/\/[^"]+)"/g) || [];
  const externalUrls = [];
  for (const h of allHrefs) {
    const m = h.match(/href="(https?:\/\/[^"]+)"/);
    if (m) {
      try {
        const host = new URL(m[1]).hostname;
        if (!host.includes('bing.com') && !host.includes('microsoft.com') && !host.includes('msn.com')) {
          externalUrls.push(m[1]);
        }
      } catch {}
    }
  }
  console.log(`\nTotal external hrefs: ${externalUrls.length}`);
  const unique = [...new Set(externalUrls)];
  unique.slice(0, 20).forEach(u => console.log(`  ${u}`));

  // Show context around first b_algo or first external href
  if (bAlgo > 0) {
    const idx = html.indexOf('class="b_algo"');
    const context = html.slice(Math.max(0, idx - 50), idx + 500);
    console.log(`\n── Context around first b_algo ──`);
    console.log(context);
  } else if (externalUrls.length > 0) {
    const idx = html.indexOf(externalUrls[0]);
    const context = html.slice(Math.max(0, idx - 200), idx + 300);
    console.log(`\n── Context around first external URL ──`);
    console.log(context);
  }

  // Check script content ratio
  const scriptBlocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  let scriptChars = 0;
  for (const b of scriptBlocks) scriptChars += b.length;
  console.log(`\nScript content: ${scriptChars} chars (${Math.round(scriptChars/html.length*100)}% of page)`);

  // Show first 1500 chars of non-script HTML
  const noScript = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '[SCRIPT]');
  console.log(`\n── First 2000 chars (scripts removed) ──`);
  console.log(noScript.slice(0, 2000));
}

main().catch(e => console.error('Error:', e.message));
