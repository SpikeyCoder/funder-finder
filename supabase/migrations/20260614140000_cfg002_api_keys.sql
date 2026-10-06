-- =====================================================================
-- FM-IC-CFG-002: Public API for workflow automation (API keys)
--
-- Audit finding (daily_usability_audit 2026-06-14, PARTIAL): "Supabase REST
-- + edge fns act as API; PROJECT_SUMMARY.md documents shape. No public
-- OpenAPI yet." Instrumentl exposes a documented API so teams can pull their
-- pipeline into other tools. FunderMatch had no first-class, user-issued API
-- credential and no published contract.
--
-- This migration adds personal API keys. Each key authenticates a read-only
-- request to the new `public-api` edge function (served alongside an
-- OpenAPI 3.0 document). Keys are shown to the user exactly once at creation;
-- only a SHA-256 hash + a short display prefix are persisted.
--
-- Security:
--   * key_hash stores SHA-256(secret) — the raw secret is never stored.
--   * key_prefix ("fmk_live_xxxxxxxx") is stored for display/disambiguation.
--   * RLS scopes every row to its owner; revoked keys keep revoked_at set.
--   * The public-api edge function verifies presented keys with the
--     service-role client (RLS-bypassing) by hashing the bearer token and
--     matching an un-revoked row, then scopes all data reads to that
--     row's user_id.
-- =====================================================================

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  -- display-only prefix, e.g. 'fmk_live_3f9a1c20'
  key_prefix   text not null,
  -- SHA-256 hex digest of the full secret; the secret itself is never stored
  key_hash     text not null unique,
  -- coarse scopes; read-only for now (forward-compatible)
  scopes       text[] not null default array['read']::text[],
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create index if not exists idx_api_keys_user on public.api_keys (user_id);
create index if not exists idx_api_keys_hash on public.api_keys (key_hash) where revoked_at is null;

alter table public.api_keys enable row level security;

-- Users manage only their own keys. Note: the public-api edge function does
-- NOT rely on these policies — it uses the service-role client to resolve a
-- presented key to a user_id. These policies govern the in-app key manager.
drop policy if exists "Users view own api keys" on public.api_keys;
create policy "Users view own api keys"
  on public.api_keys for select
  using (auth.uid() = user_id);

drop policy if exists "Users create own api keys" on public.api_keys;
create policy "Users create own api keys"
  on public.api_keys for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own api keys" on public.api_keys;
create policy "Users update own api keys"
  on public.api_keys for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own api keys" on public.api_keys;
create policy "Users delete own api keys"
  on public.api_keys for delete
  using (auth.uid() = user_id);
