# LLM endpoint rate-limit phase 2 — FM-2026-06-10-02, FM-2026-06-10-03

**Date:** 2026-06-10
**Severity:** Medium-High (lookup-funder-website unauth), Medium (others)
**Status:** Fixed in `sec/llm-endpoints-auth-and-rate-limit-phase2`

## Findings

### FM-2026-06-10-02 — `lookup-funder-website` had no app-layer auth check
- Docstring claimed "this function handles its own lightweight auth check" but the handler contained no `authFromRequest`, no header parsing, and no rate limit.
- The function uses `SUPABASE_SERVICE_ROLE_KEY` to PATCH `funders.website` and `website_last_checked`, and fans out to Claude Haiku via `https://api.anthropic.com/v1/messages` with the `web_search` beta enabled.
- If deployed with `--no-verify-jwt`, the function was open to anyone on the internet. Even with `verify_jwt = true`, no rate limit existed.
- The compliance index `llm-endpoint-rate-limit-2026-06-07.md` did not list this endpoint.
- Also: the handler called `lookupWebsite(name, city, state, ein)` with an undefined `ein` identifier — should be `funderEin`. Fixed in the same patch (correctness, not security).

### FM-2026-06-10-03 — Three additional LLM/embedding endpoints had no per-IP rate limit
- `grant-writer` (Claude streaming) — 10/min
- `ai-draft` (OpenAI chat completions) — 10/min
- `knowledge-base` (OpenAI embeddings for new docs) — 30/min

### FM-2026-06-10-05 — Compute / 990 insights endpoints had no per-IP rate limit
- `compute-peers` (ProPublica fan-out + DB load) — 30/min
- `get-funder-990-insights` (DB load) — 30/min

## Fix

- `lookup-funder-website/index.ts` — added `authFromRequest` (rejects anonymous tokens) and `ipRateLimit` (10/min namespace `lookup-funder-website`); fixed the `ein` → `funderEin` bug; updated the docstring.
- Each of `grant-writer`, `ai-draft`, `knowledge-base`, `compute-peers`, `get-funder-990-insights` — added `ipRateLimit` call right after the OPTIONS preflight, with limits matching the LLM cost-ceiling pattern.

All limits use the shared `_shared/rate_limit.ts` Map-based sliding window (per-isolate; documented residual risk in the rate_limit module header).

## Verification

After deploy:

```bash
# Anonymous call: expect 401
curl -i -X POST "$SUPABASE_URL/functions/v1/lookup-funder-website" \
  -H "Content-Type: application/json" -d '{"funder_ein":"123456789"}'

# 11th authenticated call within 60s: expect 429 + Retry-After
for i in 1 2 3 4 5 6 7 8 9 10 11; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    "$SUPABASE_URL/functions/v1/lookup-funder-website" \
    -H "Authorization: Bearer $USER_JWT" \
    -H "Content-Type: application/json" \
    -d '{"funder_ein":"123456789"}'
done
```

## TSC closure

- CC6.1 (logical access — lookup-funder-website now requires auth)
- CC7.1 (system operations — DoW protection extended across all LLM endpoints)
- CC9.1 (risk mitigation — cost-ceiling controls aligned with documented threat model)

## References
- OWASP API4:2023 Unrestricted Resource Consumption
- CWE-770 Allocation of Resources Without Limits or Throttling
