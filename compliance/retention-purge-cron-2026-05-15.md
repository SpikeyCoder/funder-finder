---
title: Retention Purge Cron Jobs
tsc: C1, P4
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-15
relates-to: supabase/migrations/20260515000000_retention_purge_jobs.sql
---

# Retention Purge Cron Jobs — fundermatch.org

## Background

`compliance/retention-and-deletion.md` documented a 12-month floor for
`access_log` (share-link view records) and `grant_drafts`, and a
24-month floor for `search_signal_events` (offline ranker-tuning
corpus). The deletion mechanism column read "Scheduled Postgres job
(planned)" for all three, but the job had never been scheduled. The
documented policy was therefore unenforced — rows would accumulate
indefinitely.

This is a SOC 2 **P4** (Privacy — retention and disposal) gap and a
**C1** (Confidentiality) gap. Auditors treat unenforced retention
floors as audit-blocking; from a privacy posture, holding identifiable
metadata (link ID, user-agent string) beyond the documented floor
weakens the data-minimisation argument that underlies the rest of the
privacy policy.

## Pen-test 2026-05-15 finding FM-2026-05-15-01

The retention table in `retention-and-deletion.md` lists three rows
with "Scheduled Postgres job (planned)". A `grep` across
`supabase/migrations/` confirms no migration referenced `access_log`,
`grant_drafts`, or `search_signal_events` in a DELETE statement, and
no pg_cron job other than `schedule-deadline-reminders` is registered.

## Control implemented

Migration `20260515000000_retention_purge_jobs.sql`:

1. Defines three `SECURITY DEFINER` functions, each with `search_path`
   pinned to `public` (consistent with
   `20260408153620_fix_function_search_path_mutable.sql`):
   - `public.purge_expired_access_log()` — `accessed_at < now() - interval '12 months'`
   - `public.purge_expired_grant_drafts()` — `updated_at < now() - interval '12 months'`
   - `public.purge_expired_search_signal_events()` — uses
     information_schema to detect `created_at` / `occurred_at` /
     `event_ts` (across historic schema variants); `<= 24 months`.
2. Schedules them via `pg_cron` at staggered 10:15 / 10:20 / 10:25 UTC
   slots (≈ 03:15 America/Los_Angeles). Pre-existing schedules with the
   same `jobname` are unscheduled first so the migration is idempotent.
3. Revokes `PUBLIC` execute, then grants execute only to the
   `authenticated` role for manual DSR-driven early purges. The
   service role can invoke directly.

Each function `RAISE LOG`s the row count so Supabase logs (Postgres
log → Supabase log explorer) show whether the job ran and how many
rows were affected — closing the CC4.1 monitoring loop on this control.

## Verification

After deploy:

1. `SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'purge-%';` — three rows, all active.
2. `SELECT public.purge_expired_access_log();` — returns 0 on a fresh
   database; returns N > 0 on a project that has held shared-link
   traffic for more than 12 months.
3. `SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'purge-%') ORDER BY start_time DESC LIMIT 6;` — confirms the next-day execution succeeded.
4. Repeat-run the migration; expect no errors (`unschedule-then-schedule` idempotency).

## References

- AICPA TSC **C1.1** (Confidentiality — identifies and protects
  confidential information) and **P4.2** (Privacy — disposes of
  personal information consistent with policies)
- ISO/IEC 27001 A.5.34 (Privacy and protection of PII)
- pg_cron documentation: https://github.com/citusdata/pg_cron
- Pen-test 2026-05-15 finding **FM-2026-05-15-01**
