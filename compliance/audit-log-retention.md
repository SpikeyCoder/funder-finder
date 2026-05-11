# Audit Log Retention Policy — fundermatch.org

**Owner:** Kevin Armstrong (kevinmarmstrong1990@gmail.com)
**Last reviewed:** 2026-05-11
**Review cadence:** Quarterly
**Applies to:** Armstrong HoldCo LLC / fundermatch.org (funder-finder)

## Purpose

Documents what audit and operational log data is collected across the
fundermatch.org stack, how long it is retained, who has access, and how
it is reviewed. Satisfies SOC 2 Trust Services Criterion **CC4
(Monitoring Activities)** and provides an audit trail for incident
response (see `compliance/incident-response.md`).

## Log sources, retention, and access

| Source                              | What it records                                                  | Retention            | Access                                |
|-------------------------------------|------------------------------------------------------------------|----------------------|---------------------------------------|
| Vercel deployment logs              | Build + serve logs for the React app                             | 30 days              | Vercel project owner                  |
| Supabase Auth logs                  | Sign-in events, password resets, OTP issues                      | 7 days (free tier)   | Supabase dashboard owner              |
| Supabase Postgres logs              | Query errors, RLS denials                                        | 7 days (free tier)   | Supabase dashboard owner              |
| Supabase Edge Function logs         | All 27 functions — execution, errors, JWT verification failures  | 7 days (free tier)   | Supabase dashboard owner              |
| Supabase Storage logs               | bug-screenshots bucket reads/writes                              | 7 days (free tier)   | Supabase dashboard owner              |
| Trello webhook (report-bug destination) | Created cards + attachments                                  | Indefinite (Trello)  | Trello workspace owner                |
| GoatCounter analytics               | Anonymised pageviews                                             | Indefinite           | GoatCounter dashboard owner           |
| GitHub audit log                    | Repo access, branch-protection changes, secret-scan              | 90 days              | GitHub account owner                  |
| Dependabot security advisories      | Vulnerability alerts                                             | Indefinite           | Repo security tab                     |
| Anthropic / OpenAI / Tavily API logs | API request metadata at provider                                 | Provider-default     | Per-provider dashboard owner          |

Retention is bounded by the **most-restrictive** of provider-tier limits
and this policy. Where a provider retains data longer than required, the
policy does not extend retention — it only documents the practical floor.

## In-app Edge Function logging

Each migrated Edge Function emits structured `console.log` records at:

* **JWT verification failure** (`createUserScopedClient` HTTP-retry path
  exhausted, audience mismatch, anonymous-token rejection).
* **Rate-limit exceeded** (`_shared/rate_limit.ts` 429 hits on public
  token endpoints — `calendar-feed`, `share-link`).
* **Service-role boundary crossing** — when an Edge Function falls back
  to the admin auth API (currently: `team-invite` for
  `auth.admin.getUserById` and the paginated email lookup).
* **Screenshot validation rejection** (`report-bug` — invalid URL, host
  mismatch, traversal markers).
* **Anthropic / OpenAI / Tavily upstream errors** (status, error type,
  prompt token bound — never the prompt content itself).

PII handling: per `compliance/data-classification.md`, no end-user PII
is intentionally logged. Email addresses, full grant text, and 990
content are never emitted to logs.

## Long-term audit trail

For events that must outlive provider windows (incidents, access
reviews, configuration changes, vulnerability disclosures), the
canonical store is the relevant Markdown file under `compliance/`,
which lives in git and is retained for the life of the repository.

Specifically:

* **Access reviews** — `compliance/access-review-cadence.md`.
* **Security incidents** — `compliance/incident-response.md` plus a
  per-incident `SECURITY-INCIDENT-<date>.md` file at repo root once an
  incident is declared (see `SECURITY-INCIDENT-2026-05-06.md`).
* **Vendor changes** — `compliance/vendor-inventory.md`.
* **JWT audience-pinning rollout** — `compliance/jwt-audience-pinning.md`.
* **Edge function migration tracking** — `compliance/edge-function-migration-status.md`.
* **Pen-test reports** — `Armstrong_HoldCo_Pentest_Report_<date>.docx`
  in the shared kevinarmstrong.io repo, retained indefinitely.

## Review cadence

Once per quarter the owner:

1. Confirms Vercel + Supabase log retention is at the documented levels.
2. Reviews Supabase Auth logs for unexpected sign-in patterns (failed-
   OTP bursts, new geo regions).
3. Spot-checks Edge Function logs for unhandled JWT verification
   failures (signal of token-replay or audience-pinning gaps).
4. Reviews Dependabot alerts and the GitHub security tab.
5. Records the outcome in `compliance/access-review-cadence.md`.

## Incident retention extension

When an incident is declared, the owner downloads the relevant log
ranges from Vercel, Supabase, and Cloudflare to encrypted local storage
within 24 hours, since provider windows are short. The downloaded set is
held for the duration of the incident plus three years.

## References

* AICPA Trust Services Criteria 2017 (rev. 2022) — CC4.1, CC4.2
* NIST SP 800-53 Rev. 5 — AU-11 (Audit Record Retention)
* CIS Controls v8 — Control 8 (Audit Log Management)
