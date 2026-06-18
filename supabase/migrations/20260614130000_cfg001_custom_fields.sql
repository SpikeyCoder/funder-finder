-- =====================================================================
-- FM-IC-CFG-001: User-defined custom data fields for funders & opportunities
--
-- Audit finding (daily_usability_audit 2026-06-14): "Still no custom-field
-- schema. Funders + tracked_grants use fixed columns." Instrumentl lets a
-- user attach their own data fields (e.g. "Program Officer", "Internal
-- Priority", "Board Champion") to the funders and opportunities they track.
-- FunderMatch previously only exposed fixed columns + a free-text notes box.
--
-- This migration introduces a lightweight, per-user custom-field schema:
--
--   * custom_field_definitions  -- each row is one field the user has defined,
--     scoped to an entity ("funder" = saved_funders annotations, "grant" =
--     tracked_grants opportunities). Field type drives the input rendered in
--     the UI (text / number / date / select / checkbox / url).
--
--   * saved_funders.custom_fields  (jsonb) -- per-saved-funder values, keyed by
--     definition field_key.
--   * tracked_grants.custom_fields (jsonb) -- per-opportunity values, keyed by
--     definition field_key.
--
-- Values are stored as a flat jsonb object ({ "<field_key>": <value> }) rather
-- than a separate values table: the cardinality is tiny (a handful of fields
-- per user), it keeps reads single-row, and it mirrors the existing
-- funder_data jsonb snapshot pattern already used on saved_funders.
--
-- All objects are user-scoped via RLS, consistent with saved_funders and
-- tracked_grants (auth.uid() = user_id).
-- =====================================================================

-- -- Definitions table ------------------------------------------------
create table if not exists public.custom_field_definitions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- which surface the field attaches to:
  --   'funder' -> saved_funders.custom_fields
  --   'grant'  -> tracked_grants.custom_fields (opportunities/pipeline)
  entity      text not null check (entity in ('funder', 'grant')),
  -- stable machine key used as the jsonb object key on the value rows
  field_key   text not null,
  -- human-facing label shown in the UI
  label       text not null,
  field_type  text not null default 'text'
              check (field_type in ('text', 'number', 'date', 'select', 'checkbox', 'url')),
  -- option list for field_type = 'select' (array of strings); empty otherwise
  options     jsonb not null default '[]'::jsonb,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- one field_key per user per entity
  unique (user_id, entity, field_key)
);

create index if not exists idx_custom_field_definitions_user_entity
  on public.custom_field_definitions (user_id, entity, sort_order);

-- keep updated_at fresh
create or replace function public.update_custom_field_definitions_timestamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists custom_field_definitions_updated_at on public.custom_field_definitions;
create trigger custom_field_definitions_updated_at
  before update on public.custom_field_definitions
  for each row execute function public.update_custom_field_definitions_timestamp();

alter table public.custom_field_definitions enable row level security;

drop policy if exists "Users view own custom field definitions" on public.custom_field_definitions;
create policy "Users view own custom field definitions"
  on public.custom_field_definitions for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own custom field definitions" on public.custom_field_definitions;
create policy "Users insert own custom field definitions"
  on public.custom_field_definitions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own custom field definitions" on public.custom_field_definitions;
create policy "Users update own custom field definitions"
  on public.custom_field_definitions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own custom field definitions" on public.custom_field_definitions;
create policy "Users delete own custom field definitions"
  on public.custom_field_definitions for delete
  using (auth.uid() = user_id);

-- -- Value columns on the two annotation surfaces ---------------------
alter table public.saved_funders
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table public.tracked_grants
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;
