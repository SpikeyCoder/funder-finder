# CORS allowlist consolidation — FM-2026-06-12-01

**Date:** 2026-06-12
**Severity:** Informational (maintainability / drift risk).
**Status:** Fixed in `sec/cors-consolidation-FM-2026-06-12-01`.

## Background

Pen-test finding FM-2026-06-06-03 originally flagged that one edge
function (`search-organizations`) carried its own inline
`ALLOWED_ORIGINS` set plus a local `corsHeaders()` helper instead of
importing from `_shared/cors.ts`. That finding was closed by PR
`118ba6f` on 2026-06-08.

The scheduled 2026-06-12 review expanded the audit to every edge
function and identified five additional functions still carrying the
same inline pattern:

- `get-recipient-profile`
- `log-search-signal`
- `update-ntee-codes`
- `get-funder-990-insights`
- `compute-peers`

Functional behaviour was already correct — the inline allowlists
mirrored the canonical list. The risk is drift: a future change to
the canonical allowlist (e.g. adding a staging origin) would have to
be applied in five places, and a missed copy would silently leave a
function rejecting legitimate browser callers.

## Change

Replace the inline `ALLOWED_ORIGINS` Set and `corsHeaders()` function
in each affected file with:

```ts
import { corsHeaders } from '../_shared/cors.ts';
```

All call sites already use the symbol `corsHeaders(req.headers.get('origin'))`,
so no further changes are required at the use site.

## Verification

- `grep -rn "ALLOWED_ORIGINS = new Set" supabase/functions/` no longer
  matches in the five affected files. (Three larger LLM functions —
  `match-funders`, `grant-writer`, `suggest-peers` — are deferred to
  FM-2026-06-12-02; tracked Open.)
- `deno check supabase/functions/<each>/index.ts` (run locally before
  deploy) reports no type errors.
- Manual cross-origin curl against the deployed function from an
  allowlisted vs. non-allowlisted origin returns the expected
  `Access-Control-Allow-Origin` value.

## References

- OWASP API Security Top 10 — API8:2023 Security Misconfiguration
- CWE-942 — Permissive Cross-domain Policy with Untrusted Domains
- Prior finding: `compliance/pentest-2026-06-06.md` (FM-2026-06-06-03)
