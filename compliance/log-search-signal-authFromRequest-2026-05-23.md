# log-search-signal — use shared authFromRequest (2026-05-23)

**Finding ID:** WA-2026-05-23-11
**Severity:** Medium
**Type:** Identification & Authentication Failures (OWASP A07, CWE-345)

## Background
`supabase/functions/log-search-signal/index.ts` had its own
`parseAuthUserId()` that base64-decoded the JWT payload and returned
`sub` if `role === 'authenticated'` — no signature verification at all.
The decoded `userId` was then written to `search_signal_events.user_id`
via SERVICE_ROLE_KEY, which bypasses RLS.

Today the Supabase API gateway rejects unsigned JWTs at the edge, so
the function is not currently exploitable in production. But the
function's own auth path has zero defence-in-depth. Any future deploy
flag (`--no-verify-jwt`), reverse-proxy regression, or upstream
verification change would silently allow attackers to forge `sub` and
poison another user's training signal log.

## Fix
Replace the call to `parseAuthUserId(authorization)` with the shared
`authFromRequest(req)` from `_shared/auth.ts`, which:
- enforces the `Bearer` prefix and 3-segment JWT structure,
- HMAC-verifies HS256 tokens when `SUPABASE_JWT_SECRET` is set,
- correctly handles non-HS256 (asymmetric) tokens per the documented
  Supabase migration policy.

The existing `LOG_SEARCH_SIGNAL_ALLOW_ANON` / per-IP rate-limit
fallback is preserved by catching any thrown auth error and falling
through to the existing anonymous code path. `parseAuthUserId` is
marked deprecated but retained to avoid blast radius from removal.

## Verification
- With a valid Supabase session JWT → `userId` populated, event row
  written.
- With a forged JWT (good `header.role=authenticated`, bad signature)
  and `SUPABASE_JWT_SECRET` configured → request falls through to the
  anon path; `user_id` is null on the event row.
- With ALLOW_ANON unset and no token → 401.

Owner: @SpikeyCoder · Effort: S · Priority: P1
