---
title: CSP Directive Parity — frame-src / worker-src / upgrade-insecure-requests
tsc: CC6.6, CC7.1
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-16
applies-to: fundermatch.org (SpikeyCoder/funder-finder)
finding-id: FM-2026-05-16-01
related: csp-hardening-2026-05-15.md (chaos_tester)
---

# CSP Directive Parity — fundermatch.org

## Background

CSP Level 3 §6.7 explicitly excludes `frame-src`, `worker-src`,
`manifest-src`, `form-action`, `base-uri`, and `object-src` from the
`default-src` fallback chain. A policy that lists only `default-src`
plus the most-common directives is *not* covered against those
exclusions by the spec.

The 2026-05-15 chaos_tester PR (#59) added the full carve-out set
(`object-src`, `base-uri`, `form-action`, `frame-src`, `manifest-src`,
`worker-src`, `upgrade-insecure-requests`) to website-auditor.io. The
2026-05-16 review found that fundermatch.org's Netlify `_headers` CSP
covered four of those six (`object-src`, `base-uri`, `form-action`,
`manifest-src`) but was silent on `frame-src`, `worker-src`, and
`upgrade-insecure-requests`. The three missing directives are
defense-in-depth: the SPA renders no iframes today, registers no
service workers, and only emits HTTPS subresource URLs, so none of the
gaps is individually exploitable. They should still be in place
against the next change.

## Change

`public/_headers` Content-Security-Policy gains:

- `frame-src 'none'` — blocks `<iframe>` and `<frame>` loads. Today
  the SPA renders none; if a Loom embed or Stripe Checkout iframe is
  added later, this is the single line to update.
- `worker-src 'self'` — restricts Service / Shared / Dedicated worker
  script sources to the same origin. Today the SPA registers no
  worker; if one is added (e.g. for offline grant-draft caching), it
  will load from `/`.
- `upgrade-insecure-requests` — silently upgrades any accidentally-
  authored `http://` subresource to `https://`, so a single
  copy-paste does not become a mixed-content downgrade.

## Verification

```bash
# 1. Header carries the new directives after Netlify deploy
curl -sI https://fundermatch.org/ | grep -i content-security-policy

# 2. DevTools → Console: zero CSP violations on a fresh navigation.
#    Verified statically: the SPA renders no iframes / workers and
#    uses only https:// subresources today.
```

## References

- W3C — Content Security Policy Level 3 §6.7
- OWASP Secure Headers Project
- AICPA TSC CC6.6, CC7.1
