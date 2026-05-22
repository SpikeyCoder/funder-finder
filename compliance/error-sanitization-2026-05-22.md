---
title: Error-message sanitisation in Edge Functions
tsc: CC6.1, CC7.2
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-22
applies-to: fundermatch.org (SpikeyCoder/funder-finder)
finding-id: FM-2026-05-22-01
cwe: CWE-209
owasp: A09:2021 (Security Logging and Monitoring Failures)
---

# Error-message sanitisation in Edge Functions

## Why

Pen-test 2026-05-22 (finding **FM-2026-05-22-01**) flagged that
many FunderMatch Edge Functions returned `err.message` verbatim on
500 paths, leaking Supabase / Postgres / runtime error detail to
unauthenticated and authenticated clients. The risk is **CWE-209**
(Information Exposure Through an Error Message) — Postgres errors
can carry schema names, constraint names, column names, and the
`details:` / `hint:` fields. Internal runtime exceptions can leak
file paths and stack-trace fragments.

Auth-error 401 paths are intentionally preserved — the messages
they carry come from `authFromRequest` ("JWT expired", "Anonymous
tokens not accepted", etc.) and are already classified by
`statusForAuthError`. Those carry no schema information and help
the client debug their token.

## What

Added `sanitiseError(err, fallback)` to
`supabase/functions/_shared/errors.ts`. It:

1. Calls `console.error("[sanitised_error] …")` so the operator can
   still triage from the Supabase Function log.
2. Returns the fixed fallback string to the caller.

Replaced the 500-response leak sites in:

- `ai-draft/index.ts`
- `compliance/index.ts`
- `reports-portfolio/index.ts`
- `check-deadlines/index.ts`
- `process-notifications/index.ts`
- `send-reminders/index.ts`
- `share-link/index.ts`
- `compute-peers/index.ts`
- `get-funder-990-insights/index.ts`
- `get-recipient-profile/index.ts`
- `update-ntee-codes/index.ts`
- `generate-report/index.ts`
- `filter-funders/index.ts`

Where the file's error path classifies the status code (e.g.
`ai-draft`'s `statusForAuthError` flow), the 401 branch keeps the
helper message; only the 500 branch is sanitised.

Intentionally untouched:

- `knowledge-base/index.ts` / `onboarding/index.ts`: only return
  `err.message` on the 401 branch from `authFromRequest`.
- `process-notifications/index.ts` line 227 and
  `send-reminders/index.ts` line 66: internal per-record error
  accumulators (not part of the response body).
- `tracked-grants/index.ts` per-row CSV-import errors: visible only
  to the user who uploaded the CSV; needed for the upload UI to
  point at the offending row.
- `suggest-peers/index.ts` per-keyword `error.message`: internal
  result aggregator, not in the response body.

## Verification

For each Edge Function, induce a 500 (e.g. invalid project_id, or
trigger a unique-constraint violation) and confirm the response
body contains the generic fallback rather than a Postgres error
string. Then confirm the operator-facing detail is in
`supabase functions logs <fn-name> --tail`.

## References

- [CWE-209](https://cwe.mitre.org/data/definitions/209.html)
- [OWASP A09:2021 — Security Logging and Monitoring Failures](https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/)
