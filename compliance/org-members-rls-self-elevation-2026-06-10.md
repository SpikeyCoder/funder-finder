# org_members RLS self-elevation — FM-2026-06-10-01

**Date:** 2026-06-10
**Severity (pre-fix):** High
**Finding ID:** FM-2026-06-10-01
**Status:** Fixed in migration `20260610120000_org_members_rls_hardening.sql`

## Vulnerability

Both `org_members_insert` and `org_members_update` RLS policies were
under-scoped:

- `INSERT WITH CHECK (invited_by = auth.uid())` placed no constraint on
  `user_id`, `role`, or `status`. An attacker with any valid user session
  could `POST /rest/v1/org_members` with their own `user_id`,
  `invited_by = self`, `role = 'admin'`, `status = 'active'` and become
  an admin in the org_members table.
- `UPDATE USING (EXISTS (SELECT 1 FROM org_members om WHERE om.user_id =
  auth.uid() AND om.role = 'admin'))` checked only that the caller is
  admin **somewhere**, not in the **target row's** org. Once the
  attacker promoted themselves (above), they could mutate any other
  org's member rows — demote a real admin, lock out members, or promote
  a second attacker-controlled account.

`isAdmin()` in `supabase/functions/team-invite/index.ts` reads from
`org_members` with the service-role client, so the synthetic admin row
also unlocked team-invite admin paths.

## Threat model

| Property         | Pre-fix                                              |
|------------------|------------------------------------------------------|
| Confidentiality  | Any user could read same-org rows via the chain      |
| **Integrity**    | **Any signed-in user → full admin of any org**       |
| Availability     | Mass lockout via role demotion or status flip        |

## Fix

`20260610120000_org_members_rls_hardening.sql` replaces the three
policies (INSERT/UPDATE + new DELETE) with `org_admin_id()`-scoped
predicates that already power the `*_org_scope_select` policies
introduced in `20260511180000_org_scope_select_broadening.sql`:

- INSERT now requires either (a) a bootstrap self-row when the user has
  no existing membership, or (b) the caller is an active admin and the
  new row is for a different user. Branch (b) keeps the team-invite
  flow working because the invited member's `org_admin_id` chains to
  the caller's org root via `invited_by`.
- UPDATE / DELETE both require the caller to be an active admin **and**
  the target row's `org_admin_id` to equal the caller's `org_admin_id`.
- UPDATE has a `WITH CHECK` mirror to prevent admins from re-rooting
  members into another org.
- DELETE additionally forbids self-deletion (would orphan the org root).

## Verification

Manual smoke test (authenticated REST API):

```bash
# As userA (non-admin):
curl -X POST "$SUPABASE_URL/rest/v1/org_members" \
  -H "apikey: $ANON" -H "Authorization: Bearer $USER_A_JWT" \
  -d '{"user_id":"<userA>","invited_by":"<userA>","role":"admin","status":"active"}'
# Expected: 403 (NOT EXISTS predicate fails after first row exists)

# As userA already admin of orgA, attempt to update userB (in orgB):
curl -X PATCH "$SUPABASE_URL/rest/v1/org_members?user_id=eq.<userB>" \
  -H "apikey: $ANON" -H "Authorization: Bearer $USER_A_JWT" \
  -d '{"role":"admin"}'
# Expected: 0 rows updated (org_admin_id mismatch)
```

## Trust Services Criteria

Closes CC6.3 (Logical Access — role enforcement) and CC6.7 (role
assignment) gaps from the 2026-06-10 pen-test.

## References

- OWASP A01:2021 Broken Access Control
- CWE-863 Incorrect Authorization
- AICPA TSC CC6.3, CC6.7
