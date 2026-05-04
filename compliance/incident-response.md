---
title: Incident Response Runbook
tsc: CC4, CC7
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-04
---

# Incident Response — fundermatch.org

## Detection sources
- Supabase: Edge Function logs, Auth audit log, Postgres logs
- Anthropic / OpenAI: API key activity dashboards
- GitHub: secret-scanning + Dependabot security advisories
- External: kevinmarmstrong1990@gmail.com (per SECURITY.md)
- Browser-side: Sentry (planned — see risk-register R-04)

## Severity matrix
| Sev | Definition | Response time |
|---|---|---|
| SEV-1 | Active customer-impacting outage, confirmed PII or grant-application data exposure, active exploitation | < 1 hour |
| SEV-2 | Confirmed vulnerability without observed exploitation, partial outage | < 24 hours |
| SEV-3 | Misconfiguration, low-risk vulnerability, hygiene gap | < 7 days |

## Workflow
1. Acknowledge in writing within SLA.
2. Triage — confirm reproducibility, scope, severity.
3. Contain — disable the vulnerable code path (toggle Edge Function,
   tighten RLS policy, rotate API key, revoke OAuth client).
4. Eradicate — fix on `security/*` branch, merge to main, redeploy.
5. Recover — verify production healthy.
6. Notify — affected users / processors per privacy policy and law.
7. Postmortem — within 7 days for SEV-1/2 in `compliance/postmortems/`.

## Roles
- Incident Commander: Kevin Armstrong (single-owner org).

## Tabletop cadence
Annually + one unscheduled SEV-2 simulation per year. Outputs filed
under `compliance/postmortems/tabletop-YYYY-MM-DD.md`.
