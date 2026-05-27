---
title: Supply chain — npm tmp path traversal override (FM-2026-05-27-02)
finding: FM-2026-05-27-02
tsc: CC9.2 (supply-chain risk), CC7.1
owner: Kevin Armstrong
opened: 2026-05-27
closed-in-pr: security/2026-05-27-npm-overrides-tmp
last-reviewed: 2026-05-27
---

# npm `tmp` path traversal — override

## Finding (pen-test 2026-05-27)

`npm audit --json` against `package.json` reports four high-severity
findings, all rooted in the same transitive dependency:

```
tmp <0.2.6  (path traversal via unsanitized prefix/postfix,
             GHSA-ph9p-34f9-6g65 / CWE-22)
  └─ selenium-webdriver
       └─ @axe-core/webdriverjs
            └─ @axe-core/cli  (devDependency)
```

`@axe-core/cli` is **dev-only** (we use it in CI for accessibility audits;
production runtime is the React bundle). The path-traversal sink is in
`tmp.dirSync({ prefix })` — never reached during normal `axe` use — but
`npm audit` correctly surfaces the vulnerable subgraph and the upstream
fix has not yet landed in `selenium-webdriver`'s declared range.

CWE-22 (Path Traversal). GHSA-ph9p-34f9-6g65.

## Remediation

Add an `overrides` entry pinning the transitive `tmp` resolution to
`>=0.2.6`. The new version is API-compatible with the 0.1.x/0.2.x range
`selenium-webdriver` pulls in, so the fix is invisible to the dependency
chain at runtime. `npm install` will now resolve the patched `tmp`
regardless of what `selenium-webdriver` declares.

Same approach we already use for `ws` (`>=8.20.1`).

## Verification

1. `rm -rf node_modules package-lock.json && npm install`
2. `npm ls tmp` resolves a single 0.2.6+ instance.
3. `npm audit --audit-level=high --json` reports `metadata.vulnerabilities.high == 0`.
4. CI `axe` accessibility audits still pass on `npm run eval:tune` (or
   whichever target depends on `@axe-core/cli`).

## Follow-up

When `selenium-webdriver` releases a version that declares `tmp >=0.2.6`
in its own `dependencies`, this override can be removed without behavioural
change. Tracked in `compliance/risk-register.md`.
