---
title: Edge Function SERVICE_ROLE_KEY → User-Scoped Migration Status
tsc: CC6, CC8
owner: Kevin Armstrong
review-cadence: monthly
last-reviewed: 2026-05-08
relates-to: supabase/functions/_shared/user-client.ts, src/lib/supabase.ts
---

# Edge Function migration status — SERVICE_ROLE_KEY phase-out

This document tracks the Phase 4 migration that replaces direct
`SUPABASE_SERVICE_ROLE_KEY` usage in Edge Functions with the
user-scoped client factory in
`supabase/functions/_shared/user-client.ts`. It exists so a SOC 2
auditor can see which functions still hold the privileged key,
which have been migrated, and what the change-management plan is.

## Why

A leaked `SUPABASE_SERVICE_ROLE_KEY` bypasses every Row-Level
Security policy. The mitigating control is to remove the key from
any function that can run on behalf of an authenticated user —
those should mint a per-request client from the caller's JWT
instead. See risk-register entry **R-01**.

## Current state — 2026-05-08

| Function | Uses SERVICE_ROLE_KEY today | Migration plan |
|---|---|---|
| `ai-draft` | No (user-scoped) | ✅ Migrated |
| `match-funders` | Yes | RLS policies on `recipient_organizations` and `foundation_grants` are in place (migration `20260502151459_phase1_rls_foundation.sql`) — function eligible for Phase 4 cutover. |
| `compute-peers` | Yes | Public reference data only; eligible for Phase 4. |
| `update-ntee-codes` | Yes | Scheduled task — keep as service-role (no end-user request). |
| `process-notifications` | Yes | Scheduled task — keep as service-role. |
| `team-invite` | Yes | Cross-user write (insert into `invitations`) — keep as service-role with explicit RLS-bypass justification documented in function header. |
| `share-link` | Yes | Public-by-token GET path needs service-role for unauth reads; authenticated POST/DELETE paths can move to user-scoped. |
| `suggest-peers` | Yes | Eligible for Phase 4. |
| `check-deadlines` | Yes | Scheduled task — keep as service-role. |
| `calendar-feed` | Yes | Public-by-token (.ics) — keep service-role for token-scoped reads. |
| `send-reminders` | Yes | Scheduled task — keep as service-role. |
| `pipeline-statuses` | Yes | Eligible for Phase 4. |
| `filter-funders` | Yes | Eligible for Phase 4. |
| `grant-writer` | Yes | Eligible for Phase 4. |
| `log-search-signal` | Yes | Anonymous logging — keep service-role; rate-limited. |
| `get-funder-990-insights` | Yes | Eligible for Phase 4. |
| `report-bug` | N/A (Trello key only) | ✅ No service-role |

## Ownership and cadence

- Owner: Kevin Armstrong
- Cadence: review monthly until all "Eligible for Phase 4" rows are
  migrated; then move to quarterly.
- Definition of done: every function in the "Eligible" group either
  uses `createUserScopedClient` or has a documented justification in
  this table (alongside a corresponding RLS policy).

## Verification

For each function migrated, the PR description must include:

1. The `Authorization` header validation flow.
2. The RLS policies the function now relies on.
3. A test (or manual reproduction) confirming a request without a
   valid JWT is rejected with HTTP 401.

## References

- AICPA TSC: **CC6.1** Logical access — least privilege; **CC8.1** Change management.
- OWASP API Security Top 10 (2023): API2:2023 Broken Authentication, API5:2023 Broken Function Level Authorization.
- CWE-269: Improper Privilege Management.
