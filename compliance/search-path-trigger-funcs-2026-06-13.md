# FM-2026-06-13-01 — Pin `search_path` on trigger / seed functions

**Date:** 2026-06-13
**Severity:** Low (defense-in-depth)
**Status:** Fixed in `sec/search-path-pin-trigger-funcs-FM-2026-06-13-01`

## Finding

Supabase security advisor lint `0011` (`function_search_path_mutable`) flags
four SECURITY DEFINER functions declared in older migrations that ship
without an explicit `search_path`:

| Function | Origin migration | Role |
|---|---|---|
| `public.seed_pipeline_statuses(uuid)` | `20260315010000_create_pipeline_statuses.sql` | First-login seeder, called by trigger |
| `public.handle_new_user_pipeline()` | `20260315010000_create_pipeline_statuses.sql` | `auth.users` insert trigger |
| `public.handle_new_user_notifications()` | `20260315010005_create_notification_system.sql` | `auth.users` insert trigger |
| `public.record_grant_status_change()` | `20260315010002_create_grant_status_history.sql` | `tracked_grants` update trigger |

Because their `search_path` is implicit, a role that can create objects in
a schema earlier on the session `search_path` could shadow `pipeline_statuses`,
`notification_preferences`, `grant_status_history`, or `tracked_grants` with
a malicious view/function and influence what these functions write.

## Standards

- CWE-426 — Untrusted Search Path
- OWASP A05:2021 — Security Misconfiguration
- Supabase advisor lint 0011 — `function_search_path_mutable`

## Fix

Migration `20260614120000_pin_search_path_trigger_funcs.sql` pins
each function's `search_path` to `public, pg_temp` via
`ALTER FUNCTION ... SET search_path = public, pg_temp`.

Function bodies, SECURITY DEFINER status, and EXECUTE grants are unchanged.
This is defense-in-depth hardening only; it does not alter the access posture
that the scheduled-task brief lists as intentional for
`seed_pipeline_statuses`.

## Verification

```sql
SELECT proname, proconfig FROM pg_proc
 WHERE proname IN ('seed_pipeline_statuses', 'handle_new_user_pipeline',
                   'handle_new_user_notifications', 'record_grant_status_change');
-- Each row's proconfig should contain {search_path=public, pg_temp}.
```

## Precedent

Identical pattern landed in `chaos_tester` two days ago:
`98e7e7d sec(WA-2026-06-13-01): pin search_path on prune_old_reports trigger`.
