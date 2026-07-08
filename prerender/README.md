# Static prerendering

fundermatch.org is a client-rendered SPA: the shell ships an empty
`<div id="root">`, so crawlers and AI/LLM agents that don't run JS see no
content. This directory extends the project's existing "static prerender" idea
(the hand-authored landing pages under `public/foundation-grants`, …) to the
app's remaining **public** routes — without an SSR rewrite.

## How it works

Two collaborators, split so that the **deploy build never needs a browser**:

1. **`npm run prerender`** (`scripts/prerender.mjs`) — the offline generator.
   Builds the app, serves `dist/` locally, and renders each route in headless
   Chromium (Puppeteer, already a devDependency) with **all cross-origin
   requests blocked** (Supabase, fonts, analytics) so the render is
   deterministic, network-free, and uses no secrets. It captures each route's
   rendered `<div id="root">` markup and writes it to
   `prerender/bodies/<slug>.html`. **These fragments are committed.**

2. **`scripts/vite-plugin-prerender.mjs`** — runs during every `vite build`
   (`closeBundle`). For each route in `manifest.mjs` it stitches:

   ```
   freshly-built shell  +  per-route <head> SEO (manifest)  +  committed body fragment
   ```

   and writes `dist/<dir>/index.html`. Because the shell is read fresh each
   build, the injected `<script>`/`<link>` asset hashes are **always current**,
   so the pages both (a) show real content to no-JS crawlers and (b) still boot
   the SPA for real browsers (React re-renders over the prerendered markup).

   This step is pure string assembly, so it runs in **any** build environment
   (GitHub Actions, Cloudflare Pages, local) — which is what makes the output
   guaranteed to ship regardless of deploy host.

## Regenerating

Re-run when the rendered content of a prerendered page changes:

```sh
npm run prerender     # rewrites prerender/bodies/*.html
git add prerender/bodies
```

CI (`npm test`) fails if a built page is missing content, so drift surfaces on
the PR. The content check is browser-free (`node --test` + jsdom); Puppeteer is
only needed to regenerate fragments.

## What is / isn't prerendered

Covered routes and the reasons some are excluded (auth-gated, per-user, dynamic
`:id`, or thin) live in `manifest.mjs` (`ROUTES` and `EXCLUDED_ROUTES`). Keep
those the single source of truth.
