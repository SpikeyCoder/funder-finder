---
title: Share-link public-by-token GET — per-IP rate limit
tsc: CC4, CC7
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-10
relates-to: supabase/functions/share-link/index.ts, supabase/functions/_shared/rate_limit.ts
---

# Share-link rate limit — defense-in-depth memo

## Background

`supabase/functions/share-link/index.ts` exposes a public, unauthenticated
`GET ?token=...` path so external collaborators can view a project tracker
without a FunderMatch account. The token is generated as
`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`
(two concatenated v4 UUIDs, ~256 bits of entropy), so online brute-force
of the token space is not the threat.

Pen-test 2026-05-08 finding **FM-2026-05-08-04** noted that the path
had no per-IP throttle, leaving two operational concerns:

1. **Token-replay flooding** — an attacker who obtains one valid token
   URL (forwarded email, browser history dump, etc.) can replay reads at
   line speed, wasting CPU and DB read units on the project's free-tier
   Supabase plan.
2. **No abuse signal** — without a 429 short-circuit, abuse looks
   identical to legitimate viewer traffic in the access log.

The 2026-05-09 report opened **FM-2026-05-09-01 / PR #62** which added
the same control to the parallel `calendar-feed` function and listed
"lift the helper to `_shared/`, apply to share-link" as a P1 30/60/90
roadmap item.

## Control implemented (2026-05-10, FM-2026-05-10-02 / PR #64)

A new shared helper `supabase/functions/_shared/rate_limit.ts` exposes
an `ipRateLimit(req, options)` function backed by an in-isolate
sliding-window bucket. Defaults are 60 requests / 60 seconds / IP,
matching the existing `log-search-signal` and `calendar-feed`
thresholds. Each consumer passes a `namespace` string so the buckets
remain segregated even though the underlying `Map` is shared.

Both `share-link` (public GET-by-token branch) and `calendar-feed` now
call the shared helper. The previous inline implementation in
`calendar-feed` was removed in the same PR.

## Threat model details

- **In-scope:** automated read flooding from a single IP (token
  replay, scraping by URL guessing, accidental client-side polling
  loops in third-party calendar clients).
- **Out-of-scope:** distributed brute-force of unknown tokens. Token
  entropy already makes this infeasible; a per-IP limit does not
  meaningfully change that calculus.
- **Fail-open behaviour:** when no client IP can be derived from
  `x-forwarded-for` / `x-real-ip` (unusual proxy chain), the request
  is allowed. The upstream guards (token entropy + RLS on the
  authenticated paths) still apply, so the failure mode is a brief
  loss of the *defense-in-depth* control rather than a security
  regression.
- **Multi-isolate behaviour:** Supabase Edge Functions run in many
  isolates per region, so the limit is enforced per-isolate.
  60 req/min/IP/isolate is sufficient for the abuse-signal role; if
  abuse exceeds this, the next iteration is to back the bucket with
  Upstash or another shared store.

## Verification

After deploy:

1. Send 70 GET requests with a known share token from the same IP
   within a minute. Requests 1–60 should return `200` with the link
   payload; requests 61–70 should return `429 Too Many Requests` with
   `Retry-After: 60`.
2. Inspect Edge Function logs for the corresponding 429 responses to
   confirm the bucket fires before the SELECT path.
3. Run the same test against `/calendar-feed?token=...` to confirm the
   refactored consumer still returns 429 after the threshold.

## References

- OWASP API Security Top 10 (2023) — API4:2023 Unrestricted Resource
  Consumption
- CWE-770 — Allocation of Resources Without Limits or Throttling
- Pen-test reports 2026-05-08 (FM-2026-05-08-04) and 2026-05-09
  (FM-2026-05-09-01)
