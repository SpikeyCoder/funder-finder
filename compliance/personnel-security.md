# Personnel Security Policy

**Last reviewed:** 2026-05-26
**Owner:** Kevin Armstrong (Armstrong HoldCo LLC)

This document satisfies the AICPA SOC 2 Trust Services Criteria CC1.4
("the entity demonstrates a commitment to attract, develop, and retain
competent individuals") and CC1.5 ("the entity holds individuals
accountable for their internal control responsibilities").

## Scope

Armstrong HoldCo LLC currently operates as a single-principal entity
(Kevin Armstrong). This policy applies to that principal and to any
future employee, contractor, or vendor staff with access to the
production systems backing kevinarmstrong.io, fundermatch.org, or
website-auditor.io.

## 1. Background and reference checks

- The principal has self-attested to no disqualifying criminal history
  in any jurisdiction relevant to handling customer personal data.
- Any future hire with access to production secrets or PII must
  complete a documented background and reference check, retained for
  the duration of their tenure plus one year.

## 2. Confidentiality and acceptable use

- The principal has read and agreed to the SOC 2 acceptable-use
  expectations recorded below. Future personnel must sign an NDA and
  acceptable-use acknowledgement before access is granted.
- Production secrets (Supabase service-role key, Stripe live key,
  Cloudflare API tokens, GCP service account key, GitHub PAT,
  `WA_SHARED_SECRET`, `BOOKING_TOKEN_SECRET`, `SUPABASE_JWT_SECRET`)
  MUST NOT be copied to personal devices, chat logs, screenshots, or
  non-vetted third-party tools.
- Local laptops storing production credentials must have full-disk
  encryption enabled (FileVault / BitLocker / LUKS), an auto-lock
  timeout of 15 minutes or less, and OS-vendor security updates
  applied within 14 days of release.
- A password manager with master-password protection (or a hardware
  security key) is required for any account that holds production
  credentials.

## 3. Security awareness

- The principal completes a refresher on the OWASP Top 10, phishing
  recognition, secure code review, and supply-chain-attack hygiene at
  least annually. The most recent refresher date is recorded in the
  access-review log.
- The principal subscribes to Socket Security advisories, the GitHub
  Advisory Database, and the relevant vendor security mailing lists
  (Cloudflare, Supabase, Stripe).

## 4. Access provisioning and termination

- Access provisioning is recorded in `compliance/access-review.md`.
- Termination procedure (for any future personnel):
  1. Revoke GitHub organisation access and rotate any PAT they held.
  2. Rotate the Cloudflare API token used in their workflows.
  3. Rotate the GCP service-account key (if applicable).
  4. Rotate the Supabase service-role key.
  5. Rotate any environment shared secret they had visibility into
     (`BOOKING_TOKEN_SECRET`, `WA_SHARED_SECRET`, `CHAOS_TESTER_SECRET_KEY`,
     `SUPABASE_JWT_SECRET`, `TRELLO_TOKEN`, etc., as relevant).
  6. Revoke their Google Workspace / IdP identity if applicable.
  7. Record the rotation timestamps in `compliance/access-review.md`.

## 5. Disciplinary process

Any violation of this policy is documented in the access-review log
and, for future personnel, may result in immediate revocation of
access and termination of contract. Severity is judged by the
principal in consultation with legal counsel.

## 6. Review cadence

This policy is reviewed annually and on any organisational change.
