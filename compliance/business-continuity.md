---
title: Business Continuity & Disaster Recovery
tsc: A, CC9
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-04
---

# Business Continuity & DR — fundermatch.org

## Recovery objectives
| System | RTO | RPO |
|---|---|---|
| Static SPA | 1 hour (rebuild from main) | 0 (git is source of truth) |
| Supabase Postgres | 24 hours (PITR restore) | 5 min (Supabase Pro PITR) |
| Supabase Storage (uploads) | 24 hours | 24 hours (backed by S3 versioning) |
| Anthropic / OpenAI | n/a (degraded mode shows clear errors) | n/a |

## Backup test cadence
Supabase PITR restore is exercised every 6 months on a staging project;
outcome filed under `compliance/postmortems/dr-test-YYYY-MM-DD.md`.

## Failure scenarios
| Scenario | Detection | Recovery |
|---|---|---|
| Vercel outage | UptimeRobot alert | Failover via Netlify mirror or GitHub Pages fallback |
| Supabase outage | StatusGator alert | Show "data layer unavailable" banner; no data loss |
| Anthropic outage | grant-writer 5xx in logs | Disable AI feature flag; user can still draft manually |
| Google OAuth outage | Sign-in failures in logs | Magic-link fallback via Supabase Auth |
