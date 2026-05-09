---
title: calendar-feed public GET — defense-in-depth rate limit
tsc: CC6, CC7
owner: Kevin Armstrong
review-cadence: per-incident
last-reviewed: 2026-05-09
relates-to: supabase/functions/calendar-feed/index.ts
---

# Background

The `calendar-feed` Supabase Edge Function exposes a token-based public GET
that serves an `.ics` calendar feed for a user's tracked grants and tasks.
Because the path is unauthenticated (the token *is* the credential) we want
defense-in-depth abuse controls in addition to the high-entropy token check.

# Threat model

| Attacker capability | Mitigated by |
|---|---|
| Online brute-force of feed tokens | `gen_random_uuid()` token entropy (~122 bits) — practically infeasible |
| Token leak via shoulder-surf or logs | Token revocation via `calendar_feeds.is_active` flag (planned) |
| Token replay flooding (DDoS / harvest of feed contents) | **Per-IP sliding-window rate limit (this control)** — 60 req/min per IP |
| Server-side resource exhaustion via concurrent requests | Cloud Run autoscale + connection-pool ceiling |

# Control

Per-IP sliding-window bucket: 60 requests per IP per 60 seconds. Pattern
mirrors `log-search-signal/index.ts` (60/60s) so behavior is consistent
across our public-facing functions. On exceed, the function returns
`429 Too Many Requests` with `Retry-After: 60` before any database access.

The IP is taken from `x-forwarded-for` (Cloud Run trusts this header for
the client IP) and hashed with SHA-256 before use as the bucket key, so
the rate-limit map never contains plain-text IP addresses.

# Verification

After deploy, send 70 GET requests with a known feed token from the same
IP within a minute. Requests 1–60 should return 200 with the `.ics` body;
requests 61–70 should return `429 Too Many Requests` with `Retry-After`.

# References

- OWASP API Security Top 10 (2023) — API4:2023 Unrestricted Resource Consumption
- CWE-770 Allocation of Resources Without Limits or Throttling
