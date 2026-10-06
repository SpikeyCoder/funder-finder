# Dependency overrides bump — 2026-06-16 (FM-2026-06-16-01)

**Date:** 2026-06-16
**Finding ID:** FM-2026-06-16-01
**Severity:** Low (dev-dependency hygiene; no production exposure)
**Status:** Fixed in `sec/dep-overrides-bump-FM-2026-06-16-01`

## Summary

`npm audit` (2026-06-16) surfaced three new advisories against transitive
**dev-only** dependencies. None ship in the production Vite bundle (all
reach via `puppeteer` / `selenium-webdriver` / `cosmiconfig` /
`@axe-core/cli`), so user-facing exposure is **zero**. This PR raises the
`overrides` floors so `npm install` resolves a patched version.

## Findings

| Advisory | Package | Locked version | Fixed in | Reach |
|----------|---------|----------------|----------|-------|
| GHSA-hmw2-7cc7-3qxx (CWE-93, CVSS 7.5) | `form-data` | 4.0.5 | ≥ 4.0.6 | dev (transitive via `axios` used by dev tooling) |
| GHSA-96hv-2xvq-fx4p (CWE-400/770, CVSS 7.5) | `ws` | 8.20.1 | ≥ 8.21.0 | dev (transitive via `puppeteer-core`, `selenium-webdriver`) |
| GHSA-h67p-54hq-rp68 (CWE-407, CVSS 5.3) | `js-yaml` | 4.1.1 | ≥ 4.1.2 | dev (transitive via `cosmiconfig`) |

## Remediation

`package.json` `overrides` block updated:

- `ws`: `>=8.20.1` → `>=8.21.0`
- `form-data`: new entry `>=4.0.6`
- `js-yaml`: new entry `>=4.1.2`

`tmp` (≥ 0.2.7) and `axios` (≥ 1.15.0) overrides retained.

## Verification

1. `npm install` regenerates `package-lock.json`.
2. `npm audit` → expect `0 vulnerabilities`.
3. `npm run build` succeeds — production bundle unaffected (none of these
   packages are imported by the Vite app).
4. `npm run eval:ranker` and Puppeteer-driven scripts succeed (dev tooling
   path).

## References

- OWASP A06:2021 — Vulnerable and Outdated Components
- CWE-93 (CRLF injection), CWE-400 (Uncontrolled Resource Consumption),
  CWE-407 (Algorithmic Complexity)
- NIST SP 800-218 PW.4.1 (acquire components from trusted sources)
