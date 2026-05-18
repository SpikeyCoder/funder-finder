---
title: Disaster Recovery Plan (Armstrong HoldCo LLC)
tsc: A1.2, A1.3, CC7.5
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-17
relates-to: compliance/availability-rto-rpo.md, compliance/business-continuity.md, compliance/incident-response.md
finding: KA-2026-05-17-A1
---

# Disaster Recovery Plan

## Scope

Step-by-step recovery runbook for the three Armstrong HoldCo LLC
properties. Targets (RTO/RPO) and escalation contacts are defined in
`compliance/availability-rto-rpo.md`; this document is the *how*. Use
it during a SEV-1/SEV-2 availability incident (see severity matrix in
`compliance/incident-response.md`).

Pre-flight for any recovery:

1. Confirm the outage is real (external monitor + manual check), not a
   local network problem.
2. Open an incident note (timestamp, symptom, suspected blast radius).
3. Pick the matching procedure below. Restore data **before** cutting
   user traffic back if the data store is suspect.

## 1. Restore from Supabase backup

Applies to **website-auditor.io** and **fundermatch.org**.

> Restore into a **new / staging Supabase project first** unless
> production data is confirmed lost. Never overwrite a production
> database that might still be partially intact until you have a
> verified good restore.

1. **Identify the recovery point.** Supabase dashboard → project →
   *Database* → *Backups*. Note the timestamp of the most recent daily
   backup. The gap between now and that timestamp is the realised RPO —
   record it.
2. **Choose restore target.**
   - Data confirmed lost/corrupt → restore in place (production
     project), accepting downtime.
   - Data possibly intact → restore the backup into a fresh project,
     validate, then decide on cutover.
3. **Trigger the restore.** Dashboard → *Backups* → select the chosen
   daily backup → *Restore*. Confirm the destination project. Wait for
   Supabase to report the restore complete.
4. **Validate the restored data.**
   - Row counts on the key tables look sane (not zero, not truncated).
   - A known recent record is present (spot-check the last item the
     app would have written before the outage).
   - Schema/migrations match the app version being deployed.
5. **Repoint the application.** Update the app's Supabase URL +
   anon/service-role keys (Cloud Run env vars for website-auditor.io;
   Pages env / build config for fundermatch.org) to the restored
   project if the project changed. If restored in place, no change.
6. **Record** the backup timestamp used and the measured RPO in the
   incident note / drill record.

## 2. Redeploy each site from git

Git is the source of truth for all three codebases.

### 2a. kevinarmstrong.io — Cloudflare Pages (static)

1. Confirm `main` on `SpikeyCoder/my_website` is the known-good
   commit. If a bad commit caused the outage, revert it on `main`
   first.
2. Cloudflare dashboard → *Workers & Pages* → the `kevinarmstrong.io`
   Pages project → *Deployments* → **Retry deployment** on the latest
   good build, **or** push an empty commit to `main`
   (`git commit --allow-empty -m "redeploy" && git push`) to trigger a
   fresh build.
3. Wait for the deployment to reach *Success*.
4. Run §3 health checks. Target RTO: 15 min.

### 2b. website-auditor.io — Google Cloud Run (Flask)

1. Confirm `main` on `SpikeyCoder/chaos_tester` is known-good.
2. Build and push the container (or redeploy the last known-good
   image revision):
   - Redeploy existing good revision: Cloud Run console → service →
     *Revisions* → route 100% traffic to the last healthy revision.
   - Rebuild from source: build the image from the repo Dockerfile and
     deploy a new Cloud Run revision.
3. Confirm Cloud Run env vars (Supabase URL + keys) point at a
   **healthy** Supabase project (post-restore project if §1 was run).
4. Wait for the revision to report *Serving* and pass its health
   check.
5. Run §3 health checks. Target RTO: 30 min.

### 2c. fundermatch.org — Cloudflare Pages (React SPA)

1. Confirm `main` on `SpikeyCoder/funder-finder` is known-good; revert
   a bad commit on `main` if that caused the outage.
2. Cloudflare dashboard → Pages project for `fundermatch.org` →
   *Deployments* → **Retry deployment** on the latest good build, or
   push an empty commit to `main` to trigger a rebuild.
3. Confirm the SPA's Supabase config (build-time env) points at a
   healthy Supabase project.
4. Wait for the deployment to reach *Success*.
5. Run §3 health checks. Target RTO: 30 min.

## 3. Verify service health post-recovery

Run for every site after recovery; all must pass before declaring the
incident resolved.

| Check | kevinarmstrong.io | website-auditor.io | fundermatch.org |
|---|---|---|---|
| HTTPS 200 on `/` | ✅ required | ✅ required | ✅ required |
| TLS cert valid + not expired | ✅ | ✅ | ✅ |
| Security headers present (CSP/HSTS) | ✅ | ✅ | ✅ |
| Core user path works | Home + blog render | A site audit run completes | Funder search returns results |
| Backend reachable | n/a | Supabase query succeeds | Supabase query succeeds |
| No 5xx in logs for 10 min | Cloudflare analytics | Cloud Run logs | Cloudflare analytics |
| External monitor green | UptimeRobot | UptimeRobot | UptimeRobot |

Generic commands:

```
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://<site>/
curl -sSI https://<site>/ | grep -iE "strict-transport-security|content-security-policy"
```

If any check fails, do **not** close the incident — return to the
relevant section. Only after all checks pass: update the incident
note with end time, realised RTO, realised RPO, and move to
post-incident review per `compliance/incident-response.md`.

## 4. Quarterly drill schedule

Drills run every quarter; the rotating schedule (which site is the
primary target each quarter) is maintained in
`compliance/availability-rto-rpo.md` under *Quarterly drill schedule*.
Each drill must exercise at least one Supabase restore (§1) and one
full redeploy (§2) against a **non-production** target, then run the §3
checks against the restored stack.

Drill steps:

1. Schedule a window; note expected RTO/RPO from
   `availability-rto-rpo.md`.
2. Execute §1 and/or §2 against a staging project / preview deployment.
3. Run §3 checks; record actual timings.
4. File results using the template below.
5. Any missed target → log SEV-3 in
   `compliance/incident-response.md`, add/raise the item in
   `compliance/risk-register.md`, assign a corrective action with a
   due date.

## 5. Drill results template

Copy to `compliance/postmortems/dr-test-YYYY-MM-DD.md` and fill in:

```
---
title: DR drill — <site> — YYYY-MM-DD
type: dr-drill
owner: Kevin Armstrong
date: YYYY-MM-DD
quarter: QX YYYY
---

# DR drill — <site> — YYYY-MM-DD

## Scope
- Target site:
- Procedures exercised: [ ] §1 Supabase restore  [ ] §2 redeploy
- Drill environment (staging/preview project):

## Objectives vs. actual
| Metric | Target | Actual | Pass? |
|---|---|---|---|
| RTO | <from availability-rto-rpo.md> | | |
| RPO | <from availability-rto-rpo.md> | | |

## Timeline
| Time | Event |
|---|---|
| | Drill start |
| | Restore/redeploy initiated |
| | Service serving |
| | §3 checks complete |
| | Drill end |

## §3 health checks
- [ ] HTTPS 200 on /
- [ ] TLS valid
- [ ] Security headers present
- [ ] Core user path works
- [ ] Backend reachable (if applicable)
- [ ] No 5xx for 10 min
- [ ] External monitor green

## Findings & deviations

## Corrective actions
| Action | Owner | Due | Tracking (risk-register ref) |
|---|---|---|---|

## Sign-off
- Run by: Kevin Armstrong
- Result: PASS / FAIL
```

## SOC 2 TSC mapping

- **A1.2 — Recovery & backup procedures.** §1 and §2 are the
  documented procedures.
- **A1.3 — Recovery testing.** §4 drill process + §5 results template.
- **CC7.5 — Recovery from incidents.** Pre-flight + §3 verification
  tie this plan to the incident-response workflow.

## Change log

- 2026-05-17 — Initial version. Created to close the SOC 2 A1
  (Availability) gap across all three Armstrong HoldCo properties
  (finding KA-2026-05-17-A1).
