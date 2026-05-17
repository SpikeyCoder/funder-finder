---
title: Branch Protection & Code Review Policy
tsc: CC5.1, CC5.2, CC8.1
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-17
applies-to: fundermatch.org (SpikeyCoder/funder-finder)
finding-id: FM-2026-05-17-02
---

# Branch Protection & Code Review Policy — fundermatch.org

This policy is the formal artefact backing AICPA TSC **CC5.1 / CC5.2**
("the entity selects and develops control activities" / "the entity
deploys control activities through policies and procedures") and
**CC8.1** ("the entity authorizes, designs, develops or acquires,
configures, documents, tests, approves, and implements changes to
infrastructure, data, software, and procedures").

It exists so an auditor can map "change management is gated by review
and required checks" to a single concrete artefact — and so a future
repo administrator has the exact GitHub settings written down.

`kevinarmstrong.io/compliance/branch-protection.md` and
`chaos_tester/compliance/branch-protection.md` are the sister artefacts
for the other two Armstrong HoldCo LLC properties; this file is
deliberately structured the same way so a SOC 2 reviewer can side-by-side
the three sites.

## 1. Protected branch

- **Repository:** `SpikeyCoder/funder-finder`
- **Branch:** `main`
- **Production deployment trigger:** push to `main` →
  `.github/workflows/deploy.yml` runs `npm run build`, publishes
  `dist/` to GitHub Pages, and deploys the Supabase Edge Functions
  via `supabase functions deploy`.

## 2. Required GitHub branch-protection settings

| Setting | Value | Why |
|---|---|---|
| Require a pull request before merging | ON | No direct pushes to `main`; every change is reviewable |
| Required approvals | 1 | Single-owner repo; the owner is also CODEOWNERS for every path (see `.github/CODEOWNERS`) |
| Dismiss stale approvals on new commits | ON | New commits to a reviewed PR must be re-reviewed |
| Require review from Code Owners | ON | Enforces `.github/CODEOWNERS` on security-sensitive paths (`/supabase/functions/`, `/scripts/`, `/.github/workflows/`) |
| Require status checks to pass before merging | ON | CI must be green before merge |
| Required status checks | `build` (see `.github/workflows/deploy.yml`'s build job) | `tsc -b && vite build` blocks merges that break the TypeScript surface |
| Require branches to be up to date before merging | ON | Forces rebase/merge against latest `main` so CI runs against the post-merge tree |
| Require conversation resolution before merging | ON | No outstanding review comments at merge time |
| Require signed commits | OFF (recommended P2) | Single-owner; signed commits planned once a second maintainer joins |
| Require linear history | ON | Merge commits or rebase only; no merge-commit-on-merge-commit chains that complicate `git bisect` |
| Do not allow bypassing the above settings | ON | The repo administrator cannot push directly to `main` even in an emergency; emergency procedure documented below |
| Restrict who can push to matching branches | Empty (owner-only via PR) | No service accounts can push to `main` |
| Allow force pushes | OFF | `main` history is append-only |
| Allow deletions | OFF | `main` cannot be deleted |

## 3. Required status checks — current set

- `build` — runs on every PR (see `.github/workflows/deploy.yml`):
  - `npm ci` → `tsc -b` → `vite build`. A type error or build failure
    blocks merge.

Future status checks (P2):

- `npm audit --omit=dev --audit-level=high` once a clean baseline is
  established (CC7).
- `eval/eval-ranker.js` regression-gate once the eval harness has a
  stable accepted-error envelope (PI1).
- A `supabase functions test` smoke run against a staging project for
  the most security-critical functions (`auth.ts`, `share-link`,
  `calendar-feed`, `report-bug`). (CC8.1)

## 4. Code Owners — `.github/CODEOWNERS`

```text
*                              @SpikeyCoder
.github/workflows/             @SpikeyCoder
scripts/                       @SpikeyCoder
supabase/functions/            @SpikeyCoder
```

Adding any new owner requires a CC1 review (control environment) — the
new owner must (a) have MFA enforced on their GitHub account and (b) be
listed in the vendor inventory access-review (see
`compliance/access-review-cadence.md`).

## 5. Emergency-change procedure

If a SEV-1 incident (see `compliance/incident-response.md`) requires a
bypass:

1. Owner opens a "break-glass" PR titled
   `EMERGENCY: <short description> [break-glass]`.
2. CI still runs; if CI is failing because of the incident itself, the
   failing check is annotated in the PR body with the incident ticket.
3. The owner uses the documented escape hatch (administrator
   merge-without-requirements). When this option is disabled the
   alternative is to revert via a force-merge of a pre-approved hotfix
   branch.
4. Within 24 hours of the break-glass merge, the owner files a
   post-incident review entry in `compliance/risk-register.md` under
   "post-merge attestations" and updates this policy if a process gap
   contributed to the bypass.

The break-glass procedure has been used **0 times** since this policy
was first ratified.

## 6. Verification

Branch-protection settings are verified at the start of every quarterly
SOC 2 readiness review:

1. Visit
   `https://github.com/SpikeyCoder/funder-finder/settings/branches`.
2. Confirm the `main` rule matches §2 row-by-row.
3. Screenshot the settings page and attach to the quarterly review note
   in `compliance/access-review-cadence.md`.

Next scheduled verification: **2026-08-17** (90 days from
`last-reviewed`).

## 7. References

- AICPA Trust Services Criteria (2017, revised 2022) — CC5, CC8.
- GitHub Docs — *Managing a branch protection rule*.
- NIST SP 800-218 SSDF — PO.3.2, PW.7.1.
- OWASP SAMM — Implementation : Secure Build — Build Process.
- Sister policy: `kevinarmstrong.io/compliance/branch-protection.md`,
  `chaos_tester/compliance/branch-protection.md`.
