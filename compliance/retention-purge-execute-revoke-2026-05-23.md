# Retention-purge EXECUTE revocation — 2026-05-23

**Finding ID:** WA-2026-05-23-01
**Severity:** High
**Type:** Broken Access Control (OWASP A01, CWE-269 / CWE-285)

## Background
Migration `20260515000000_retention_purge_jobs.sql` introduced three
SECURITY DEFINER retention-purge functions and granted EXECUTE on each
to the `authenticated` role, with a comment indicating the grant was
"for manual-trigger debugging."

## Risk
Each function performs an unscoped `DELETE FROM` against an underlying
table:

| Function | Target |
|---|---|
| `purge_expired_access_log()` | `public.access_log` rows older than 12 months |
| `purge_expired_grant_drafts()` | `public.grant_drafts` rows older than 12 months |
| `purge_expired_search_signal_events()` | `public.search_signal_events` rows older than 24 months |

Because the functions are `SECURITY DEFINER` and execute as their owner
(postgres), they bypass RLS. With the `authenticated` grant in place,
any logged-in attacker could call any of them via PostgREST RPC
(`POST /rest/v1/rpc/purge_expired_grant_drafts`) and force-delete data
for every tenant.

`grep -rn "purge_expired" src supabase/functions scripts` returns no
application callers, confirming the grant has no legitimate use.

## Remediation
`20260523120000_revoke_purge_expired_authenticated.sql` revokes EXECUTE
from `authenticated`, `anon`, and `PUBLIC`. The pg_cron schedules
defined in the original migration execute as their job owner
(postgres) and continue to run without change.

## Verification
After deploying:

```sql
SELECT
  proname,
  has_function_privilege('authenticated',
    'public.' || proname || '()', 'execute') AS auth_exec
FROM pg_proc
WHERE proname LIKE 'purge_expired_%';
```
All three rows must return `auth_exec = false`.

## Owner / Effort
Owner: @SpikeyCoder · Effort: S · Priority: P0
