---
title: SHA-pin third-party GitHub Actions (FM-2026-05-25-01)
tsc: CC7.1, CC9.1
owner: Kevin Armstrong
last-reviewed: 2026-05-25
---

# SHA-pin third-party GitHub Actions

## Pen-test finding (FM-2026-05-25-01, Low, CWE-829 / OWASP A08:2021)

`.github/workflows/deploy.yml` referenced `nwtgck/actions-netlify@v3`
(a third-party Marketplace Action) by **moving tag**. GitHub tags are
mutable: a compromised maintainer or a malicious force-push could
silently re-point `v3` at a different commit, and the next deploy
workflow run would execute attacker-controlled JavaScript with the
secrets exposed to that job (`NETLIFY_AUTH_TOKEN`,
`NETLIFY_SITE_ID`, and the `id-token: write` permission needed for
GitHub Pages deploys).

First-party `actions/*` actions are excluded from this finding —
GitHub Actions Marketplace policy prevents a force-push on the
official `actions/` org.

## Resolution (this PR)

- `nwtgck/actions-netlify@v3` → `nwtgck/actions-netlify@4cbaf4c…` with
  `# v3.0` as a trailing comment so the human-readable version stays
  visible in PR diffs.
- Inline comment recording the rationale (CWE-829 / OWASP A08:2021)
  so the next bump is intentional.

## Bump process

When `nwtgck/actions-netlify` cuts a new release:

1. Visit the
   [Releases page](https://github.com/nwtgck/actions-netlify/releases)
   and copy the **commit SHA** of the new release (not just the tag).
2. Verify with:
   ```sh
   curl -sSf https://api.github.com/repos/nwtgck/actions-netlify/git/refs/tags/<vX.Y> \
     | jq -r '.object.sha'
   ```
   …and follow the returned SHA to its commit if the tag is annotated.
3. Update the trailing comment to the new version.
4. Re-run the deploy workflow once to validate.

## Verification

- `gh workflow run deploy.yml` (or merge to `main`) completes without
  re-resolving the moving tag — the workflow log shows the exact SHA
  in the Action's resolution line.

## References

- OWASP A08:2021 (Software and Data Integrity Failures)
- CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)
- GitHub: [Using third-party actions](https://docs.github.com/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
- AICPA TSC CC7.1 (System Operations), CC9.1 (Risk Mitigation)
