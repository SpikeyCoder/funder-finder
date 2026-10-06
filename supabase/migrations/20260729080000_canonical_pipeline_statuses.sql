-- FM-2026-07-29-05: one canonical set of default pipeline statuses.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDING
-- -------
-- Two different functions seeded default pipeline statuses, with DIFFERENT sets,
-- and both guarded on "does this user have any statuses yet" — so whichever ran
-- first won and the other silently became a no-op:
--
--   handle_new_user_pipeline()      trigger on auth.users, 8 statuses
--     Researching, Prospecting, Planned, LOI Submitted, Application Submitted,
--     Under Review, Awarded, DECLINED                      (#6366f1 palette)
--
--   seed_pipeline_statuses(uuid)    RPC called by tracked-grants, 10 statuses
--     Researching, Planned, IN PROGRESS, LOI Submitted, SUBMITTED,
--     Application Submitted, Under Review, Awarded, REJECTED, ON HOLD
--                                                          (#95A5A6 palette)
--
-- Since the trigger fires at signup, the RPC's set could never win for a new
-- user — it was dead code. But users created before the trigger existed still
-- carry it, so the live data was split:
--   prospecting/declined  15-16 users   (trigger set)
--   in_progress/submitted  4 users      (RPC set)
--   on_hold/rejected       1 user       (RPC set)
--   due_diligence          1 user       (neither — a user's own custom stage)
--
-- DECISION (product call, 2026-07-29): the trigger's set is canonical.
-- "Declined" over "Rejected"; drop "In Progress" and "On Hold". "Submitted" is
-- dropped with them — it is RPC-only and a near-duplicate of the canonical
-- "Application Submitted", which every user already has.
--
-- SAFETY: verified before writing this. Of the statuses removed below, ALL have
-- ZERO tracked_grants assigned. Only `researching` (39 grants) and `planned` (3)
-- are referenced at all, and both are canonical and untouched. No grant is
-- orphaned by this migration.
--
-- `due_diligence` is deliberately KEPT. It belongs to neither default set, so it
-- is a user-created stage; removing it would destroy someone's customisation.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. remove the non-canonical defaults (all have 0 grants assigned) ──────

delete from public.pipeline_statuses
where slug in ('in_progress', 'on_hold', 'rejected', 'submitted');

-- ─── 2. backfill so every user has the full canonical set ───────────────────
-- Idempotent: inserts only what is missing. Users who already have a slug keep
-- their row, including any colour or sort_order they have customised.

insert into public.pipeline_statuses (user_id, name, slug, color, sort_order, is_default, is_terminal)
select u.id, d.name, d.slug, d.color, d.sort_order, true, d.is_terminal
from auth.users u
cross join (values
  ('Researching',           'researching',           '#6366f1', 0, false),
  ('Prospecting',           'prospecting',           '#8b5cf6', 1, false),
  ('Planned',               'planned',               '#3b82f6', 2, false),
  ('LOI Submitted',         'loi_submitted',         '#06b6d4', 3, false),
  ('Application Submitted', 'application_submitted', '#10b981', 4, false),
  ('Under Review',          'under_review',          '#f59e0b', 5, false),
  ('Awarded',               'awarded',               '#22c55e', 6, true),
  ('Declined',              'declined',              '#ef4444', 7, true)
) as d(name, slug, color, sort_order, is_terminal)
where not exists (
  select 1 from public.pipeline_statuses p
  where p.user_id = u.id and p.slug = d.slug
);

-- ─── 3. align the RPC so it can never reintroduce the divergence ────────────
-- The function is retained as a service-role backfill utility, but its status
-- set now matches handle_new_user_pipeline exactly. The ownership guard from
-- FM-2026-07-29-01 is preserved.

create or replace function public.seed_pipeline_statuses(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated' and p_user_id is distinct from auth.uid() then
    raise exception 'seed_pipeline_statuses: callers may only seed their own pipeline'
      using errcode = '42501';
  end if;

  if not exists (select 1 from pipeline_statuses where user_id = p_user_id) then
    insert into pipeline_statuses (user_id, name, slug, color, sort_order, is_default, is_terminal) values
      (p_user_id, 'Researching',           'researching',           '#6366f1', 0, true, false),
      (p_user_id, 'Prospecting',           'prospecting',           '#8b5cf6', 1, true, false),
      (p_user_id, 'Planned',               'planned',               '#3b82f6', 2, true, false),
      (p_user_id, 'LOI Submitted',         'loi_submitted',         '#06b6d4', 3, true, false),
      (p_user_id, 'Application Submitted', 'application_submitted', '#10b981', 4, true, false),
      (p_user_id, 'Under Review',          'under_review',          '#f59e0b', 5, true, false),
      (p_user_id, 'Awarded',               'awarded',               '#22c55e', 6, true, true),
      (p_user_id, 'Declined',              'declined',              '#ef4444', 7, true, true)
    on conflict do nothing;
  end if;
end;
$$;

-- ─── 4. revoke the grant that tracked-grants no longer needs ────────────────
-- tracked-grants called this RPC on EVERY request as a "best-effort seed". That
-- was redundant: on_auth_user_created_pipeline is attached to auth.users and
-- enabled, and all 16 users already had statuses, so it never seeded anyone — it
-- was one wasted round-trip per request. The call is removed from the edge
-- function in the accompanying change, so `authenticated` no longer needs
-- EXECUTE. Revoking it clears Supabase advisor lint 0029 for this function and
-- removes the write-side IDOR surface entirely rather than merely guarding it.
--
-- service_role keeps EXECUTE so the function remains usable for manual backfill.
revoke execute on function public.seed_pipeline_statuses(uuid) from authenticated;
