---
title: Supply Chain Hardening — ws CVE GHSA-58qx-3vcg-4xpx
tsc: CC7.1, CC9.2
owner: Kevin Armstrong
review-cadence: per-event
last-reviewed: 2026-05-19
finding: FM-2026-05-19-01
relates-to: package.json, package-lock.json
---

# Supply chain — ws transitive vulnerability (GHSA-58qx-3vcg-4xpx)

## Context

`npm audit` on 2026-05-19 flagged a single **moderate** vulnerability in
the transitive dependency `ws@8.0.0 - 8.20.0`
([GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx),
CWE-908 Uninitialised Memory Disclosure).

`ws` reaches the repo through:

`puppeteer -> @puppeteer/browsers / puppeteer-core -> ws`

It is a `devDependencies` chain (puppeteer is used for accessibility
audits in `eval/` and for the `npm run eval:*` scripts), so the
vulnerability does not ship to the browser bundle. It still surfaces in
CI as a moderate-severity advisory and would block a SOC 2 vulnerability-
management review (`CC7.1`).

## Threat intelligence

Cross-reference with current supply chain incidents:

- **Mini Shai-Hulud (May 2026)** — TanStack / Mistral AI / Guardrails AI /
  Intercom-client / PyTorch-Lightning. None of those packages appear in
  this repo's `package.json` or `package-lock.json`.
- **Axios npm compromise (March 2026)** — malicious versions `1.14.1` and
  `0.30.4`. This repo resolves `axios@1.16.0`; not affected.
- **LiteLLM PyPI compromise (March 2026)** — Python package; this repo is
  a Node frontend, no Python deps.

`ws@8.0.0 - 8.20.0` is **not** part of any active supply-chain
campaign — it is a vendor-disclosed memory-disclosure bug fixed in
`8.20.1`.

## Fix

Pinned `ws >= 8.20.1` via an npm `overrides` entry in `package.json` so
the transitive resolution is hoisted to a patched version without
needing the upstream `puppeteer` package to publish a new release. The
lockfile was regenerated with `npm install --package-lock-only` so the
dependency graph stays reproducible in CI.

```json
{
  "overrides": {
    "ws": ">=8.20.1"
  }
}
```

Post-fix `npm audit` shows zero vulnerabilities of any severity.

## Verification

```
npm install --package-lock-only --no-audit --no-fund
npm audit --json | jq '.metadata.vulnerabilities'
# expected: {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
```

## Follow-ups

- Keep the `overrides` pin in place until `puppeteer` publishes a
  release whose lockfile resolves `ws >= 8.20.1` directly; Dependabot's
  minor-and-patch group will surface that.
- The `socket.dev` / `npm advisory` web checks performed today found no
  additional active campaign affecting this dependency graph. Re-run
  the same checks at every scheduled pen-test cadence.

## Change log

| Date | Change | Owner |
|---|---|---|
| 2026-05-19 | Added `overrides.ws >= 8.20.1`; regenerated lockfile; `npm audit` clean. | Kevin Armstrong |
