-- Budget-fit + prior-grantee-fit schema
-- Safe to run multiple times.

create extension if not exists pgcrypto;

-- Seeded foundations should store EIN when available for filing lookups.
alter table if exists public.funders
  add column if not exists foundation_ein text;

create index if not exists funders_foundation_ein_idx
  on public.funders (foundation_ein)
  where foundation_ein is not null;

-- Filing index for each foundation (object_id refers to ProPublica/IRS filing blob identity).
create table if not exists public.foundation_filings (
  id uuid primary key default gen_random_uuid(),
  foundation_id text not null references public.funders(id) on delete cascade,
  foundation_ein text not null,
  tax_year int not null,
  form_type text not null default '990PF',
  object_id text not null,
  xml_url text not null,
  parse_status text not null default 'pending' check (parse_status in ('pending', 'parsed', 'failed', 'skipped')),
  parse_error text,
  source_hash text,
  fetched_at timestamptz,
  parsed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (foundation_id, object_id)
);

create index if not exists foundation_filings_foundation_year_idx
  on public.foundation_filings (foundation_id, tax_year desc);

-- Raw grantee grants extracted from 990-PF XML Schedule "GrantOrContributionPdDurYrGrp".
create table if not exists public.foundation_grants (
  id uuid primary key default gen_random_uuid(),
  foundation_id text not null references public.funders(id) on delete cascade,
  filing_id uuid references public.foundation_filings(id) on delete cascade,
  grant_year int not null,
  grant_amount numeric,
  grantee_name text not null,
  grantee_ein text,
  grantee_city text,
  grantee_state text,
  grantee_country text,
  purpose_text text,
  ntee_code text,
  mission_signal_text text,
  -- Optional embedding vector stored as JSON array (portable with PostgREST + edge runtime)
  mission_embedding jsonb,
  grantee_revenue numeric,
  grantee_expenses numeric,
  -- 1:<250k, 2:250k-1M, 3:1M-5M, 4:5M+
  grantee_budget_band smallint,
  data_quality jsonb not null default '{}'::jsonb,
  source_row_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (foundation_id, filing_id, source_row_hash)
);

create index if not exists foundation_grants_foundation_year_idx
  on public.foundation_grants (foundation_id, grant_year desc);

create index if not exists foundation_grants_grantee_ein_idx
  on public.foundation_grants (grantee_ein)
  where grantee_ein is not null;

create index if not exists foundation_grants_band_idx
  on public.foundation_grants (grantee_budget_band)
  where grantee_budget_band is not null;

-- Precomputed, lightweight aggregates for fast request-time scoring.
create table if not exists public.foundation_history_features (
  foundation_id text primary key references public.funders(id) on delete cascade,
  grants_last_5y_count int not null default 0,
  grants_with_budget_count int not null default 0,
  grants_with_location_count int not null default 0,
  grants_with_mission_signal_count int not null default 0,
  median_grant_amount numeric,
  median_grantee_budget_band smallint,
  budget_band_distribution jsonb not null default '{}'::jsonb,
  top_states jsonb not null default '[]'::jsonb,
  top_ntee_codes jsonb not null default '[]'::jsonb,
  data_completeness_score numeric not null default 0,
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Generic updated_at trigger helper (no-op if already present).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_foundation_filings'
  ) then
    create trigger set_updated_at_foundation_filings
      before update on public.foundation_filings
      for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_foundation_grants'
  ) then
    create trigger set_updated_at_foundation_grants
      before update on public.foundation_grants
      for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_foundation_history_features'
  ) then
    create trigger set_updated_at_foundation_history_features
      before update on public.foundation_history_features
      for each row execute function public.set_updated_at();
  end if;
end $$;
