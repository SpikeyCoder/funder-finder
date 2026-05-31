---
title: Risk Register
tsc: CC3.1, CC3.2, CC3.3, CC3.4
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-31
---

# Risk Register — fundermatch.org

## Overview

This document identifies, assesses, and tracks risks to fundermatch.org per AICPA TSC CC3 (Risk Assessment). Risks are scored on likelihood (1-5) and impact (1-5). Risks scoring 12+ require a mitigation plan.

## Risk Matrix

| ID | Risk | Category | L | I | Score | Mitigation | Status |
|----|------|----------|---|---|-------|------------|--------|
| R-01 | Supply chain compromise via npm/pip dependency | Security | 3 | 5 | 15 | Daily audit with Socket Security feed, npm audit, pip-audit; Dependabot; lockfile pinning | Active |
| R-02 | Unauthorized access to production secrets | Security | 2 | 5 | 10 | Secrets in GitHub Actions / cloud provider env vars (encrypted at rest); .env in .gitignore; branch protection on main | Active |
| R-03 | Service provider outage (Cloudflare Pages, Supabase, Anthropic, OpenAI) | Availability | 3 | 4 | 12 | Health monitor every 5 min with Mailgun alerting; CDN caching; documented RTO/RPO | Active |
| R-04 | Data breach via application vulnerability | Security | 2 | 5 | 10 | Daily pen-test audit (OWASP Top 10); RLS on user tables; CORS allowlist; CSP enforced; rate limiting | Active |
| R-05 | Loss of source code or version history | Availability | 1 | 4 | 4 | GitHub redundant storage; local clones as backup | Accepted |
| R-06 | Credential stuffing / brute force | Security | 3 | 3 | 9 | Supabase Auth rate limiting; OAuth social login; anonymous tokens rejected | Active |
| R-07 | Insider threat (sole developer) | Security | 1 | 5 | 5 | Branch protection; PR-based workflow with CI; daily automated audits | Accepted |
| R-08 | Regulatory non-compliance (privacy) | Compliance | 2 | 4 | 8 | Privacy policy published; DSAR runbook; PII inventory; cookie disclosure | Active |
| R-09 | Active May 2026 npm/PyPI supply chain campaigns (Mini Shai-Hulud, durabletask hijack, TrapDoor, Bitwarden CLI) | Security | 4 | 4 | 16 | Cross-referenced dependency graph 2026-05-31 (no exposure); npm audit clean; lockfile pinned; axios `>=1.15.0` override; weekly supply-chain-audit workflow; see compliance/supply-chain-2026-05-31.md | Active |

## Review Process

Reviewed quarterly. New risks added from daily security audits, supply chain monitoring, or incidents. Scores reassessed each review.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial risk register | Kevin Armstrong |
| 2026-05-31 | Added R-09 (May 2026 supply chain campaigns); confirmed no exposure to compromised packages; refreshed last-reviewed | Kevin Armstrong (pen-test) |
