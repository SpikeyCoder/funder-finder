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
| `organization_requests` ("request a missing organization") | `requester_email` cleared 30 days after the request is processed; a request still unprocessed after 30 days is closed (`failed`) and its email cleared; rows deleted after 180 days | `purge_expired_organization_requests()` via pg_cron (`purge-organization-requests`, daily 10:35 UTC) |
| `rate_limit_hits` (per-IP request counters) | 1 day after the counter's window started | `purge_expired_rate_limit_hits()` via pg_cron (`purge-rate-limit-hits`, daily 10:30 UTC) |
| `cron.job_run_details` rows for `prewarm-search-indexes` (runs every 5 minutes) | 30 days. A run that failed before it started (restart, no connection) has no timestamps and is aged by its run number instead. Other jobs' run history isn't purged here (the `purge-*` jobs' history is retention evidence); `monitor-sweep`'s is purged by `purge_monitoring()` (below). | `purge_prewarm_run_details()` via pg_cron (`purge-prewarm-run-details`, daily 10:40 UTC) |
| `monitor_crashes` (automatic browser crash reports: error text with numbers, ids, URLs and quoted values removed and email addresses masked (plain words stay, and so does a quoted single word, since it's usually a code name like 'map'; so app code that builds a name into an error message would store that name; the `[CRASH]` Trello card copies the message and stack frames and stays until triage archives it), stack frames, page path without ids or query string, browser user agent; no user id or IP) | 90 days after the crash was last seen | `purge_monitoring()` via pg_cron (`purge-monitoring`, daily 10:45 UTC) |
| `monitor_vitals` (page-speed measurements: metric, value, page path) | 30 days | `purge_monitoring()` (`purge-monitoring`, daily 10:45 UTC) |
| `monitor_sla_checks`, `monitor_alerts` (synthetic search checks; alert markers) | 30 days; 90 days | `purge_monitoring()` (`purge-monitoring`, daily 10:45 UTC), which also purges the `monitor-sweep` job's `cron.job_run_details` rows after 30 days |
| Uploaded reference docs | 24 months after last reference | Storage policy + Postgres job |
| Supabase logs / Vercel logs | 30 days (vendor default) | Automatic |

Three pg_cron jobs were scheduled by migration
`20260515000000_retention_purge_jobs.sql` (pen-test 2026-05-15 finding
**FM-2026-05-15-01**). The previous "planned" annotation in this table
was an unenforced policy floor — rows could accumulate indefinitely
until the migration shipped. Later migrations added more purge jobs
(all named `purge-*`). Verify scheduled state with:

```sql
SELECT jobname, schedule, command, active
FROM cron.job
WHERE jobname LIKE 'purge-%'
ORDER BY jobname;
```

Data subject requests (access / correction / erasure) are handled by
emailing `kevinmarmstrong1990@gmail.com`; SLA is 30 days, in line with
GDPR Art. 12(3).
