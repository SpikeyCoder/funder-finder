# Dependency bump — dompurify 3.4.11 + undici 7.28.0 override (FM-2026-06-19-01)

**Date:** 2026-06-19
**Linked findings:** FM-2026-06-19-01 (DOMPurify XSS), FM-2026-06-19-02 (undici TLS bypass)

## Context

Two npm advisories were published on 2026-06-17 and indexed in the
GitHub Advisory Database on 2026-06-18 — after the 2026-06-18 scheduled
pen-test run (`compliance/pentest-2026-06-18.md`) had already reported
"npm audit — 0 vulnerabilities". The 2026-06-19 scheduled pen-test
re-ran `npm audit` and surfaced the new advisories.

| Advisory | Package | Severity | CVSS | Path | Patched in |
|---|---|---|---|---|---|
| [GHSA-cmwh-pvxp-8882](https://github.com/advisories/GHSA-cmwh-pvxp-8882) | `dompurify` | Moderate | 5.1 (v4) | Direct prod dependency | 3.4.11 |
| [GHSA-vmh5-mc38-953g](https://github.com/advisories/GHSA-vmh5-mc38-953g) (CVE-2026-9697) | `undici` | High | 7.4 (v3.1) | Transitive via `jsdom` (dev) | 7.28.0 / 8.5.0 |
| [GHSA-pr7r-676h-xcf6](https://github.com/advisories/GHSA-pr7r-676h-xcf6) | `undici` | Moderate | 5.9 | Same transitive path | 7.28.0 / 8.5.0 |

## DOMPurify GHSA-cmwh-pvxp-8882 — applicability

The vulnerability requires the application to do BOTH:

1. Call `DOMPurify.setConfig(...)` (persistent config), AND
2. Register an `uponSanitizeAttribute` hook that writes
   `data.allowedAttributes[name] = true`.

FunderMatch uses DOMPurify in a single place (`src/utils/sanitize.ts` /
`src/components/HtmlContent.tsx` — call sites that pass per-call config
into `DOMPurify.sanitize(input, { ... })`). We do not call
`DOMPurify.setConfig()` and we do not register
`uponSanitizeAttribute` hooks. The vulnerability is therefore not
exploitable in the current codebase. Bumping anyway closes the
advisory and removes the latent risk if a future PR ever adopts the
persistent-config API.

## undici GHSA-vmh5-mc38-953g — applicability

undici 7.25.0 enters the dependency graph as a transitive dep of
`jsdom` (devDependency only, used by the local axe-core a11y test
runner). FunderMatch does not ship undici to production and does not
use undici's `ProxyAgent` anywhere. The advisory is not exploitable in
our deployed runtime, but `npm audit` reports it as High because the
ecosystem-wide CVSS for a TLS validation bypass is 7.4 and we want a
clean `npm audit` for the SOC 2 dependency-management control (CC9).

## Change

`package.json`:

- `dependencies.dompurify`: `^3.4.10` -> `^3.4.11`
- `overrides.undici`: new entry `">=7.28.0"`

`package-lock.json` regenerated:

- `node_modules/dompurify` resolves to `3.4.11`
- `node_modules/undici` resolves to `8.5.0` (highest satisfying release; npm
  picks the latest major that meets the override floor)

`npm audit` post-bump: **0 vulnerabilities** across 341 packages.

## Verification

```
npm install --package-lock-only
npm audit                       # expect: found 0 vulnerabilities
grep -A1 '"node_modules/dompurify":' package-lock.json | head -2
grep -A1 '"node_modules/undici":' package-lock.json | head -2
```

## References

- [GHSA-cmwh-pvxp-8882](https://github.com/advisories/GHSA-cmwh-pvxp-8882) — DOMPurify
- [GHSA-vmh5-mc38-953g](https://github.com/advisories/GHSA-vmh5-mc38-953g) — undici TLS bypass (CVE-2026-9697)
- [GHSA-pr7r-676h-xcf6](https://github.com/advisories/GHSA-pr7r-676h-xcf6) — undici cache info disclosure
- CWE-79 (XSS), CWE-471 (modification of assumed-immutable data),
  CWE-295 (improper certificate validation)
- OWASP A06:2021 — Vulnerable and Outdated Components
