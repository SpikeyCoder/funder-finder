---
title: Edge Function JWT verification — audience pinning + anonymous-token rejection
tsc: CC6, CC7
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-10
relates-to: supabase/functions/_shared/user-client.ts
---

# Edge Function JWT verification — audience pinning

## Background

`supabase/functions/_shared/user-client.ts` verifies the caller's JWT
by calling `supabase.auth.getUser(token)` against `/auth/v1/user`, with
a small retry loop to absorb the transient gateway failures that
previously surfaced as "JWT verification failed: Unexpected token '<',
'<html>...' is not valid JSON" on the Tracker tab. Keeping the auth
service as the source of truth means password resets, bans, and
JWT-secret rotations take effect immediately, rather than on token
expiry.

Before this PR, the verifier checked only that `getUser` returned a
non-error response with a `user` object — it did not inspect the
`aud` (audience) or `is_anonymous` fields on that user. The Supabase
authentication docs explicitly recommend pinning `aud === "authenticated"`
when verifying tokens (https://supabase.com/docs/guides/auth/jwts).

## Threat model — pen-test 2026-05-10 finding FM-2026-05-10-01

Without an `aud` check, the user-scoped client accepts:

1. **Anonymous-auth JWTs** — Supabase Anonymous Sign-Ins (GA 2024) mint
   tokens with `aud: "authenticated"` and `is_anonymous: true`. Today
   the project does not enable anonymous auth, so the practical risk
   is **low**. If the setting is ever enabled (intentionally for a
   future "try it without signing up" flow, or accidentally during
   project re-creation), every Edge Function migrated to
   `createUserScopedClient` would silently accept anonymous tokens as
   if they were full users — bypassing the implicit assumption that
   `user.id` corresponds to a vetted email/Google identity.
2. **Service-role JWTs** — Supabase mints service-role tokens with
   `aud: "service_role"`. A browser-side mistake that exposed the
   service-role key (e.g. accidentally bundling it via Vite env) would
   then be accepted by the Edge Function as a "valid user". The
   service-role key is currently held only server-side, but defense-
   in-depth requires us to reject the audience explicitly.
3. **Cross-environment token reuse** — if `SUPABASE_JWT_SECRET` is ever
   shared across environments (rare but possible during preview
   deploys), an attacker holding a token for one environment cannot
   replay it against another with a tightened audience check.

## Control implemented (PR #65)

After `supabase.auth.getUser(token)` returns successfully,
`createUserScopedClient` (and `extractAndVerifyJWT`) now call
`enforceAudienceAndIdentity`, which:

- requires `user.aud === "authenticated"` (`EXPECTED_AUDIENCE` constant
  is module-scoped so future callers can re-import it if needed); and
- rejects `user.is_anonymous === true`.

Both checks run on the user object returned by the Supabase Auth
service, so they reflect the canonical claims the auth service itself
attaches to the token. Failure modes:

| Token type | Behaviour before | Behaviour after |
|---|---|---|
| Normal user (signed-in via Google/email) | Accepted | Accepted (unchanged) |
| Service-role JWT | Accepted as user | **401** with "unexpected audience service_role" |
| Anonymous-auth JWT | Accepted as user | **401** with "anonymous tokens not accepted" |
| Token with no `aud` claim | Accepted as user | **401** with "unexpected audience undefined" |
| Expired / wrong signature | 401 | 401 (unchanged — surfaced by `getUser`) |

## Verification

After deploy:

1. Sign in normally and confirm Tracker / Dashboard / Projects continue
   to load. (Regression check: the retry loop must keep absorbing the
   transient HTML/5xx responses from `/auth/v1/user` so the original
   "Unexpected token '<'" error stays gone.)
2. Mint a service-role JWT in Supabase Studio, copy it into an
   `Authorization: Bearer ...` header, and confirm any user-scoped
   Edge Function returns **401** with body containing
   "unexpected audience service_role".
3. (Optional) If anonymous auth is ever enabled at the project level,
   `signInAnonymously()` followed by an Edge Function call should
   return **401** with "anonymous tokens not accepted" until the
   function is explicitly opted in.

## References

- Supabase Auth Docs — JWT verification:
  https://supabase.com/docs/guides/auth/jwts
- OWASP API Security Top 10 (2023) — API2:2023 Broken Authentication
- CWE-345 — Insufficient Verification of Data Authenticity
- Pen-test 2026-05-10 finding **FM-2026-05-10-01**
