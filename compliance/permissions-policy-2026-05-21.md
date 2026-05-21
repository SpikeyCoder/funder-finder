---
title: Permissions-Policy expansion (2026-05-21)
tsc: CC6.1, CC7.1
owner: Kevin Armstrong
last-reviewed: 2026-05-21
finding: FM-2026-05-21-01
relates-to: public/_headers
---

# Permissions-Policy expansion — 2026-05-21

## Context

The 2026-05-21 authorized pen-test flagged that `public/_headers` denied
only four legacy features (`camera`, `microphone`, `geolocation`,
`interest-cohort`). Modern powerful surfaces (Topics API, Attribution
Reporting, idle detection, WebUSB, WebSerial, Web Bluetooth, Payment
Request, WebAuthn passkey assertion, Gamepad, WebXR) were left at the
browser default.

## Change

`public/_headers` now emits a 37-directive deny-list. The three features
the SPA actually uses keep `(self)`:

- `fullscreen=(self)` — embedded demo video
- `picture-in-picture=(self)` — embedded demo video
- `web-share=(self)` — share-link UI on mobile

Everything else is `()`.

The meta-tag CSP in `index.html` is unchanged (Netlify is the authoritative
header source for fundermatch.org; the meta tag is a defense-in-depth
mirror only).

## Verification

After Netlify deploy:

```
curl -I https://fundermatch.org/ | grep -i permissions-policy
```

should return the expanded header. Re-run Mozilla Observatory.

## References

- OWASP Secure Headers Project — Permissions-Policy
- W3C *Permissions Policy* spec
