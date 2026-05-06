---
title: Security Incident — Leaked enrich-websites API keys
incident-id: FM-INC-2026-05-06-01
tsc: CC2, CC4, CC7
owner: Kevin Armstrong
status: monitoring
opened: 2026-05-06
---

# Security Incident FM-INC-2026-05-06-01 — Leaked `.env.enrich-websites` API keys

## Summary

The repository historically tracked `.env.enrich-websites` containing two
third-party API keys:

- `BRAVE_API_KEY`
- `GOOGLE_API_KEY`

The file was removed from the working tree in commit `42b907d` ("security:
remove exposed API keys from version control (FM-001)") and an explicit
entry was added to `.gitignore`. However, the file remains in the public
git history and the keys must be treated as compromised.

## Scope of exposure

- **Repository:** `SpikeyCoder/funder-finder` (public)
- **Original commit:** `64591d2` (added the file)
- **Removal commit:** `42b907d` (deleted from working tree)
- **History retention:** the original commit is still reachable via
  `git log -p -- .env.enrich-websites` from any clone. GitHub's mirror,
  forks, and any local clones taken before remediation also retain it.

## Required actions (rotation runbook)

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | Rotate `BRAVE_API_KEY` in the Brave Search dashboard; update Supabase secrets and any local `.env.enrich-websites` files | Kevin | TODO — confirm in writing |
| 2 | Rotate `GOOGLE_API_KEY`; tighten the new key's referrer + IP restrictions to the minimum required | Kevin | TODO — confirm in writing |
| 3 | Verify the old keys return `401 Unauthorized` against their respective APIs | Kevin | TODO |
| 4 | Audit the last 60 days of usage on both providers' dashboards for anomalous request volume or geo origin | Kevin | TODO |
| 5 | (Optional, destructive) Use `git filter-repo` or BFG to purge the file from history; force-push, then ask collaborators to re-clone | Kevin | Decline unless rotation is delayed |
| 6 | Confirm `.env.enrich-websites` is enumerated explicitly in `.gitignore` (it is, as of this branch) | Kevin | DONE |
| 7 | Add a pre-commit hook (e.g. `gitleaks`, `detect-secrets`) to block future secret commits | Kevin | Tracked as P1 follow-up |

## Containment posture

- **Forward exposure:** closed. `.env.enrich-websites` is in `.gitignore`,
  and a `.env.enrich-websites.example` template now lives next to it for
  onboarding.
- **Backward exposure:** open until rotation is confirmed. The destructive
  history-rewrite is a *contingent* mitigation — not required if rotation
  is verified and abuse is not observed.

## Detection

A pre-commit secret-scan tool is the long-term control. Until then, the
existing GitHub secret-scanning alerts on the public repo should surface
any future leaks of well-known token formats (Google API keys included).

## Trust Services Criteria touched

- **CC2 (Communication & Information):** incident is documented and the
  disposition is auditable.
- **CC4 (Monitoring Activities):** rotation verification step explicitly
  requires checking provider dashboards for anomalous usage.
- **CC7 (System Operations / Vulnerability management):** rotation runbook
  is the response to a vulnerability-management event.

## References

- CWE-798 — Use of Hard-coded Credentials (informational; the file held a
  static credential that ended up in version control).
- CWE-540 — Inclusion of Sensitive Information in Source Code.
- OWASP ASVS V14.3.2 — Secrets management: developer credentials are not
  stored in source control.
