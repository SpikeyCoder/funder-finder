# Vendor Risk Management Policy

**Last reviewed:** 2026-05-26
**Owner:** Kevin Armstrong (Armstrong HoldCo LLC)

Companion to `compliance/vendor-inventory.md`. This document satisfies
the AICPA SOC 2 Trust Services Criteria CC9.2 ("the entity assesses
and manages risks associated with vendors and business partners").

## 1. Onboarding criteria

Before a new vendor is granted access to production data or
infrastructure, the principal verifies:

1. The vendor publishes a current SOC 2 Type II report (or ISO 27001,
   or equivalent) no older than 12 months.
2. The vendor's data-handling region is acceptable for any user PII
   the integration will touch.
3. A Data Processing Addendum (DPA) is on file when the vendor
   processes personal data.
4. Principle of least-privilege is applied to the credential issued
   to the vendor, and the rotation cadence is recorded in
   `compliance/vendor-inventory.md`.

## 2. Risk tiering

Each vendor in `vendor-inventory.md` is assigned a tier:

| Tier | Definition |
|------|------------|
| Critical | Loss of vendor causes site outage OR vendor processes payment / PII / authentication |
| Important | Loss of vendor degrades functionality but not core revenue / data flow |
| Informational | Read-only or marketing data source |

## 3. Annual review

Critical-tier vendors are reviewed annually:
- Re-verify SOC 2 / ISO report currency.
- Re-review the access scope of the vendor's API keys; tighten where
  possible.
- Rotate any long-lived secret.
- Verify the vendor has no unresolved critical advisories in the
  GitHub Advisory Database, OSV, or Socket Security feeds.

Important-tier vendors are reviewed every 18 months.

The annual review must be recorded with date and result in this file.

## 4. Off-boarding

When a vendor is removed:
1. Rotate any secret the vendor held.
2. Remove the vendor's API surface from the Content-Security-Policy
   `connect-src` / `form-action` directives.
3. Update `vendor-inventory.md` with the removal date and reason.

## 5. Incident handling

A vendor-reported security incident is treated as an incident under
`compliance/incident-response.md`. The principal evaluates whether
exposure of customer data is plausible and, if so, follows the data
breach notification timelines in that runbook.

## 6. Supply-chain monitoring

- `npm audit --omit=dev --audit-level=high` runs in the CI/CD
  workflow for any repository with a Node dependency tree.
- `pip-audit` is run against pinned Python dependencies on a monthly
  cadence and on any `requirements.txt` change.
- Socket Security advisories are reviewed weekly. Any advisory naming
  a package present in `package-lock.json` or `requirements.txt`
  triggers an immediate Significant-class change to pin or remove the
  affected version.

## 7. Review log

| Date       | Reviewer        | Notes |
|------------|-----------------|-------|
| 2026-05-26 | Kevin Armstrong | Initial policy adoption alongside vendor-inventory.md. |
