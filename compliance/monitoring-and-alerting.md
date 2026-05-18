---
title: Monitoring & Alerting Policy
tsc: CC4.1, CC4.2, CC7.1
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-17
finding: KA-2026-05-17-CC4
---

# Monitoring & Alerting — fundermatch.org

Armstrong HoldCo LLC operates a single monitoring program across its three
production sites (kevinarmstrong.io, website-auditor.io, fundermatch.org).
This is the fundermatch.org companion artifact; the controls below are
HoldCo-wide unless explicitly scoped to a specific site.

## 1. Uptime monitoring

An automated health-check scheduled task runs every 5 minutes and checks
all three production sites. Any non-200 response triggers an email alert
sent via Mailgun to `kevin@kevinarmstrong.io`. A recovery notification is
sent when the affected site returns to a healthy (200) state.

## 2. Edge function monitoring (fundermatch.org)

The Supabase dashboard provides edge function logs for fundermatch.org
with status codes, execution times, and error detail. Logs are retained
for 24 hours.

## 3. Application logs (website-auditor.io)

website-auditor.io runs on Google Cloud Run, which captures stdout/stderr
to Cloud Logging with 30-day retention.

## 4. Automated regression testing

A daily usability-audit scheduled task runs 250+ test cases across all
three sites. P0/P1 findings are auto-fixed; P2/P3 findings are filed as
owner-action items.

## 5. Security monitoring

A daily security-audit scheduled task performs a pen-test review, a
dependency audit, and a SOC 2 readiness assessment across all three sites.

## 6. Analytics

GoatCounter (privacy-respecting, no PII) is deployed on all three sites
for traffic and usage monitoring.

## 7. Alerting channels

| Channel | Trigger | Destination |
|---|---|---|
| Email (Mailgun) | Site returns non-200 on 5-min health check | `kevin@kevinarmstrong.io` |
| Email (Mailgun) | Site recovers to 200 | `kevin@kevinarmstrong.io` |
| Trello bug card | User-reported issue | HoldCo bug board |

## TSC mapping

| Control | TSC criterion |
|---|---|
| Uptime + recovery alerting, application/edge logging | CC4.1 (monitoring) |
| Daily regression + security audit, SOC 2 readiness review | CC4.2 (evaluation of controls) |
| 5-min health checks, log retention, operations alerting | CC7.1 (operations monitoring) |
