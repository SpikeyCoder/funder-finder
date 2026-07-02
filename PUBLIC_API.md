# FunderMatch Public API

> FM-IC-CFG-002 — a documented, read-only API over your FunderMatch grant
> pipeline for workflow automation (Zapier, Make, spreadsheets, custom scripts,
> BI tools).

## Base URL

```
https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/public-api
```

## Authentication

Create a personal API key in **Account Settings → API**. The full secret is
shown **once** at creation; only a SHA‑256 hash and a short display prefix are
stored. Send it as a bearer token on every request:

```
Authorization: Bearer fmk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

All responses are scoped to the key owner. Revoke a key any time from the same
screen.

## Machine-readable contract

An OpenAPI 3.0 document is served (no auth required) at:

```
GET /public-api/openapi.json
```

Import it into Postman, Insomnia, or an OpenAPI client generator.

## Endpoints

| Method | Path | Description | Query params |
| ------ | ---- | ----------- | ------------ |
| GET | `/` | Service descriptor + endpoint index (public) | — |
| GET | `/openapi.json` | OpenAPI 3.0 spec (public) | — |
| GET | `/v1/projects` | Your projects | — |
| GET | `/v1/pipeline-statuses` | Your pipeline statuses | — |
| GET | `/v1/tracked-grants` | Your tracked grants (opportunities) | `project_id`, `status_slug`, `limit` (≤500) |
| GET | `/v1/saved-funders` | Your saved funders | `limit` (≤500) |

## Example

```bash
curl -s \
  -H "Authorization: Bearer $FUNDERMATCH_API_KEY" \
  "https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/public-api/v1/tracked-grants?status_slug=submitted&limit=50"
```

```json
[
  {
    "id": "…",
    "project_id": "…",
    "funder_name": "Example Foundation",
    "grant_title": "General Operating Support",
    "amount": 50000,
    "deadline": "2026-09-01",
    "status_id": "…",
    "custom_fields": { "program_officer": "Jane Doe" },
    "updated_at": "2026-06-14T12:00:00Z"
  }
]
```

## Notes

- **Read-only.** Keys carry a `read` scope; write endpoints are intentionally
  not exposed in v1.
- **Rate / volume.** List endpoints cap at `limit=500` (default 100).
- **Errors.** Non-2xx responses return `{ "error": "<message>" }`. A missing or
  invalid key returns `401`.
