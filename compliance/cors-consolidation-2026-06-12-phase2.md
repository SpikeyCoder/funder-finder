# CORS consolidation phase 2 — match-funders, grant-writer, suggest-peers

**Pen-test finding:** FM-2026-06-12-02 (Informational; carry-over follow-on
from the now-closed FM-2026-06-12-01).
**Date:** 2026-06-15
**Severity:** Informational (defense-in-depth / maintainability).
**CWE:** N/A — no exploitable misbehaviour. Drift risk only.

## What changed

Three additional edge functions that still inlined the
`ALLOWED_ORIGINS` set and a per-function `corsHeaders` definition were
migrated to import from `_shared/cors.ts`:

- `supabase/functions/match-funders/index.ts`
- `supabase/functions/grant-writer/index.ts`
- `supabase/functions/suggest-peers/index.ts`

Each function keeps a thin local `corsHeaders(requestOrigin)` wrapper
that delegates to `_sharedCorsHeaders(requestOrigin)` so the rest of
the file (which already has many call sites) does not need to change.
This is the same pattern already used by `get-recipient-profile`,
`log-search-signal`, `update-ntee-codes`, `get-funder-990-insights`,
and `compute-peers` after FM-2026-06-12-01.

## Why this matters

Functional behaviour is unchanged — the inline allowlist already
mirrored the canonical list in `_shared/cors.ts`. The risk closed by
this change is **drift**: if the canonical list later adds or removes
an origin (e.g. a new sandbox domain, or revoking
`http://localhost:5173` for production-only deploys), the inline copies
would silently fall out of sync, and the inconsistency would only
surface as confusing CORS errors in browsers hitting one function but
not another.

After this change, `_shared/cors.ts` is the single source of truth for
CORS allowlist policy across the FunderMatch edge function fleet.

## Verification

```
grep -rn 'ALLOWED_ORIGINS = new Set' supabase/functions/ | \
    grep -v _shared
# expected: no matches
```

## Out of scope

- The intentionally-public endpoints (`share-link` GET-by-token,
  `calendar-feed` .ics output, `report-bug`) continue to pass
  `{ allowAny: true }` to `_shared/cors.ts`. That is the documented
  exception and is unaffected by this migration.

## References

- OWASP A05:2021 — Security Misconfiguration (drift / inconsistent
  policy enforcement).
- Prior phase: `cors-consolidation-2026-06-12.md`
  (FM-2026-06-12-01) and `cors-consolidation-search-organizations-2026-06-08.md`
  (FM-2026-06-06-03).
