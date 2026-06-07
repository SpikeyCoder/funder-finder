# LLM Endpoint Per-IP Rate Limits — FM-2026-06-07-01

**Date:** 2026-06-07
**Finding ID:** FM-2026-06-07-01
**Severity:** Medium
**Status:** Closed in PR `sec/llm-endpoints-rate-limit`
**CWE:** CWE-770 (Allocation of Resources Without Limits or Throttling)
**OWASP:** A04:2021 — Insecure Design (resource/cost control omission)

## Background

The Armstrong HoldCo scheduled pen-test on 2026-06-07 surveyed each
Supabase Edge Function for the presence of (a) `authFromRequest` and
(b) `ipRateLimit`. The 2026-06-06 review marked the AI endpoints as
Ready under CC7, but did not enumerate per-endpoint rate-limit
coverage.

Five LLM-backed edge functions were found to forward user-supplied
payloads to Anthropic (Claude Haiku) or OpenAI without a per-IP rate
limit:

| Function | LLM | Existing controls | Gap |
|----------|-----|-------------------|-----|
| `project-assistant` | Anthropic | gateway JWT; deterministic fallback | No per-IP throttle |
| `suggest-peers` | Anthropic (LLM keyword expansion) | gateway JWT; rule-based fallback | No per-IP throttle |
| `match-funders` | Anthropic + OpenAI (peer suggestion + embeddings) | gateway JWT; wall-clock budget | No per-IP throttle |
| `fetch-grant-deadline` | Anthropic | gateway JWT; `safe_fetch` SSRF guard | No per-IP throttle |
| `backfill-funder-websites` | Anthropic | gateway JWT; batch_size clamp ≤ 50 | No per-IP throttle |

## Threat model

The Supabase gateway already requires a valid JWT, so unauthenticated
abuse is blocked. The residual risk is a **signed-in caller** (or one
in possession of any valid anon JWT issued to the SPA — which is
trivial to obtain) running these endpoints in a tight loop, fanning
out to Anthropic / OpenAI on every request. Each Claude Haiku call
costs real money; `backfill-funder-websites` makes up to 50 per call.

This is the same Denial-of-Wallet (DoW) failure mode the OWASP LLM
Top-10 catalogues as LLM04 (Model Denial of Service / unbounded
resource consumption). The cost ceiling without a rate limit is
effectively the daily Anthropic spend cap.

## Fix

Each endpoint now calls `_shared/rate_limit.ts::ipRateLimit` early in
the request handler (before JSON parsing or any LLM fan-out), with a
per-endpoint namespace so the buckets do not collide. Limits are
chosen well above any plausible legitimate SPA pattern:

| Function | Limit (per minute) | Rationale |
|----------|--------------------|-----------|
| `project-assistant` | 30 | Chat-style; one call per user turn. 30 leaves headroom for fast iteration. |
| `suggest-peers` | 20 | "Find peers" button click. SPA debounces to ≤ 1/sec. |
| `match-funders` | 10 | Heavy pipeline; one call per `/results` render. |
| `fetch-grant-deadline` | 10 | Per-funder deadline scrape. |
| `backfill-funder-websites` | 5 | Operator-triggered; batch_size up to 50. |

The limiter is process-local (per Edge isolate). That is intentional:
the goal is to make casual abuse trip a 429 immediately; a determined
attacker who can rotate IPs would still hit the Anthropic provider's
own quota long before driving cost. If precision tightens (e.g.
post-incident retrospective), move buckets to a shared Upstash/Redis
backend in `_shared/rate_limit.ts`; no callsite changes required.

## Verification

```bash
# Replay 35 requests within a 60-second window; the last 5 should
# return HTTP 429 with a Retry-After header.
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://<project>.functions.supabase.co/project-assistant \
    -H "Authorization: Bearer <user_jwt>" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"draft":{},"step":0}'
done
```

Expected: ≤ 30 × `200`, ≥ 5 × `429`.

## References

- OWASP LLM Top-10: LLM04 — Model Denial of Service
- CWE-770: Allocation of Resources Without Limits or Throttling
- Prior precedent in this repo: `share-link/index.ts`, `calendar-feed/index.ts`,
  `delete-account/index.ts`, `report-bug/index.ts` all already use `ipRateLimit`.
