-- Optimize Browse Grants Field-of-Work filtering latency.
--
-- Problem:
--   filter_funders_grant_level currently checks grant-level NTEE with an
--   EXISTS scan over foundation_grants (and recipient fallback), which can
--   take 20s+ for multi-filter queries.
--
-- Solution:
--   Precompute per-foundation NTEE letter prefixes into a compact lookup table
--   and filter against it with a GIN array-overlap check.

create table if not exists public.foundation_grant_ntee_profiles (
  foundation_id text primary key references public.funders(id) on delete cascade,
  ntee_prefixes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_foundation_grant_ntee_profiles_prefixes
  on public.foundation_grant_ntee_profiles using gin (ntee_prefixes);

create or replace function public.refresh_foundation_grant_ntee_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.foundation_grant_ntee_profiles;

  insert into public.foundation_grant_ntee_profiles (foundation_id, ntee_prefixes, updated_at)
  select
    foundation_id,
    array_agg(distinct prefix order by prefix) as ntee_prefixes,
    now() as updated_at
  from (
    select
      fg.foundation_id,
      left(
        upper(
          coalesce(
            nullif(fg.ntee_code, ''),
            nullif(ro.ntee_code, ''),
            ''
          )
        ),
        1
      ) as prefix
    from public.foundation_grants fg
    left join public.recipient_organizations ro
      on ro.ein = fg.grantee_ein
  ) derived
  where prefix ~ '^[A-Z]$'
  group by foundation_id;
end;
$$;

-- Initial backfill for existing data.
select public.refresh_foundation_grant_ntee_profiles();

create or replace function public.filter_funders_grant_level(
  p_query text default null,
  p_states_csv text default '',
  p_ntee_codes_csv text default '',
  p_funder_types_csv text default '',
  p_grant_size_min numeric default null,
  p_grant_size_max numeric default null,
  p_locations_served_csv text default '',
  p_sort_by text default 'total_giving',
  p_sort_order text default 'desc',
  p_page integer default 1,
  p_per_page integer default 25
)
returns table (
  funder_id text,
  ein text,
  name text,
  state text,
  entity_type text,
  ntee_code text,
  total_giving numeric,
  avg_grant_size numeric,
  grant_count bigint,
  grant_range_min integer,
  grant_range_max integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_per_page integer := least(greatest(coalesce(p_per_page, 25), 1), 200);
  v_offset integer := (v_page - 1) * v_per_page;
begin
  return query
  with parsed as (
    select
      coalesce(
        array(
          select upper(trim(v))
          from unnest(string_to_array(nullif(p_states_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as states,
      coalesce(
        array(
          select upper(trim(v))
          from unnest(string_to_array(nullif(p_ntee_codes_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as ntee_codes,
      coalesce(
        array(
          select trim(v)
          from unnest(string_to_array(nullif(p_funder_types_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as funder_types,
      coalesce(
        array(
          select trim(v)
          from unnest(string_to_array(nullif(p_locations_served_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as locations_served
  ),
  ntee_match as (
    select gp.foundation_id
    from parsed p
    join public.foundation_grant_ntee_profiles gp
      on cardinality(p.ntee_codes) > 0
     and gp.ntee_prefixes && p.ntee_codes
  ),
  filtered as (
    select
      m.*,
      p.ntee_codes
    from public.mv_funder_search_index m
    cross join parsed p
    where m.grant_count > 0
      and (
        p_query is null
        or btrim(p_query) = ''
        or m.search_vector @@ websearch_to_tsquery('english', p_query)
      )
      and (
        cardinality(p.states) = 0
        or upper(coalesce(m.state, '')) = any(p.states)
      )
      and (
        cardinality(p.funder_types) = 0
        or m.entity_type = any(p.funder_types)
      )
      and (
        p_grant_size_min is null
        or p_grant_size_min <= 0
        or m.avg_grant_size >= p_grant_size_min
      )
      and (
        p_grant_size_max is null
        or p_grant_size_max <= 0
        or m.avg_grant_size <= p_grant_size_max
      )
      and (
        cardinality(p.locations_served) = 0
        or m.search_vector @@ websearch_to_tsquery('english', array_to_string(p.locations_served, ' OR '))
      )
      and (
        cardinality(p.ntee_codes) = 0
        or exists (
          select 1
          from ntee_match nm
          where nm.foundation_id = m.funder_id
        )
      )
  )
  select
    f.funder_id::text,
    f.ein::text,
    f.name::text,
    f.state::text,
    f.entity_type::text,
    f.ntee_code::text,
    f.total_giving::numeric,
    f.avg_grant_size::numeric,
    f.grant_count::bigint,
    f.grant_range_min::integer,
    f.grant_range_max::integer,
    count(*) over ()::bigint as total_count
  from filtered f
  order by
    case when p_sort_by = 'name' and lower(p_sort_order) = 'asc' then f.name end asc nulls last,
    case when p_sort_by = 'name' and lower(p_sort_order) = 'desc' then f.name end desc nulls last,
    case when p_sort_by = 'state' and lower(p_sort_order) = 'asc' then f.state end asc nulls last,
    case when p_sort_by = 'state' and lower(p_sort_order) = 'desc' then f.state end desc nulls last,
    case when p_sort_by = 'entity_type' and lower(p_sort_order) = 'asc' then f.entity_type end asc nulls last,
    case when p_sort_by = 'entity_type' and lower(p_sort_order) = 'desc' then f.entity_type end desc nulls last,
    case when p_sort_by = 'avg_grant_size' and lower(p_sort_order) = 'asc' then f.avg_grant_size end asc nulls last,
    case when p_sort_by = 'avg_grant_size' and lower(p_sort_order) = 'desc' then f.avg_grant_size end desc nulls last,
    case when p_sort_by = 'grant_count' and lower(p_sort_order) = 'asc' then f.grant_count end asc nulls last,
    case when p_sort_by = 'grant_count' and lower(p_sort_order) = 'desc' then f.grant_count end desc nulls last,
    case when p_sort_by = 'total_giving' and lower(p_sort_order) = 'asc' then f.total_giving end asc nulls last,
    case when p_sort_by = 'total_giving' and lower(p_sort_order) = 'desc' then f.total_giving end desc nulls last,
    f.total_giving desc nulls last,
    f.name asc nulls last
  offset v_offset
  limit v_per_page;
end;
$$;

grant execute on function public.filter_funders_grant_level(
  text, text, text, text, numeric, numeric, text, text, text, integer, integer
) to anon, authenticated;
