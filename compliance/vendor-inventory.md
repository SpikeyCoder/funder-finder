---
title: Vendor & Subprocessor Inventory
tsc: CC9.1, CC9.2
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-21
---

# Vendor & Subprocessor Inventory — fundermatch.org

## Active Vendors

| Vendor | Service | Data Access | SOC 2 / ISO | Data Residency | DPA |
|--------|---------|-------------|-------------|----------------|-----|
| GitHub | Source control, CI/CD | Source code | SOC 2 Type II | US | Yes |
| Cloudflare | Pages hosting, CDN | Request logs, static assets | SOC 2 Type II, ISO 27001 | Global edge / US | Yes |
| Supabase | Database, auth, storage, edge functions | User profiles, grants, uploads, org data | SOC 2 Type II | US (AWS us-east-1) | Yes |
| Anthropic | Claude API (grant writer, style analysis) | User mission, org details, uploaded grants | SOC 2 Type II | US | Yes |
| OpenAI | GPT-4 API (AI draft fallback) | User prompts, grant context | SOC 2 Type II | US | Yes |
| Tavily | Web search API (grant research) | Search queries from user mission | N/A (startup) | US | ToS only |
| Trello (Atlassian) | Bug tracking | Bug reports, screenshots | SOC 2 Type II, ISO 27001 | US | Yes |
| Mailgun | Transactional email alerts | Email addresses (admin only) | SOC 2 Type II | US | Yes |

## Assessment Criteria

Each vendor evaluated on: data access level, SOC 2/ISO certification, data residency, contractual protections (DPA/BAA), and breach notification SLA.

## Review Process

Reviewed quarterly. New vendors require security assessment before onboarding. Certification loss or breach triggers immediate review.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial vendor inventory | Kevin Armstrong |
