# Error sanitisation — onboarding & knowledge-base — 2026-05-23

**Finding ID:** WA-2026-05-23-02
**Severity:** Medium
**Type:** Information Exposure Through Error Message (CWE-209, OWASP A04/A05)

## Background
FM-2026-05-22-01 introduced `_shared/errors.ts::sanitiseError()` and
the `share-link` / `ai-draft` / `report-bug` functions adopted it.
Two edge functions were missed:

- `supabase/functions/onboarding/index.ts`
- `supabase/functions/knowledge-base/index.ts`

Both wrapped their handler with `catch (err) { return { error: err.message }, 401; }`,
echoing the entire underlying error (supabase-js detail, Postgres
constraint names, runtime file paths) to the client and using a
misleading 401 status for non-auth failures.

## Remediation
Both functions now mirror the `share-link` pattern:

1. Compute `status = statusForAuthError(err.message)` — descriptive
   auth-class errors (`JWT expired`, `Anonymous tokens not accepted`,
   etc.) carry no schema information and are forwarded with a 401/403.
2. Anything else is logged server-side via `sanitiseError(err, ...)`
   and returned as a fixed `{"error":"Internal server error"}` with a
   500 status.

## Verification
Trigger a non-auth error (e.g. malformed JSON body):
```
curl -X POST -H "Authorization: Bearer $TOK" \
     -H 'Content-Type: application/json' --data 'not json' \
     "$SUPABASE_URL/functions/v1/onboarding"
```
Expect `{"error":"Internal server error"}` with status 500.

## Owner / Effort
Owner: @SpikeyCoder · Effort: S · Priority: P1
