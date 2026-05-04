---
title: Risk Register
tsc: CC3
owner: Kevin Armstrong
review-cadence: quarterly
last-reviewed: 2026-05-04
---

# Risk Register — fundermatch.org

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|
| R-01 | SUPABASE_SERVICE_ROLE_KEY leak from Edge Function | Low | Critical | Phase 4 user-scoped client migration; only public/anonymous flows still hold the key | Partial |
| R-02 | XSS via grant-writer Claude output | Medium | High | DOMPurify sanitises before dangerouslySetInnerHTML | Mitigated |
| R-03 | Brute-force enumeration of share-link tokens | Medium | Medium | Rate-limit at function entry; ensure ≥128-bit entropy on tokens (planned) | Planned |
| R-04 | Anonymous flooding of search_signal_events | Medium | Low | Per-IP rate limit + RLS gating (planned) | Planned |
| R-05 | Vendor outage (Supabase / Anthropic / OpenAI) | Medium | Medium | Multi-host build (Vercel + Netlify + GH Pages); graceful degradation banners | Mitigated |
| R-06 | Single-owner bus factor | Medium | High | Encrypted credential vault shared with successor designee | Partial |
