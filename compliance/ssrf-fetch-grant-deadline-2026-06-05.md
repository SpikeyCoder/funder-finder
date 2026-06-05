# SSRF guard on `fetch-grant-deadline` (FM-2026-06-05-01)

## Summary
The `fetch-grant-deadline` Supabase Edge Function accepts a user-supplied
`url` in its POST body and issues a server-side HTTP request against it
to extract the application deadline. Prior to this change the function:

- validated only that the URL parsed and used `http(s)`;
- did **not** check the resolved IP against private/loopback/link-local/
  reserved/cloud-metadata ranges;
- followed redirects via the platform-default `redirect: 'follow'`, so a
  hostname that resolved to a public IP could 302 to an internal one
  without a second check (DNS-rebinding / redirect-pivot SSRF).

`check-deadlines` (cron) calls `fetch-grant-deadline` for every stored
`tracked_grants.grant_url`, so the same issue applied transitively to
URLs that originated from any authenticated user.

## Fix
- Introduced `_shared/safe_fetch.ts` (`safeFetch` + `SSRFBlockedError`):
  scheme allowlist, cloud-metadata host blocklist (AWS / GCP / Azure
  IMDS), IPv4/IPv6 private-range checks, DNS resolution with rejection
  if any resolved address is non-public, manual redirect handling with
  per-hop revalidation, bounded redirect depth.
- Replaced the `fetch(parsedUrl, ...)` call in `fetch-grant-deadline`
  with `safeFetch(parsedUrl, ...)` and returned `400` on
  `SSRFBlockedError` so misconfigured URLs surface visibly.

## Standards / References
- CWE-918 Server-Side Request Forgery
- OWASP API Security Top 10 — API10:2023
- OWASP Web Top 10 — A10:2021
- Cloud-metadata IMDS references:
  - AWS: `http://169.254.169.254/latest/meta-data/`
  - GCP: `http://metadata.google.internal/computeMetadata/v1/`
  - Azure: `http://169.254.169.254/metadata/instance?api-version=...`

## Verification
- `deno check supabase/functions/fetch-grant-deadline/index.ts` clean.
- Manual test cases the verifier should run after merge:
  - `http://169.254.169.254/latest/meta-data/` → 400 SSRFBlocked.
  - `http://metadata.google.internal/...` → 400 SSRFBlocked.
  - `http://localhost:5432/` → 400 SSRFBlocked.
  - `https://example.com/redirect-to-169.254.169.254` → 400 on the
    redirect hop (per-hop revalidation).
  - `https://www.fundermatch.org/` → 200 (allowed public hostname).
