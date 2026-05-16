---
title: Data Subject Access Request (DSAR) Runbook
tsc: P5.1, P5.2, C1.2
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-16
applies-to: fundermatch.org (SpikeyCoder/funder-finder)
finding-id: FM-2026-05-16-02
related: privacy-controls.md, retention-and-deletion.md
---

# Data Subject Access Request (DSAR) Runbook — fundermatch.org

This runbook is the formal expansion of the four-line "P5 Access" entry
in `compliance/privacy-controls.md`. It exists so an auditor can map
AICPA TSC **P5.1 / P5.2** ("provides individuals with access to their
personal information for review and update" / "communicates denial
within the maximum allowable time") to a single concrete artefact —
not a paragraph — and so the owner has a step-by-step procedure that
can be executed without re-deriving the data model under time pressure.

It also satisfies the equivalent GDPR Articles 15 (Right of Access),
16 (Right to Rectification), 17 (Right to Erasure), 18 (Right to
Restriction), 20 (Right to Data Portability), and 21 (Right to
Object) and CCPA §§1798.100, 1798.105, 1798.110 obligations.

## Scope

This runbook covers personal data held by **fundermatch.org** — the
Supabase Postgres + Storage + Edge-Function deployment. Data held by
third-party subprocessors (Supabase Auth, Stripe-via-referral,
Google OAuth, Anthropic, OpenAI, GoatCounter, Netlify) is addressed
separately in `vendor-inventory.md` — for those vendors the response
to a DSAR is a notice that they are the controller and a pointer to
their own DSAR endpoint.

## SLA

- Initial acknowledgement: **5 business days** from request receipt.
- Substantive response (data export / deletion confirmation / refusal):
  **30 calendar days** from receipt, per GDPR Art. 12(3).
- One **30-day extension** is permitted under GDPR Art. 12(3) for
  complex requests; the extension and its reason must be communicated
  to the requester within the original 30-day window.

## Contact

- **Primary**: `kevinmarmstrong1990@gmail.com` (also the address
  listed in `privacy-controls.md`, `SECURITY.md`, and `/privacy`).
- **Subject line convention**: `[DSAR] <type>` where `<type>` is one
  of `ACCESS`, `RECTIFICATION`, `ERASURE`, `PORTABILITY`, `OBJECTION`.

## Personal-data inventory

| Table / store | Class | Identifier column | Notes |
|---|---|---|---|
| `auth.users` | Account | `id` (UUID), `email` | Supabase Auth — owner can delete via Auth Admin API. |
| `profiles` | Account | `user_id` | App-level profile (display name, optional). |
| `tracked_grants` | App | `user_id` | Grants the user has bookmarked. |
| `pipeline_statuses` | App | `user_id` | User-defined pipeline stages. |
| `grant_drafts` | App | `user_id` | AI-generated grant drafts. |
| `grant_tasks` | App | `user_id` | User-created tasks against tracked grants. |
| `portfolio_items` | App | `user_id` | User's portfolio entries. |
| `access_log` | Telemetry | `user_id` (nullable) | 12-month retention; purged daily by `purge_expired_access_log()`. |
| `search_signal_events` | Telemetry | `user_id` (nullable) | 24-month retention; purged daily. |
| Supabase Storage `user-uploads/` | Document | path prefix `${user_id}/` | User-supplied reference docs. |

Cross-table joins use `user_id` as the canonical key; the `auth.users.id`
row is the single point of cascade for an ERASURE request.

## Procedure

### Step 0 — Triage (within 5 business days)

1. Confirm the message is a DSAR (the `[DSAR]` prefix is the trigger;
   plain "delete my account" requests count too).
2. Reply with the templated acknowledgement (Appendix A), the SLA, and
   a request for the identity-verification step.

### Step 1 — Identity verification

The requester must prove control of the account email. Acceptable
proofs (any one):

1. Reply to the acknowledgement from the address on file.
2. Pass a magic-link round-trip — open Supabase Auth Admin, issue a
   magic link to the email on file, confirm the requester clicked
   through (the `auth.sessions` row's `created_at` is the witness).
3. For a third-party request (e.g. legal counsel), a signed
   authorisation letter plus government-ID copy of the data subject.

Document the verification step in the response email and in
`compliance/dsar-log/YYYY-MM-DD-<short-uuid>.md` (Appendix B).

### Step 2 — Execute the request

Pick the path that matches the request type. Each path uses the
already-deployed Supabase functions and respects RLS — never use the
service-role key in a way that would bypass an audit trail.

#### ACCESS — produce a JSON export

```sql
-- Run in Supabase SQL editor, signed in as project admin.
-- $USER_ID is the auth.users.id from the verification step.
SELECT jsonb_build_object(
  'profile',           (SELECT row_to_json(p) FROM profiles p WHERE p.user_id = $USER_ID),
  'tracked_grants',    (SELECT jsonb_agg(t) FROM tracked_grants t WHERE t.user_id = $USER_ID),
  'pipeline_statuses', (SELECT jsonb_agg(s) FROM pipeline_statuses s WHERE s.user_id = $USER_ID),
  'grant_drafts',      (SELECT jsonb_agg(g) FROM grant_drafts g WHERE g.user_id = $USER_ID),
  'grant_tasks',       (SELECT jsonb_agg(t) FROM grant_tasks t WHERE t.user_id = $USER_ID),
  'portfolio_items',   (SELECT jsonb_agg(p) FROM portfolio_items p WHERE p.user_id = $USER_ID),
  'access_log_last90d',(SELECT jsonb_agg(a) FROM access_log a WHERE a.user_id = $USER_ID
                          AND a.created_at >= now() - interval '90 days'),
  'auth',              (SELECT jsonb_build_object('id', id, 'email', email, 'created_at', created_at,
                                                  'last_sign_in_at', last_sign_in_at)
                          FROM auth.users WHERE id = $USER_ID)
) AS export;
```

Storage objects are listed and presented as time-limited Supabase
signed URLs (24h TTL) in the response email; the requester downloads
the files directly from Storage so the data never transits a third-party
mailbox in plain form.

Deliverable: a single `dsar-access-<short-uuid>.json` file, sent as an
encrypted attachment (age / gpg / 1Password share link) to the email
on file. The plaintext is held only long enough to send.

#### RECTIFICATION

Update the row(s) via the SQL editor; capture the before/after diff
in the DSAR log entry. Confirm to the requester in writing.

#### ERASURE

```sql
-- One transaction so a partial delete cannot leave orphans.
BEGIN;
  DELETE FROM grant_tasks         WHERE user_id = $USER_ID;
  DELETE FROM grant_drafts        WHERE user_id = $USER_ID;
  DELETE FROM tracked_grants      WHERE user_id = $USER_ID;
  DELETE FROM pipeline_statuses   WHERE user_id = $USER_ID;
  DELETE FROM portfolio_items     WHERE user_id = $USER_ID;
  DELETE FROM profiles            WHERE user_id = $USER_ID;
  -- access_log and search_signal_events are purged by the scheduled
  -- pg_cron jobs (PR #75); set user_id = NULL here so the rows are
  -- pseudonymised immediately and the audit trail of the system event
  -- itself is preserved per CC4.1.
  UPDATE access_log           SET user_id = NULL WHERE user_id = $USER_ID;
  UPDATE search_signal_events SET user_id = NULL WHERE user_id = $USER_ID;
COMMIT;
```

Then call the Supabase Auth Admin API to delete the auth user
(`DELETE /auth/v1/admin/users/$USER_ID`). Storage objects under
`user-uploads/${user_id}/` are deleted with the Storage Admin API or
the Supabase dashboard.

Confirm to the requester in writing with the deletion timestamp and a
note that telemetry rows have been pseudonymised (user_id nulled).

#### PORTABILITY

Same data set as ACCESS; deliver as a structured JSON export. Add a
README naming the schema version (`compliance/data-classification.md`
checksum).

#### OBJECTION / RESTRICTION

Apply a `processing_restricted_at` timestamp to the `profiles` row;
the AI-grant-writer Edge Function checks this column and refuses to
operate on restricted accounts. Confirm to the requester.

### Step 3 — Close the loop

1. Final reply to the requester from the on-file address.
2. Log entry in `compliance/dsar-log/YYYY-MM-DD-<short-uuid>.md`
   (Appendix B template).
3. Calendar a 90-day follow-up to confirm no residual data has been
   recreated (e.g. by a stale cache, a reactivation, or a backup
   restore — backups follow the same retention floors).

## Denial / partial-grant

Reasons for refusal must be documented in the DSAR log and the response
email, and must cite a specific legal basis. The two recognised bases
for this site are:

1. **Manifestly unfounded or excessive** (GDPR Art. 12(5)(b)) — the
   requester has filed more than four identical requests in a 12-month
   window. Communicate the refusal within the SLA.
2. **Pending legal hold** — an active matter where the data is subject
   to a litigation hold. Communicate the existence of the hold and the
   expected duration.

## Backup-tier handling

PITR snapshots (Supabase Pro, 7-day window) and the offsite weekly
snapshot inherit the retention floors documented in
`retention-and-deletion.md`. An ERASURE request executed today is
honoured in the live database immediately; the PITR window will roll
the deleted row off within 7 days and the offsite snapshot within 90
days. The requester is informed of this in the final reply.

## Verification

- Run a self-DSAR every six months against a synthetic test user; file
  the output under `compliance/dsar-log/YYYY-MM-DD-selftest.md`.
- The 30-day SLA is tracked by the email-thread `created_at` timestamp;
  any breach is filed as an incident per `incident-response.md`.

## Appendix A — Acknowledgement template

> Subject: Re: [DSAR] <type> — acknowledged
>
> Hi <name>,
>
> Thanks — I have received your data subject request and am treating it
> as a `<type>` request under GDPR / CCPA. Before I can act on it I need
> to confirm your identity. Please reply to this thread from the email
> address on file (or, if you would prefer, I can send you a magic-link
> sign-in that confirms control of the account).
>
> The substantive response will follow within 30 calendar days of today
> (<date>). If the request is complex I may extend that window by a
> further 30 days, and I will let you know within the original window
> if so.
>
> Kevin Armstrong / Armstrong HoldCo LLC
> kevinmarmstrong1990@gmail.com

## Appendix B — Log-entry template

```
---
date: 2026-MM-DD
type: ACCESS | RECTIFICATION | ERASURE | PORTABILITY | OBJECTION
requester-id-method: email-on-file | magic-link | counsel-letter
user-id: <auth.users.id>
ack-sent-at: 2026-MM-DDThh:mm:ssZ
substantive-response-at: 2026-MM-DDThh:mm:ssZ
extension-used: yes | no
outcome: fulfilled | partial | denied
denial-basis: <if applicable>
backup-window-note: PITR rolls off by <date>; offsite snapshot by <date>
---

# Notes
- <free-form narrative of any complications>
```

## References

- AICPA TSC 2017 (with 2022 points of focus): P5.1, P5.2, C1.2
- GDPR Articles 12, 15, 16, 17, 18, 20, 21
- CCPA §§1798.100, 1798.105, 1798.110
- ICO Subject Access Right guidance
- `compliance/privacy-controls.md`
- `compliance/retention-and-deletion.md`
- `compliance/incident-response.md`
