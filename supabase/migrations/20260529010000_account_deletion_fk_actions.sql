-- =====================================================================
-- Make account self-deletion possible without FK errors.
--
-- Deleting an auth.users row already cascade-deletes every table the user
-- *owns* (user_profiles, projects, tracked_grants, tasks.user_id,
-- saved_funders, notifications, etc.). But six FKs referenced auth.users
-- with NO ACTION as "actor" columns (who assigned / invited / granted /
-- changed something). If the departing user was referenced there, the
-- delete would be blocked.
--
-- Fix: detach those references on delete.
--   * Nullable actor columns -> ON DELETE SET NULL (keep the row, drop the
--     attribution).
--   * grant_status_history.changed_by is NOT NULL, so it can't be nulled ->
--     ON DELETE CASCADE (the user's status-change history rows go with them).
--
-- Each statement drops and re-adds the constraint with the same name and the
-- same (column -> auth.users(id)) reference, changing only the delete action.
-- =====================================================================

-- Nullable actor columns -> SET NULL
alter table public.tasks
  drop constraint tasks_assignee_user_id_fkey,
  add constraint tasks_assignee_user_id_fkey
    foreign key (assignee_user_id) references auth.users(id) on delete set null;

alter table public.org_members
  drop constraint org_members_invited_by_fkey,
  add constraint org_members_invited_by_fkey
    foreign key (invited_by) references auth.users(id) on delete set null;

alter table public.project_access
  drop constraint project_access_granted_by_fkey,
  add constraint project_access_granted_by_fkey
    foreign key (granted_by) references auth.users(id) on delete set null;

alter table public.access_log
  drop constraint access_log_user_id_fkey,
  add constraint access_log_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

alter table public.compliance_requirements
  drop constraint compliance_requirements_assignee_user_id_fkey,
  add constraint compliance_requirements_assignee_user_id_fkey
    foreign key (assignee_user_id) references auth.users(id) on delete set null;

-- NOT NULL audit column -> CASCADE
alter table public.grant_status_history
  drop constraint grant_status_history_changed_by_fkey,
  add constraint grant_status_history_changed_by_fkey
    foreign key (changed_by) references auth.users(id) on delete cascade;
