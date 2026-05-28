# Rate-limit funder-finder/report-bug edge function (FM-2026-05-28-01)

## Background

`supabase/functions/report-bug/index.ts` exposes an **unauthenticated POST
endpoint** that creates a Trello card on every call. Until this PR, the
endpoint had no per-IP rate-limit. The only protections were:

* CORS allowlist (browser-side; trivially bypassed by a non-browser client).
* `MAX_DESCRIPTION_LENGTH` server-side cap (2,000 chars).
* `screenshotUrl` SSRF check (`isValidScreenshotUrl`).

Result: a hostile client could create unlimited Trello cards, exhausting
the Trello API quota and polluting the bug-triage board.

## Change

Added a 20-req/min/IP `ipRateLimit` call immediately after the OPTIONS
preflight handler, before any body parsing or Trello fetch. The limiter
already exists in `_shared/rate_limit.ts` and is the same control used by
`share-link` (FM-2026-05-10-02) and `calendar-feed` (FM-2026-05-09-01).

## Threat model & severity

* CWE-770 (Allocation of Resources Without Limits) — Medium.
* OWASP API4:2023 — Unrestricted Resource Consumption.
* SOC 2 CC6.6, CC7.2 (availability of monitored controls).

## Verification

1. `curl -X POST https://<fn-url>/report-bug -H 'content-type: application/json'
   -d '{"description":"test","isFeatureRequest":false,"screenshotUrl":null,
   "technicalContext":{...}}'` repeated >20×/min returns HTTP 429 with
   `Retry-After`.
2. Normal one-off submissions return 200 unchanged.
3. Existing CORS / SSRF / description-length tests continue to pass.

## References

* OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption.
* CWE-770.
* compliance/share-link-rate-limit.md (the precedent control).
