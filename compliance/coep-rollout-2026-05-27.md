---
title: COEP credentialless rollout (FM-2026-05-27-01)
finding: FM-2026-05-27-01
tsc: CC6.6, CC7.1
owner: Kevin Armstrong
opened: 2026-05-27
closed-in-pr: security/2026-05-27-coep-credentialless-parity
last-reviewed: 2026-05-27
---

# Cross-Origin-Embedder-Policy rollout — fundermatch.org

## Finding (pen-test 2026-05-27)

The Netlify `public/_headers` config for fundermatch.org shipped
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Resource-Policy: same-origin` but did **not** include a
`Cross-Origin-Embedder-Policy` header. The other two Armstrong HoldCo
properties (kevinarmstrong.io, website-auditor.io) both ship
`COEP: credentialless` (KA-2026-05-13-02 and WA-2026-05-22-01).

Without COEP the HTML document does not enter a *cross-origin isolated
context*, so:

1. The cross-origin side-channel hardening that pairs with COOP is not
   fully active. Spectre-style attacks against shared-memory features
   (`SharedArrayBuffer`, high-resolution `performance.now()`) remain
   theoretically exploitable in pathological subresource-loading
   scenarios.
2. Accidental cross-origin subresource loading (e.g. a future copy-paste
   that adds an `<img>` from a third-party CDN without a CORP header)
   silently succeeds instead of surfacing as a visible failure.

CWE-1021 (Improper Restriction of Rendered UI Layers or Frames) /
OWASP Secure Headers Project — `Cross-Origin-Embedder-Policy`.

## Remediation

`public/_headers` now sends
`Cross-Origin-Embedder-Policy: credentialless` on every HTML response.

We pick `credentialless` rather than `require-corp` for the same reason
the other two sites do: the goatcounter analytics beacon
(`fundermatch.goatcounter.com`) does not currently advertise a CORP
header, and `require-corp` would block the beacon outright.
`credentialless` strips ambient cookies on the cross-origin hop instead,
which is the safer same-functionality posture today.

## Verification

1. Deploy the branch and curl the production root:
   `curl -sI https://fundermatch.org/ | grep -i cross-origin`
2. Expect three rows:
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: credentialless`
   - `Cross-Origin-Resource-Policy: same-origin`
3. Load the production site in Chrome, open DevTools → Application →
   Frames → top, and confirm "Cross-Origin Isolated" is **true**.
4. Smoke-test the goatcounter beacon: open Network tab, refresh, look
   for the `gc.zgo.at` request, confirm it returns 200/204 (the
   beacon does not need cookies and continues to work under
   `credentialless`).

## Future tightening

Once every cross-origin subresource (currently only the goatcounter
beacon) advertises a CORP header, this can be tightened to
`require-corp`. Tracked in `compliance/risk-register.md` as a low
remaining residual.
