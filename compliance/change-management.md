# Change Management Policy

**Last reviewed:** 2026-05-26
**Owner:** Kevin Armstrong (Armstrong HoldCo LLC)
**Scope:** This repository, its production deployment, and the Supabase /
GCP / Cloudflare project(s) that back it.

This document satisfies the AICPA SOC 2 Trust Services Criteria CC8.1
("the entity authorizes, designs, develops, configures, documents, tests,
approves, and implements changes to infrastructure, data, software, and
procedures to meet its objectives").

---

## 1. Change classification

| Class | Examples | Approval | Review window |
|-------|----------|----------|---------------|
| Standard | Content updates, scheduled-job artifacts (RSS cache, daily audit reports), CSP hash refresh produced by an automated workflow | Pre-approved by this policy; `github-actions[bot]` may push directly via the documented automation. | None. |
| Routine | Doc-only edit, copy change, dependency bump within the same minor version | One human reviewer approves the Pull Request. | Same day. |
| Significant | Schema migration, new route or endpoint, change to security headers (CSP, HSTS, Permissions-Policy), change to authentication / authorization, change to rate-limit policy, change to a Row Level Security (RLS) policy, change to an Edge Function or Worker, change to CI/CD pipeline | One human reviewer + a documented smoke test of the affected flow recorded in the PR body. | Documented in PR. |
| Emergency | Hot-fix for an active production incident | Single committer may merge with a message tagging the incident. A follow-up review PR MUST be opened within 72 hours. | Captured in `compliance/incident-response.md`. |

## 2. Code-review controls

All changes flow through GitHub Pull Requests against `main`. Direct
pushes by humans are blocked — see `compliance/branch-protection.md`.

Documented automation exceptions:
- Scheduled workflows (RSS sync, grant-history sync, daily audit) may
  push commits authored by `github-actions[bot]` directly to `main` using
  a token with the minimum scope required, because `GITHUB_TOKEN` cannot
  bypass required status checks (GH013). These commits are read-only with
  respect to security boundaries (cache files, generated artifacts).
- Emergency hot-fix path described above.

PR reviewers verify:
- The PR description names the affected user-visible behavior.
- CI checks pass.
- For Significant changes, a rollback plan is named in the PR body.
- For database changes, a versioned migration file is included so the
  schema change is captured in source control.

## 3. Build, test, deploy pipeline

- Continuous integration runs on every PR via the workflow defined in
  `.github/workflows/`. The PR is gated on these checks passing.
- Deployment is automated on push to `main` (Cloudflare Pages / Cloud
  Run / GitHub Pages / Supabase, depending on repository). The deploy
  pipeline is itself a versioned artifact under `.github/workflows/`
  and changes to it follow the Significant-change path above.
- Secrets are stored in GitHub Actions secrets (or Cloud Run / Supabase
  function secrets) and never inlined in source.

## 4. Rollback

- Hosted-asset platforms (Cloudflare Pages, GitHub Pages, Netlify):
  re-promote the previous deployment from the platform dashboard. RTO
  target: 15 minutes.
- Cloud Run: re-deploy a prior revision via `gcloud run services
  update-traffic --to-revisions=<prior>=100`.
- Supabase migrations: a paired `down.sql` is included in the PR for
  schema changes that are not strictly additive.
- Edge Functions: re-deploy the previous tagged release via
  `supabase functions deploy <name>` from the previous commit.

## 5. Separation of duties

Armstrong HoldCo LLC operates as a single-principal entity. Where SOC 2
expects two distinct individuals for change-author and change-approver,
this control is compensated for by:

- Mandatory AI code-review pass (Claude) before any Significant change
  is merged.
- Independent third-party penetration tests on a recurring cadence
  (see `compliance/risk-register.md` for the most recent run).
- Audit log retention per `compliance/audit-log-retention.md`.

## 6. Review cadence

This policy is reviewed annually, and on any organisational change
(staff addition, vendor change, regulatory event). The reviewer
updates the "Last reviewed" date at the top of this file.
