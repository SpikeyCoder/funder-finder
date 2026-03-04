# Security Policy

## Supported Versions

FunderMatch is a single-version static web app. Only the current `main` branch deployment at [fundermatch.org](https://fundermatch.org) is actively maintained.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Email **kevinmarmstrong1990@gmail.com** with:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any relevant logs, screenshots, or code references

You can expect an acknowledgement within **48 hours** and a resolution or status update within **7 days**.

## Scope

In scope:
- Authentication bypass or privilege escalation
- Cross-site scripting (XSS) in user-facing pages
- Data exposure through the Supabase API or Edge Functions
- Supply-chain issues in dependencies

Out of scope:
- Denial-of-service attacks against free-tier infrastructure
- Self-XSS (requires the user to run code themselves)
- Issues requiring physical access to a device
- Rate-limiting on public APIs that have their own abuse protection

## Architecture Notes for Researchers

- **Frontend**: React/Vite SPA hosted on GitHub Pages (static, no server-side rendering)
- **Backend**: Supabase (PostgreSQL + Auth + Edge Functions)
- **AI**: Claude via Anthropic API, called only from the Edge Function (key never reaches the browser)
- **Analytics**: GoatCounter (privacy-friendly, no cookies, no PII)
- The `SUPABASE_ANON_KEY` in `src/lib/supabase.ts` is intentionally public — it is a JWT encoding the `anon` role and is protected by Supabase Row-Level Security (RLS) policies.
- The `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are stored only as Supabase Edge Function secrets and are never exposed to the browser.
