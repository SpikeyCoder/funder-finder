# LLM endpoint hardening phase 3 — FM-2026-06-11-01

**Date:** 2026-06-11
**Severity:** Medium (denial-of-wallet / CWE-770) plus low-severity origin-policy gap.
**Status:** Fixed in `sec/project-assistant-auth-cors-FM-2026-06-11-01`.

## Finding

### FM-2026-06-11-01 — `project-assistant` LLM endpoint missing auth + CORS allowlist

The `supabase/functions/project-assistant/index.ts` edge function was the one
LLM endpoint left out of the phase-1 (`llm-endpoint-rate-limit-2026-06-07.md`)
and phase-2 (`llm-endpoint-rate-limit-phase2-2026-06-10.md`) hardening rounds.

It carried an `Access-Control-Allow-Origin: '*'` constant CORS block and did
not call `authFromRequest` before forwarding the user message to
`https://api.anthropic.com/v1/messages` with the server's `ANTHROPIC_API_KEY`.
The existing 30/min/IP `ipRateLimit` (FM-2026-06-07-01) bounded the cost
ceiling per-IP, but did not stop unauthenticated callers from the open
internet from chaining the credit-burn behind a rotating-IP setup, nor did
it block cross-origin browsers from initiating the calls.

Affected asset: fundermatch.org edge function `project-assistant`
(POST /functions/v1/project-assistant).

### Evidence (pre-fix)

```ts
// project-assistant/index.ts, before this PR
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  // No authFromRequest call before the Claude Haiku fan-out.
  ...
  await fetch('https://api.anthropic.com/v1/messages', { ... });
```

By contrast, every other LLM-backed function (`ai-draft`, `grant-writer`,
`knowledge-base`, `lookup-funder-website`, `compute-peers`,
`get-funder-990-insights`) calls `authFromRequest()` from
`_shared/auth.ts` and uses `_shared/cors.ts`'s origin allowlist.

### Safe-reproduction sketch (no exploit code)

A reviewer would observe that an OPTIONS preflight from any origin
returns `Access-Control-Allow-Origin: *`, and that a POST without an
Authorization header still receives a Claude Haiku response. The fix
flips both: preflight returns an allowlisted origin string, and POST
returns 401 unless a real, non-anonymous, non-expired Supabase user
session JWT is present.

### Business impact

- Unbounded Anthropic credit burn (denial-of-wallet) by any internet caller.
- Anyone could embed the endpoint in a third-party page and use it as a
  free Claude Haiku proxy, exposing Armstrong HoldCo to API abuse and
  potential vendor TOS issues.
- Latent risk if `verify_jwt = true` were ever disabled on this function:
  no application-layer fallback existed.

### Confidence

High. The code path is unambiguous and matches the same pre-fix pattern
already remediated in PR #171.

## Remediation (this PR)

1. Replace the inline `CORS` constant with the shared
   `_shared/cors.ts` `corsHeaders(origin, { methods: 'POST, OPTIONS' })`
   helper, which restricts `Access-Control-Allow-Origin` to
   `https://fundermatch.org`, `https://www.fundermatch.org`, and
   `http://localhost:5173`.
2. Add `await authFromRequest(req)` immediately after the existing
   `ipRateLimit` call. Map thrown errors via `statusForAuthError` so a
   missing / malformed / expired / anonymous JWT returns 401 (instead of
   the previous 200 + Claude Haiku response).
3. Thread the `req` parameter through the inner `json()` helper so the
   correct origin header is emitted on every response (including
   non-2xx error paths).
4. Keep the existing 30/min/IP rate limit; defense-in-depth pattern is
   "auth + rate-limit + CORS allowlist", matching the rest of the
   FunderMatch edge function fleet.

## Verification

```bash
# 1. Anonymous call: expect 401
curl -i -X POST "$SUPABASE_URL/functions/v1/project-assistant" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"draft":{},"step":0}'

# 2. Off-origin preflight: expect Access-Control-Allow-Origin: https://fundermatch.org
curl -i -X OPTIONS "$SUPABASE_URL/functions/v1/project-assistant" \
  -H "Origin: https://evil.example.com"

# 3. Authenticated 31st call within 60s: expect 429 + Retry-After
for i in $(seq 1 31); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    "$SUPABASE_URL/functions/v1/project-assistant" \
    -H "Authorization: Bearer $USER_JWT" \
    -H "Origin: https://fundermatch.org" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"draft":{},"step":0}'
done
```

## References

- CWE-770: Allocation of Resources Without Limits or Throttling.
- OWASP API4:2023 — Unrestricted Resource Consumption.
- CWE-942: Permissive Cross-domain Policy.
- `compliance/llm-endpoint-rate-limit-phase2-2026-06-10.md` (phase 2,
  six other LLM endpoints).
- `_shared/cors.ts`, `_shared/auth.ts`, `_shared/rate_limit.ts`.
