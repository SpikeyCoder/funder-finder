---
title: Supply Chain Threat Review — 2026-05-31
tsc: CC3.1, CC3.2, CC7.1, CC7.2
owner: Kevin Armstrong
review-cadence: monthly
last-reviewed: 2026-05-31
---

# Supply Chain Threat Review — 2026-05-31

Follows up the 2026-05-19 and 2026-05-27 reviews. Re-checks our npm
dependency graph against active campaigns reported by Socket.dev,
StepSecurity, Snyk, Wiz, GitGuardian, Tenable, and Microsoft Security
in the 30 days leading up to 2026-05-31.

## Campaigns reviewed

| Date | Campaign | Affected ecosystem(s) | Sample compromised packages | Source |
|------|----------|------------------------|------------------------------|--------|
| 2026-03 | Axios maintainer-account compromise | npm | `axios` (rolled back; ≥ 1.13.5 clean; ≥ 1.15.0 recommended) | CSA Singapore AD-2026-002, socket.dev |
| 2026-04-22 | npm worm (Namastex Labs / CanisterWorm) | npm | misc agentic-AI packages | The Register, socket.dev |
| 2026-04-29 | TeamPCP SAP CAP compromise | npm | `@sap/cap-*` preinstall dropper | socket.dev |
| 2026-05-11 | Mini Shai-Hulud — TanStack + others | npm + PyPI | `@tanstack/*` (84 artifacts), `mistralai`, `@uipath/*` (65), `@antv/*`, Guardrails AI, OpenSearch | Snyk, Wiz, Microsoft Security, Tenable |
| 2026-05-19 | Microsoft `durabletask` PyPI hijack | PyPI | `durabletask` 1.4.1 / 1.4.2 / 1.4.3 (dropper for `rope.pyz`) | StepSecurity |
| 2026-05-22 | TrapDoor cross-ecosystem campaign | npm + PyPI + crates.io | 34+ packages, 384+ versions targeting crypto/DeFi/Solana/AI devs | TheHackerNews |
| 2026-05-29 | Bitwarden CLI 2026.4.0 compromise | npm (via CI/CD) | `@bitwarden/cli` 2026.4.0 | socket.dev (Checkmarx supply-chain extension) |

## Exposure to FunderMatch

Cross-referenced against `package.json`, `package-lock.json`, and every
edge function under `supabase/functions/`:

- `axios`: pinned at floor `>=1.15.0` via `overrides`. `package-lock.json`
  resolves to `1.16.0`. **Not vulnerable.**
- `@tanstack/*`: **not in the dependency graph** (we use `react-router-dom`).
- `mistralai`: **not in the dependency graph.**
- `@uipath/*`, `@antv/*`, `@sap/*`: **none present.**
- `@bitwarden/cli`: **not present.** Bitwarden is not in our CI/CD path.
- Edge functions use pinned ESM URLs against `https://esm.sh/@supabase/supabase-js@2.49.1`;
  no `@tanstack`, `mistralai`, `@antv`, or `@uipath` import strings appear in any
  function source.

Direct exposure: **none** across all reviewed campaigns.

## Defensive controls re-verified

| Control | Status |
|---------|--------|
| `npm audit` clean on `package-lock.json` (0 vulnerabilities) | Verified 2026-05-31 |
| Dependabot enabled for npm + GitHub Actions | Verified 2026-05-31 |
| Lockfile committed; no floating ranges resolve at install time | Verified 2026-05-31 |
| `axios` override floor pinned to `>=1.15.0` | Verified 2026-05-31 |
| Edge function ESM imports use exact-version URLs | Verified 2026-05-31 |
| Weekly supply-chain GitHub Actions audit (`.github/workflows/supply-chain-audit.yml`) | Verified 2026-05-31 |

## Action items

1. Continue weekly Socket.dev / OSV / npm advisory review.
2. If a future release adds `@tanstack/*`, `mistralai`, `@uipath/*`, or
   `@antv/*`, treat the install host as compromised if it was installed
   between 2026-05-11 and 2026-05-12 and rotate all developer secrets per
   the Mini Shai-Hulud guidance.
3. Track Bitwarden CLI deprecation guidance — not in our path today but
   relevant if any future automation adds it.

## References

- [Socket: Mini Shai-Hulud — TanStack npm Packages Compromised](https://snyk.io/blog/tanstack-npm-packages-compromised/)
- [Microsoft Security: Mini Shai-Hulud — Compromised @antv npm packages](https://www.microsoft.com/en-us/security/blog/2026/05/20/mini-shai-hulud-compromised-antv-npm-packages-enable-ci-cd-credential-theft/)
- [StepSecurity: Microsoft durabletask PyPI compromise](https://www.stepsecurity.io/blog/microsofts-durabletask-pypi-package-compromised-in-supply-chain-attack)
- [TheHackerNews: TrapDoor cross-ecosystem campaign](https://thehackernews.com/2026/05/trapdoor-supply-chain-attack-spreads.html)
- [Tenable: Mini Shai-Hulud FAQ (CVE-2026-45321)](https://www.tenable.com/blog/mini-shai-hulud-frequently-asked-questions)
- [CSA Singapore: Axios maintainer compromise AD-2026-002](https://www.csa.gov.sg/alerts-and-advisories/advisories/ad-2026-002/)
