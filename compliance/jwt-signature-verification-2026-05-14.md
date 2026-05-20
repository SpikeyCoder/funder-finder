---
title: Edge Function JWT — local signature verification (defense in depth)
tsc: CC6.1, CC7.1
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-14
relates-to: supabase/functions/_shared/auth.ts
finding: FM-2026-05-14-01
---

# Edge Function JWT — local signature verification

## Background

`supabase/functions/_shared/auth.ts` previously decoded the caller's JWT
locally **without** verifying the HMAC signature. The rationale was that
the Supabase gateway already authenticates every request before it
reaches the function, so re-verifying would be redundant.

In practice, the gateway only verifies tokens for functions deployed
with the default `verify_jwt = true` setting. A function deployed with
`supabase functions deploy <name> --no-verify-jwt`, or a global
gateway misconfiguration, would silently disable the gateway check and
the decode-only path would accept any syntactically-valid JWT —
including one minted locally by an attacker with arbitrary `sub` and
`exp` claims.

## Threat model — pen-test 2026-05-14 finding FM-2026-05-14-01

| Attack | Pre-fix | Post-fix |
|---|---|---|
| Forge JWT with arbitrary `sub` when gateway disabled | ✗ accepted | ✓ rejected (signature) |
| Downgrade `alg` to `none` | ✗ accepted (alg ignored) | ✓ rejected (alg whitelist) |
| Replay valid JWT after `exp` | ✓ rejected (exp check) | ✓ rejected (exp check) |
| Anonymous sign-in JWT | ✓ rejected (is_anonymous) | ✓ rejected (is_anonymous) |

## Control

`authFromRequest()` now performs three checks in order:

1. **Algorithm whitelist** — `header.alg` must be `HS256`. Tokens
   asserting `alg: "none"` or any non-HS256 algorithm are rejected.
2. **HMAC signature verification** — when `SUPABASE_JWT_SECRET` is
   configured, the helper computes HMAC-SHA-256 over `header.payload`
   and `crypto.subtle.verify`s it against the third JWT segment.
   Failure raises `'JWT signature verification failed'`.
3. **Claim checks** — `is_anonymous`, `sub`, and `exp` are validated
   exactly as before.

When `SUPABASE_JWT_SECRET` is not configured (typically only in local
dev) the helper logs a one-time warning and falls back to decode-only
mode — so missing configuration is loud rather than silent.

## Operational notes

- `SUPABASE_JWT_SECRET` is the same secret used by the auth service
  to sign tokens. Set it as an Edge Function secret:
  `supabase secrets set SUPABASE_JWT_SECRET=$(cat <project secret>)`.
- The secret must be rotated alongside the project JWT secret rotation
  (Supabase dashboard → Project Settings → API → JWT Secret). Token
  rotation is documented in the standard incident-response runbook.
- `authFromRequest()` is now async; all four call sites
  (`portfolio`, `tracked-grants`, `pipeline-statuses`, `grant-tasks`)
  have been updated to `await` the call.

## SOC 2 TSC mapping

- **CC6.1 — Logical access security** — restricts function access to
  cryptographically-verified user tokens, independent of gateway
  configuration.
- **CC7.1 — System operations / vulnerability management** — closes
  the configuration-drift class of weakness highlighted by the
  2026-05-14 pen-test review.
