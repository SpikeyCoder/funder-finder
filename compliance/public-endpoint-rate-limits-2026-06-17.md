---
title: Public endpoint rate limits + scheduler CRON_SECRET gate
date: 2026-06-17
owner: Kevin Armstrong / Armstrong HoldCo Security Agent
tsc: CC6.6, CC7.2, A1.2
status: implemented
pentest-finding: FM-2026-06-17-01 / -02 / -03 / -04 / -05
---

# Background

The 2026-06-17 scheduled pen-test review flagged five edge functions that
either (a) accept anonymous traffic without an IP rate limit, or (b) are
intended for `pg_cron`/scheduler use only but accept any caller that holds
the public anon JWT (which is embedded in the SPA bundle).

# Findings closed by this PR

| ID | Function | Class | Fix |
| --- | --- | --- | --- |
| FM-2026-06-17-01 | `search-organizations` | Missing per-IP rate limit on a public trigram-backed Postgres RPC | Added `ipRateLimit({ namespace: 'search-organizations', limit: 60 })` |
| FM-2026-06-17-02 | `get-recipient-profile` | Missing per-IP rate limit on a public endpoint that fans out to ProPublica 990 API | Added `ipRateLimit({ namespace: 'get-recipient-profile', limit: 30 })` |
| FM-2026-06-17-03 | `check-deadlines` | Scheduler-only function callable by any anon-JWT holder | Optional `CRON_SECRET` header gate (constant-time compare, backward-compatible) |
| FM-2026-06-17-04 | `process-notifications` | Same | Optional `CRON_SECRET` header gate |
| FM-2026-06-17-05 | `send-reminders` | Same | Optional `CRON_SECRET` header gate |

# CRON_SECRET enforcement model

- When `CRON_SECRET` is **unset** (e.g. local dev), the gate is a no-op
  and behaviour is unchanged.
- When `CRON_SECRET` is **set**, callers must present it via:
  - `X-Cron-Secret: <value>`, or
  - `Authorization: Bearer cron:<value>`.
- Comparison is constant-time-style to avoid leaking the secret length.

# Rollout plan

1. Merge the PR; existing scheduler invocations continue to work because
   `CRON_SECRET` is initially unset.
2. Add `CRON_SECRET` to the Supabase Function secrets (one shared value).
3. Update the `pg_cron` job definitions to forward the secret via the
   `Authorization: Bearer cron:<value>` header.
4. Confirm in `wrangler tail` / Supabase Logs that scheduled invocations
   continue to return 200.
5. Verify (manually) that an authenticated SPA session that calls one of
   the three cron endpoints directly now receives `403 forbidden`.

# Verification

- `curl -X POST <fn>` from the SPA-allowed origin returns 429 after 60
  rapid calls (search-organizations) / 30 rapid calls (get-recipient-profile).
- With `CRON_SECRET=test123` set, `curl -X POST <fn>` without the header
  returns 403; with `-H "X-Cron-Secret: test123"` returns 200.
- `Retry-After` and standard `X-RateLimit-*` headers are emitted by
  `_shared/rate_limit.ts` on 429.

# References

- OWASP API Security Top 10 2023 — API4:2023 Unrestricted Resource Consumption
- OWASP API Security Top 10 2023 — API8:2023 Security Misconfiguration
- CWE-770: Allocation of Resources Without Limits or Throttling
- CWE-799: Improper Control of Interaction Frequency
- NIST 800-53 r5: SC-5 (Denial of Service Protection), AC-3 (Access Enforcement)
- AICPA TSC CC6.6 (logical access controls over scheduled processes),
  CC7.2 (monitoring of abuse signals), A1.2 (availability protection).
