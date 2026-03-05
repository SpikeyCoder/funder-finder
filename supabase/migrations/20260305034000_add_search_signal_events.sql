-- Log-only interaction signals for supervised ranking improvements.
-- This table is write-only via edge functions using service role credentials.

create extension if not exists pgcrypto;

create table if not exists public.search_signal_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_type text not null check (
    event_type in (
      'search_results_loaded',
      'results_refreshed',
      'result_saved',
      'result_unsaved',
      'result_outbound_click',
      'result_view_details'
    )
  ),
  search_run_id text not null,
  session_id text not null,
  mission_hash text not null,
  budget_band text,
  location_served text,
  keywords text[] not null default '{}'::text[],
  foundation_id text references public.funders(id) on delete set null,
  foundation_rank int,
  fit_score numeric,
  result_count int,
  metadata jsonb not null default '{}'::jsonb,
  user_id uuid references auth.users(id) on delete set null,
  scoring_version text,
  source text not null default 'web',
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  check (foundation_rank is null or foundation_rank between 1 and 200),
  check (fit_score is null or (fit_score >= 0 and fit_score <= 1)),
  check (result_count is null or result_count >= 0)
);

create index if not exists search_signal_events_created_at_idx
  on public.search_signal_events (created_at desc);

create index if not exists search_signal_events_type_created_idx
  on public.search_signal_events (event_type, created_at desc);

create index if not exists search_signal_events_foundation_idx
  on public.search_signal_events (foundation_id, created_at desc)
  where foundation_id is not null;

create index if not exists search_signal_events_search_run_idx
  on public.search_signal_events (search_run_id, created_at desc);

create index if not exists search_signal_events_mission_hash_idx
  on public.search_signal_events (mission_hash, created_at desc);

alter table public.search_signal_events enable row level security;
revoke all on public.search_signal_events from anon, authenticated;

create or replace view public.search_signal_training_labels_v1 as
select
  e.search_run_id,
  e.mission_hash,
  min(e.budget_band) as budget_band,
  min(e.location_served) as location_served,
  min(e.keywords) as keywords,
  e.foundation_id,
  min(e.foundation_rank) as foundation_rank,
  max(case when e.event_type = 'result_saved' then 1 else 0 end) as saved_signal,
  max(case when e.event_type = 'result_outbound_click' then 1 else 0 end) as outbound_signal,
  max(case when e.event_type = 'result_view_details' then 1 else 0 end) as detail_signal,
  (
    max(case when e.event_type = 'result_saved' then 1 else 0 end) * 1.0
    + max(case when e.event_type = 'result_outbound_click' then 1 else 0 end) * 0.6
    + max(case when e.event_type = 'result_view_details' then 1 else 0 end) * 0.3
  ) as relevance_label,
  min(e.created_at) as first_seen_at,
  max(e.created_at) as last_seen_at
from public.search_signal_events e
where e.foundation_id is not null
group by e.search_run_id, e.mission_hash, e.foundation_id;
