---
title: Data Classification Standard
tsc: C1, P1
owner: Kevin Armstrong
review-cadence: annually
last-reviewed: 2026-05-04
---

# Data Classification — fundermatch.org

| Class | Examples | Storage allowed |
|---|---|---|
| Public | Public 990 data, foundation profiles, marketing pages | Supabase, GitHub, Vercel CDN |
| Internal | Aggregate ranking weights, build artifacts | Supabase, GitHub |
| Confidential | User profiles, projects, tracked grants, draft proposals | Supabase (RLS-protected) only |
| Restricted | API keys (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), OAuth client secrets | Supabase Function Secrets / GitHub Actions Secrets only |

The Supabase **anon key** is intentionally bundled in the browser (encodes
the `anon` role; protected by Row-Level Security policies). Restricted
secrets are never committed to git; secret-scanning alerts and Dependabot
security advisories are reviewed weekly.
