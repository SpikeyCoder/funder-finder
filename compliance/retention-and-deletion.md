---
title: Data Retention & Deletion Policy
tsc: C1, P4
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-04
---

# Retention & Deletion — fundermatch.org

| Dataset | Retention | Deletion mechanism |
|---|---|---|
| `user_profiles` | While account active; 24 months after account deletion | DSR webhook → SQL cascade delete |
| `projects`, `tracked_grants` | While account active | Cascade-on-user-delete |
| `grant_drafts` (`ai-draft` outputs) | 12 months after last edit | `purge_expired_grant_drafts()` via pg_cron (`purge-grant-drafts`, daily 10:20 UTC) |
| `search_signal_events` | 24 months (offline-tuning corpus) | `purge_expired_search_signal_events()` via pg_cron (`purge-search-signal-events`, daily 10:25 UTC) |
| `access_log` (share-link views) | 12 months | `purge_expired_access_log()` via pg_cron (`purge-access-log`, daily 10:15 UTC) |
| Uploaded reference docs | 24 months after last reference | Storage policy + Postgres job |
| Supabase logs / Vercel logs | 30 days (vendor default) | Automatic |

Three pg_cron jobs were scheduled by migration
`20260515000000_retention_purge_jobs.sql` (pen-test 2026-05-15 finding
**FM-2026-05-15-01**). The previous "planned" annotation in this table
was an unenforced policy floor — rows could accumulate indefinitely
until the migration shipped. Verify scheduled state with:

```sql
SELECT jobname, schedule, command, active
FROM cron.job
WHERE jobname IN ('purge-access-log', 'purge-grant-drafts', 'purge-search-signal-events');
```

Data subject requests (access / correction / erasure) are handled by
emailing `kevinmarmstrong1990@gmail.com`; SLA is 30 days, in line with
GDPR Art. 12(3).
