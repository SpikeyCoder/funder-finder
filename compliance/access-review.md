---
title: Access Review Policy
tsc: CC6.1, CC6.2, CC6.3
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-21
---

# Access Review Policy — fundermatch.org

## Systems Under Review

| System | Access Method | MFA | Credentials |
|--------|--------------|-----|-------------|
| GitHub (SpikeyCoder) | OAuth / PAT | Yes | PAT rotated quarterly |
| Cloudflare | Email + password | Yes | Dashboard access |
| Supabase (tgtotjvdubhjxzybmdex) | Dashboard + service role key | Yes | Key in edge function secrets |
| Anthropic | API key | N/A | Key in edge function secrets |
| OpenAI | API key | N/A | Key in edge function secrets |
| Tavily | API key | N/A | Key in edge function secrets |
| Trello | API key + token | N/A | Keys in edge function secrets |
| Mailgun | API key | N/A | Key in Cowork scheduled task |

## Current Access Holders

| Person | Role | Systems | Last Verified |
|--------|------|---------|--------------|
| Kevin Armstrong | Owner / Developer | All systems above | 2026-05-21 |

## Review Schedule

| Frequency | Action |
|-----------|--------|
| Quarterly | Review all access lists against this document |
| On personnel change | Immediate review and revocation |
| On vendor change | Review and rotate shared credentials |
| On security incident | Emergency review within 24 hours |

## Review Procedure

1. Verify access list matches the table above for each system
2. Remove accounts not in the table
3. Rotate credentials older than 90 days
4. Verify MFA enabled on all supporting accounts
5. Document findings and update this file

## Compensating Control

Single-developer organization. Access surface is minimal by design. Automated daily security audits provide continuous monitoring.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial access review policy | Kevin Armstrong |
