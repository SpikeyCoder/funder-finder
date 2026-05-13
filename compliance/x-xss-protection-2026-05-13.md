# X-XSS-Protection rollout — 2026-05-13

## Background

Pen-test 2026-05-13 finding **FM-2026-05-13-02**: the Netlify
`public/_headers` map ships HSTS, X-Frame-Options, COOP, CORP, and a
strict CSP, but does not include an explicit `X-XSS-Protection`
header.

Modern guidance from the OWASP Secure Headers Project recommends
shipping `X-XSS-Protection: 0` so that legacy Chromium / IE / Safari
versions disable their built-in heuristic XSS auditor — which over
the years has produced more bypass vectors and gadgets than it has
prevented. The strict CSP (`default-src 'none'` + per-origin
allow-listing + script-src hash pinning) is the live XSS defense.

This change makes the legacy auditor "off" explicit rather than
implicit and brings parity with the kevinarmstrong.io Worker and the
chaos_tester Flask app, both of which already ship
`X-XSS-Protection: 0`.

## Verification

1. Deploy via the standard Netlify pipeline.
2. `curl -sI https://fundermatch.org/` shows `x-xss-protection: 0`.
3. Existing CSP unchanged — XSS regressions still surface via CSP
   reports, not via the disabled legacy auditor.

## Reference

* OWASP Secure Headers Project — `X-XSS-Protection`
* MDN — `X-XSS-Protection: 0`
* CVE-2018-6149-class browser auditor bypasses
