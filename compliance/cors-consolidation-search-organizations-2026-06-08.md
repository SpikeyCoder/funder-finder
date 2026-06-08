---
title: search-organizations CORS migration to _shared/cors.ts
finding-id: FM-2026-06-06-03
tsc: CC6.1, CC6.6, CC8.1
date: 2026-06-08
owner: Kevin Armstrong
status: closed
---

# search-organizations CORS migration to `_shared/cors.ts`

## Finding

Pen-test 2026-06-06 finding **FM-2026-06-06-03** — Informational.

`supabase/functions/search-organizations/index.ts` carried its own
`ALLOWED_ORIGINS` `Set` and inline `corsHeaders()` implementation while
the other 32 edge functions used the centralized `_shared/cors.ts`
helper. The CORS allowlist therefore had two sources of truth, so a
future change (e.g. adding a staging origin) would need to be made in
two places, with a non-zero chance of drift.

## Resolution

PR replaces the inline allowlist / `corsHeaders()` definition with an
import of `corsHeaders` and `preflightResponse` from
`../_shared/cors.ts`. Behaviour is unchanged at the wire level:

- Same three allowed origins (fundermatch.org, www.fundermatch.org,
  localhost:5173).
- Same default-origin fallback when the request origin is not in the
  allowlist.
- Same `Access-Control-Allow-Headers` set.
- `Access-Control-Allow-Methods` is now explicitly emitted as
  `GET, POST, OPTIONS` (the inline implementation omitted this header
  on non-preflight responses; it is harmless to add).

## Verification

1. `grep -R "ALLOWED_ORIGINS" supabase/functions/` — only the
   centralised list in `_shared/cors.ts` remains.
2. Preflight (`OPTIONS`) and POST responses include
   `Access-Control-Allow-Origin: https://fundermatch.org` (or the
   matched origin) and `Vary: Origin`.
3. Frontend search-box flow continues to receive results from
   `search-organizations` without CORS errors in the browser console.

## References

- CWE-942 (Permissive Cross-domain Policy with Untrusted Domains) —
  centralising the allowlist reduces drift risk.
- OWASP API Security Top 10 — API8:2023 Security Misconfiguration.
- AICPA Trust Services Criteria CC6.1, CC6.6, CC8.1.
