---
title: Branch Protection — Documented Control State
tsc: CC5.1, CC5.2, CC8.1
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-19
applies-to: fundermatch.org (SpikeyCoder/funder-finder)
---

# Branch Protection — fundermatch.org (SpikeyCoder/funder-finder)

This document captures the *intended* GitHub branch-protection control set
for the `main` branch of the repository, the *as-found* state observed on
2026-05-19, and the remediation steps required to reach the intended
state.

It exists so an auditor can map AICPA TSC **CC5.1 / CC5.2** (control
activities are selected and developed) and **CC8.1** (change-management
authorisation and review) to a single concrete artefact rather than to a
prose paragraph in `SECURITY.md`.

The repo is a single-owner property (`@SpikeyCoder` is the only push
identity). The control posture below is calibrated to that reality: it
prevents accidental force-pushes / deletions and requires PR review of
changes (review is performed by Kevin Armstrong reading the diff in the
PR UI, sometimes after an automated review by Claude / Codex / a CI bot),
but it does NOT pretend a multi-developer separation-of-duties exists.

The control matches the equivalent documents at
`compliance/branch-protection.md` in `SpikeyCoder/my_website` and
`SpikeyCoder/chaos_tester` so all three Armstrong HoldCo LLC repos share
one control posture.

## Intended control state for `main`

| Control | Setting | Justification (TSC) |
|---|---|---|
| Require pull-request review before merging | **On**, minimum **1** approving review | CC5.1, CC8.1 |
| Dismiss stale reviews on new commits | **On** | CC8.1 |
| Require status checks to pass before merging | **On** (today: none configured; placeholder for a future `pr-validation.yml`) | CC8.1 |
| Require branches to be up to date before merging | **On** | CC8.1 |
| Require conversation resolution before merging | **On** | CC5.2 |
| Require linear history | **On** (merge commits OFF; squash-merge or rebase only) | CC8.1 |
| Allow force-pushes | **Off** | CC8.1, CC6.1 |
| Allow deletions | **Off** | CC6.1 |
| Require signed commits | **Off** (single-owner repo; SSH-key push identity is the integrity signal) | n/a |
| Restrict who can push | **Off** (no extra collaborators) | n/a |
| Enforce for administrators | **On** (the owner is the only admin; this is the binding constraint) | CC5.1 |

## As-found state on 2026-05-19

`GET /repos/SpikeyCoder/funder-finder/branches/main/protection` returns
`404 Branch not protected`. No branch-protection rule is currently
configured against `main`.

The repo *behaves* as if protection were on because the only push
identity (`@SpikeyCoder`) practices PR-only workflow:

- All recent merges to `main` arrive through pull requests (see e.g.
  PR #85 *security/2026-05-18-ci-lockfile-and-error-sanitization* and
  PR #87 *dependabot/npm_and_yarn/minor-and-patch-1d5c0afc6d*).
- `CODEOWNERS` requires the owner as reviewer on
  `.github/workflows/`, `scripts/`, and `supabase/functions/`
  (privileged surfaces).
- The Dependabot grouping (`.github/dependabot.yml`) channels minor /
  patch updates into a single weekly PR so they receive the same review
  treatment as any other change.

But behavioural compliance is not a configured control. An auditor
walking the change-management evidence will ask for the protection rule
itself; today there is nothing to point at.

## Remediation steps

These are GitHub-UI / API steps only — no code change is required.

1. Navigate to *Settings -> Branches -> Branch protection rules -> Add rule*.
2. Branch name pattern: `main`.
3. Enable the controls from the *Intended control state* table above.
4. Save. Verify with:

   ```
   curl -s -H "Authorization: Bearer $PAT" \
     https://api.github.com/repos/SpikeyCoder/funder-finder/branches/main/protection
   ```

   A 200 response (rather than 404) confirms the rule is live.
5. Update this file's `last-reviewed` date and the *As-found* section to
   reflect the new state.

## Verification cadence

- **Quarterly:** re-run the `curl` check above and update `last-reviewed`.
- **On every change** to the rule itself: append a row to the change log
  at the bottom of this file.

## Change log

| Date | Change | Owner |
|---|---|---|
| 2026-05-19 | Initial documented control state (parity with my_website / chaos_tester). | Kevin Armstrong |
