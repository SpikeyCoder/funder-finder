# compliance edge fn — column allowlist on insert/update (2026-05-23)

**Finding ID:** WA-2026-05-23-12
**Severity:** Low
**Type:** Insecure Design / Mass Assignment (OWASP A04, CWE-915)

## Background
`supabase/functions/compliance/index.ts` used
`{ ...body, user_id: userId }` for inserts and `{...updates}` for
updates. While `user_id` was correctly hardcoded, every other column
on `compliance_requirements` could be set by the caller — and any
future column added to the table (audit columns, `org_id`, internal
flags) becomes attacker-controllable without code review.

## Fix
Added explicit `INSERT_KEYS` and `UPDATE_KEYS` allowlists plus
`pickAllowedInsert()` / `pickAllowedUpdate()` helpers. Both write
paths now go through them. New columns require an explicit code
change to become writable.

## Verification
- `POST { requirement_text: 'x', user_id: 'attacker' }` → row inserted
  with `user_id = sub` from JWT, not `'attacker'`.
- `PUT { id, malicious_extra_col: 'x' }` → row updated; `malicious_extra_col`
  silently dropped.

Owner: @SpikeyCoder · Effort: S · Priority: P2
