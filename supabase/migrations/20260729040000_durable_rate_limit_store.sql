-- FM-2026-07-29-04: durable rate-limit store.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDING: `supabase/functions/_shared/rate_limit.ts` does nothing in production.
--
-- It keys its counters off a module-level `Map`, which only survives if the Deno
-- isolate is reused between requests. Measured against this project 2026-07-29:
-- it is not. Eight rapid sequential requests to the same function each returned a
-- DIFFERENT module-scope boot id and a per-isolate hit count of 1. With the limit
-- deliberately set to 3, every request was still allowed.
--
--   req 1  boot=1762e9a1 hits=1 allow=true      req 5  boot=7685edb2 hits=1 allow=true
--   req 2  boot=278b821c hits=1 allow=true      req 6  boot=f928783d hits=1 allow=true
--   req 3  boot=b35ef3fc hits=1 allow=true      req 7  boot=5411ba25 hits=1 allow=true
--   req 4  boot=faea351c hits=1 allow=true      req 8  boot=16d27326 hits=1 allow=true
--
-- The helper is not broken in an obvious way — it resolves the caller IP
-- correctly (x-forwarded-for IS supplied by the Edge runtime, contrary to first
-- suspicion) and its own docstring anticipates "per-isolate accuracy". The flaw
-- is that per-isolate accuracy degrades to ZERO limiting when isolates are
-- per-request. It reviews clean and does nothing, which is the worst combination
-- for a security control.
--
-- Blast radius: 18 functions import it, including the per-IP limits added for
-- the LLM-backed endpoints (FM-2026-06-07-01) and for calendar-feed / share-link
-- (PR #62, FM-2026-05-09-01). None of those limits have ever taken effect.
--
-- FIX: move the counter to the one store all isolates already share — Postgres.
-- A single INSERT .. ON CONFLICT DO UPDATE is atomic, so concurrent isolates
-- cannot race past the limit.
--
-- This migration only provides the mechanism. It is wired into contact-form by
-- the accompanying change; rolling the other 17 functions over is deliberately
-- left as a separate decision, since it adds a DB round-trip per request to
-- each one.
--
-- CWE-770 (Allocation of Resources Without Limits or Throttling).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.rate_limit_hits (
  bucket_key   text primary key,
  hit_count    integer     not null,
  window_start timestamptz not null default now()
);

comment on table public.rate_limit_hits is
  'Durable per-key rate-limit counters shared across Edge Function isolates. See FM-2026-07-29-04.';

-- Deny-all: only the SECURITY DEFINER function below touches this, and it
-- bypasses RLS as table owner. Nothing should read it directly.
alter table public.rate_limit_hits enable row level security;

-- Lets the purge below use an index instead of a seq scan as the table grows.
create index if not exists idx_rate_limit_hits_window_start
  on public.rate_limit_hits (window_start);

-- Atomic check-and-increment. Returns true when the caller is still under the
-- limit. The whole decision is one statement, so two isolates arriving together
-- cannot both observe a stale count.
create or replace function public.check_rate_limit(
  p_key            text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_key is null or btrim(p_key) = '' then
    -- No key means no caller identity; fail OPEN, matching the previous helper's
    -- documented behaviour rather than locking out an unusual proxy chain.
    return true;
  end if;

  insert into public.rate_limit_hits as r (bucket_key, hit_count, window_start)
  values (p_key, 1, now())
  on conflict (bucket_key) do update
    set hit_count = case
          when r.window_start < now() - make_interval(secs => p_window_seconds)
            then 1
            else r.hit_count + 1
          end,
        window_start = case
          when r.window_start < now() - make_interval(secs => p_window_seconds)
            then now()
            else r.window_start
          end
  returning r.hit_count into v_count;

  return v_count <= p_limit;
end;
$$;

-- Callable only by service_role. The Edge Functions reach it with the
-- service-role key; anon/authenticated must never be able to poison or probe
-- another caller's bucket. REVOKE FROM PUBLIC alone is insufficient on Supabase
-- (default privileges grant EXECUTE to anon/authenticated explicitly).
revoke all     on function public.check_rate_limit(text, integer, integer) from public;
revoke execute on function public.check_rate_limit(text, integer, integer) from anon, authenticated;
grant  execute on function public.check_rate_limit(text, integer, integer) to service_role;

-- Housekeeping: buckets are only meaningful inside their window. Anything older
-- than a day is dead weight. Mirrors the existing purge_expired_* convention.
create or replace function public.purge_expired_rate_limit_hits()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limit_hits where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  raise log 'purge_expired_rate_limit_hits: deleted % rows', v_deleted;
end;
$$;

revoke all     on function public.purge_expired_rate_limit_hits() from public;
revoke execute on function public.purge_expired_rate_limit_hits() from anon, authenticated;
