#!/usr/bin/env node

/**
 * generate-spa-routes.js
 *
 * GitHub Pages serves static files — it cannot do server-side rewrites.
 * For SPA routing to work with clean URLs AND a 200 HTTP status, every
 * client-side route needs a physical `{route}/index.html` that contains
 * the full app shell.  This script copies `dist/index.html` into each
 * known route directory so that GitHub Pages resolves them normally.
 *
 * Run after `vite build`:
 *   node scripts/generate-spa-routes.js
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const INDEX = join(DIST, 'index.html');

// All public (non-auth-gated) routes that users might bookmark, share,
// or arrive at directly.  Auth-gated routes redirect to /login anyway,
// but we include common ones for a smoother experience.
const routes = [
  'mission',
  'results',
  'saved',
  'grant-writer',
  'search',
  'browse',
  'login',
  'signup',
  'dashboard',
  'portfolio',
  'tasks',
  'reports',
  'applications',
  'settings',
  'settings/team',
  'settings/team/activity',
  'onboarding/welcome',
  'onboarding/profile',
  'onboarding/first-project',
  'onboarding/matches',
  'onboarding/save',
  'projects/new',
  'find',
];

if (!existsSync(INDEX)) {
  console.error('dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

let created = 0;
for (const route of routes) {
  const dir = join(DIST, route);
  const dest = join(dir, 'index.html');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Don't overwrite if Vite already emitted something there
  if (!existsSync(dest)) {
    copyFileSync(INDEX, dest);
    created++;
  }
}

console.log(`SPA routes: created ${created} index.html copies for ${routes.length} routes.`);
