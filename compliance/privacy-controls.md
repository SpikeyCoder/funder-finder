---
title: Privacy Controls
tsc: P1, P2, P3, P4, P5
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-04
---

# Privacy Controls — fundermatch.org

## P1 Notice and communication
- Public privacy policy at `/privacy` (rendered from
  `src/pages/PrivacyPolicy.tsx`).
- Cookie / tracking disclosure: GoatCounter, no cookies, no PII.

## P2 Choice and consent
- Auth flow uses Google OAuth or magic link; consent screen identifies
  the data accessed.
- Marketing email opt-in is explicit; opt-out link in every email
  (planned — currently no marketing email is sent).

## P3 Collection
- PII collected: email (auth), display name (optional), uploaded
  reference documents (user-supplied, deletable).
- No payment data collected directly (handled by Stripe via referrals,
  not by FunderMatch itself).

## P4 Use, retention, and disposal
- See `retention-and-deletion.md`.

## P5 Access (data subject requests)
- DSR contact: `kevinmarmstrong1990@gmail.com`.
- SLA: 30 days, per GDPR Art. 12(3).
- Process: identity check → SQL export from Supabase → encrypted email
  to requester. For deletion, cascade-delete with verification email.
