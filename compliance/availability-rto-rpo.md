---
title: Availability — RTO / RPO targets (Armstrong HoldCo LLC)
tsc: A1.1, A1.2, A1.3
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-17
relates-to: compliance/business-continuity.md, compliance/disaster-recovery-plan.md, compliance/incident-response.md
finding: KA-2026-05-17-A1
---

# Availability — RTO / RPO targets

## Scope

This document is the HoldCo-wide artefact SOC 2 **A1 (Availability)**
expects: documented Recovery Time Objectives (RTO) and Recovery Point
Objectives (RPO) for every production system across the three Armstrong
HoldCo LLC properties, the backup strategy that makes those objectives
achievable, the escalation path, and the drill cadence that proves the
plan works.

It is the per-site refinement of the org-level
`compliance/business-continuity.md`. Where the two differ on a number,
**this document is authoritative** for the per-site availability targets;
`business-continuity.md` retains the broader scenario matrix. The
step-by-step recovery runbook lives in
`compliance/disaster-recovery-plan.md`.

Definitions:

- **RTO** — maximum tolerable time from outage detection to restored
  service.
- **RPO** — maximum tolerable data loss measured as a time window
  (how far back the last recoverable state may be).

## Sites covered

| Site | Stack | Hosting | Data store |
|---|---|---|---|
| kevinarmstrong.io | Static site | Cloudflare Pages | None (git is source of truth) |
| website-auditor.io | Flask app | Google Cloud Run | Supabase Postgres |
| fundermatch.org | React SPA | Cloudflare Pages | Supabase Postgres |

## Recovery objectives

| Site | RTO | RTO basis | RPO | RPO basis |
|---|---|---|---|---|
| kevinarmstrong.io | **15 minutes** | Redeploy from `main` to Cloudflare Pages | **0** | No user data; everything versioned in git |
| website-auditor.io | **30 minutes** | Redeploy container to Cloud Run + verify Supabase reachable | **24 hours** | Supabase automated daily backup |
| fundermatch.org | **30 minutes** | Redeploy SPA to Cloudflare Pages + verify Supabase reachable | **24 hours** | Supabase automated daily backup |

Rationale: none of the three properties carries a real-time
transactional workload. A worst-case 24-hour data-loss window on the
two Supabase-backed apps is an accepted residual risk given the daily
backup cadence and the low write volume; revisit if either app adds a
workload where a day of lost writes is materially harmful.

## Recovery procedures (summary)

Full step-by-step instructions, including exact commands, are in
`compliance/disaster-recovery-plan.md`. Summary:

1. **kevinarmstrong.io** — Trigger a fresh Cloudflare Pages deployment
   from the latest `main` commit (dashboard "Retry deployment", or push
   an empty commit). No data restore step. Verify with the
   post-recovery health checklist.
2. **website-auditor.io** — Redeploy the latest known-good container
   image to Cloud Run; confirm the service can reach Supabase; if the
   database is corrupt or lost, restore from the most recent Supabase
   backup before cutting traffic back.
3. **fundermatch.org** — Redeploy the SPA build from `main` to
   Cloudflare Pages; confirm Supabase reachable; restore Supabase from
   backup if the data store is compromised.

## Backup strategy

| System | Backup mechanism | Frequency | Retention | Restore tested |
|---|---|---|---|---|
| kevinarmstrong.io source | Git history on GitHub (`SpikeyCoder/my_website`) | Every commit | Full history | Every deploy is a de-facto restore |
| website-auditor.io source | Git history on GitHub (`SpikeyCoder/chaos_tester`) | Every commit | Full history | Every deploy |
| fundermatch.org source | Git history on GitHub (`SpikeyCoder/funder-finder`) | Every commit | Full history | Every deploy |
| website-auditor.io DB | Supabase automated daily backup | Daily | Per Supabase plan retention | Quarterly DR drill |
| fundermatch.org DB | Supabase automated daily backup | Daily | Per Supabase plan retention | Quarterly DR drill |
| Container images | Source-rebuildable from git + Dockerfile | On demand | n/a | Quarterly DR drill |

Notes:

- Git is the system of record for all three codebases; a repository
  loss is recoverable from any local clone or fork.
- Supabase backups are restored on a **separate Supabase project**
  during drills so production is never the test target.
- Secrets (API keys, service-role keys, booking-token secret) are
  **not** in git. Recovery of secrets is covered by the secret-rotation
  path in `compliance/incident-response.md`.

## Escalation contacts

| Role | Person | Contact | When |
|---|---|---|---|
| Incident Commander / primary | Kevin Armstrong | kevinmarmstrong1990@gmail.com | All availability incidents |
| Hosting — Cloudflare | Kevin Armstrong (account owner) | Cloudflare dashboard / account email | Pages or DNS outage |
| Hosting — Google Cloud Run | Kevin Armstrong (project owner) | GCP console / account email | Cloud Run outage |
| Data — Supabase | Kevin Armstrong (org owner) | Supabase dashboard / support | DB outage or restore needed |
| Registrar / DNS | Kevin Armstrong | Registrar account + 1Password recovery codes | Domain or DNS lockout |

Single-operator org: the Incident Commander, comms lead, and tech lead
are the same person, consistent with
`compliance/incident-response.md`. A designated contractor may act as
tech lead if the primary is unavailable beyond the RTO window.

## Quarterly drill schedule

A disaster-recovery drill is run **every quarter**. Each drill
exercises at least one Supabase restore and one full redeploy, rotating
the target site so all three are covered within a calendar year.

| Quarter | Window | Primary target | Secondary check |
|---|---|---|---|
| Q3 2026 | 2026-08-15 | website-auditor.io (Supabase restore + Cloud Run redeploy) | kevinarmstrong.io redeploy |
| Q4 2026 | 2026-11-15 | fundermatch.org (Supabase restore + Pages redeploy) | website-auditor.io redeploy |
| Q1 2027 | 2027-02-15 | kevinarmstrong.io (Pages redeploy from cold) | fundermatch.org Supabase restore |
| Q2 2027 | 2027-05-15 | website-auditor.io (full failover) | fundermatch.org redeploy |

Each drill's outcome — start/end time, measured RTO, measured RPO,
deviations, and corrective actions — is filed under
`compliance/postmortems/dr-test-YYYY-MM-DD.md` using the results
template in `compliance/disaster-recovery-plan.md`. A drill that misses
its RTO/RPO target is logged as a SEV-3 in
`compliance/incident-response.md` and tracked to closure in
`compliance/risk-register.md`.

## SOC 2 TSC mapping

- **A1.1 — Capacity / availability commitments.** RTO/RPO table above
  defines the availability commitments per system.
- **A1.2 — Recovery infrastructure & backups.** Backup strategy table;
  daily Supabase backups; git as source of truth.
- **A1.3 — Recovery testing.** Quarterly drill schedule and the
  results template in the DR plan.

## Change log

- 2026-05-17 — Initial version. Created to close the SOC 2 A1
  (Availability) gap across all three Armstrong HoldCo properties
  (finding KA-2026-05-17-A1).
