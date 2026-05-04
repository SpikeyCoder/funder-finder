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
| Grant drafts (`ai-draft` outputs) | 12 months after last edit | Scheduled Postgres job (planned) |
| `search_signal_events` | 24 months (offline-tuning corpus) | Scheduled Postgres job (planned) |
| `access_log` (share-link views) | 12 months | Scheduled Postgres job (planned) |
| Uploaded reference docs | 24 months after last reference | Storage policy + Postgres job |
| Supabase logs / Vercel logs | 30 days (vendor default) | Automatic |

Data subject requests (access / correction / erasure) are handled by
emailing `kevinmarmstrong1990@gmail.com`; SLA is 30 days, in line with
GDPR Art. 12(3).
