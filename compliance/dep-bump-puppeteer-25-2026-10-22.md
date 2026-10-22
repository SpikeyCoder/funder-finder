# Puppeteer 25 upgrade + basic-ftp override — 2026-10-22

**Date:** 2026-10-22
**Severity:** Low (dev-dependency hygiene; no production exposure)
**Status:** Fixed in `security/puppeteer-25`

## Summary

`npm audit` reported 11 advisories (10 high, 1 moderate), all in
**dev-only** chains under `puppeteer` and `@axe-core/cli`.
`npm audit --omit=dev` was already clean, so nothing ships in the Vite
bundle. Neither tool runs in CI: `puppeteer` runs only from the
developer-run `npm run prerender` (all cross-origin requests are blocked,
and it uses no secrets). `@axe-core/cli` is run by hand for a11y checks.
CI (`ci.yml`) installs both with `npm ci`. That runs puppeteer's
browser-download postinstall, which is the path where `extract-zip`
was reachable.

## Findings

| Advisory | Package | Locked | Reach | Fix |
|----------|---------|--------|-------|-----|
| GHSA-7pqw-9j4j-h8q3, GHSA-jmr9-qjv8-65gv (high) | `extract-zip` (no patched release exists) | 2.0.1 | `puppeteer@24` → `@puppeteer/browsers@2` | `puppeteer` 24.43.1 → 25.16.0; `@puppeteer/browsers@3` drops `extract-zip` and `proxy-agent` |
| GHSA-c475-qrg2-pj4r (high) | `basic-ftp` | 5.3.1 | `@axe-core/cli` → `chromedriver` → `proxy-agent` → `pac-proxy-agent` → `get-uri` | new override `basic-ftp: >=6.2.3` |
| GHSA-rxp7-6hxx-x8q5 (moderate) | `ip-address` | 10.7.2 | `chromedriver` → `socks-proxy-agent` → `socks` | `npm audit fix` → 10.7.4 |

## Why an override for `@axe-core/cli`

4.14.0 is already the latest release, and it pins `chromedriver ~152`.
`npm audit fix --force` would downgrade the CLI to 4.7.3, which is
rejected. Switching to `@axe-core/puppeteer` would mean writing a new a11y
script, which is more than this fix needs. `get-uri@8` uses only
`Client.access/lastMod/list/downloadTo/close`. Those signatures are
identical in `basic-ftp` 5.3.1 and 6.2.3, so the override is safe.

## Puppeteer 25 breaking changes

- ESM-only: `scripts/prerender.mjs` already uses `import puppeteer from 'puppeteer'`.
- `executablePath()` / `defaultArgs()` now return Promises: not used.
- Minimum Node is 22.12: `ci.yml` uses Node 22. `supply-chain-audit.yml` is
  bumped from Node 20 to 22 to match.

## Verification

1. `npm ci --include=optional` from the regenerated lockfile.
2. `npm audit` → 0 vulnerabilities. `npm audit --omit=dev` → 0.
3. `npm run lint`, `npm run build`, `npm test` (74/74) pass.
4. `npm run prerender` renders 6/6 routes. The committed `prerender/bodies/` are unchanged.
5. `npx axe <preview-url>` runs end to end with the overridden `basic-ftp`
   (it needs a Chrome that matches chromedriver 152).
