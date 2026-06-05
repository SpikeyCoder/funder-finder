-- FM-IC-DSC-004: Discrete "use of funds" (funding type) filter
--
-- The Browse/Discovery FilterPanel already exposes a "Funding Type" facet
-- (General Operating / Project-Program / Capital / Capacity Building) and the
-- frontend sends filters.funding_types, but the filter-funders edge function
-- dropped it on the floor (`funding_types: _funding_types`) so it had no effect
-- — discovery fell back to free-text matching on purpose. This migration makes
-- it a real, indexed filter, mirroring the existing NTEE / location profile
-- pattern (precompute per-foundation tokens, GIN array-overlap at query time).
--
-- 990 grant rows do not carry a structured "use of funds" field, so we derive
-- it from foundation_grants.purpose_text via keyword classification. A grant
-- can map to more than one bucket; we keep the union per foundation.

create table if not exists public.foundation_grant_funding_type_profiles (
  foundation_id text primary key references public.funders(id) on delete cascade,
  funding_type_tokens text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_foundation_grant_funding_type_profiles_tokens
  on public.foundation_grant_funding_type_profiles using gin (funding_type_tokens);

create or replace function public.refresh_foundation_grant_funding_type_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.foundation_grant_funding_type_profiles;

  insert into public.foundation_grant_funding_type_profiles (foundation_id, funding_type_tokens, updated_at)
  with classified as (
    select
      fg.foundation_id,
      lower(coalesce(fg.purpose_text, '')) as p
    from public.foundation_grants fg
  ),
  tokenized as (
    select
      foundation_id,
      unnest(
        array_remove(
          array[
            -- General operating / unrestricted support
            case when p ~ '(general operating|general support|operating support|unrestricted|core support|core operating|general fund|general purpose|annual fund)'
                 then 'general_operating' end,
            -- Capital: buildings, equipment, construction, facilities
            case when p ~ '(capital|construction|renovation|building fund|facilit|infrastructure|equipment|real estate|acquisition of|purchase of|vehicle|land |endowment)'
                 then 'capital' end,
            -- Capacity building / organizational development
            case when p ~ '(capacity building|capacity-building|organizational development|organisational development|technical assistance|strategic planning|professional development|board development|leadership development)'
                 then 'capacity_building' end,
            -- Project / program support (default-ish bucket for restricted gifts)
            case when p ~ '(project|program|programme|initiative|campaign|pilot|scholarship|fellowship|research|services|outreach)'
                 then 'project_program' end
          ],
          null
        )
      ) as token
    from classified
  )
  select
    foundation_id,
    array_agg(distinct token order by token) as funding_type_tokens,
    now() as updated_at
  from tokenized
  group by foundation_id;
end;
$$;

-- Initial backfill for existing data.
select public.refresh_foundation_grant_funding_type_profiles();

-- Recreate filter_funders_grant_level with an added p_funding_types_csv param.
-- Drop the prior 11-arg signature first (CREATE OR REPLACE cannot change arity).
drop function if exists public.filter_funders_grant_level(
  text, text, text, text, numeric, numeric, text, text, text, integer, integer
);

create or replace function public.filter_funders_grant_level(
  p_query text default null,
  p_states_csv text default '',
  p_ntee_codes_csv text default '',
  p_funder_types_csv text default '',
  p_grant_size_min numeric default null,
  p_grant_size_max numeric default null,
  p_locations_served_csv text default '',
  p_funding_types_csv text default '',
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
          select upper(trim(v))
          from unnest(string_to_array(nullif(p_locations_served_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as locations_served,
      coalesce(
        array(
          select lower(trim(v))
          from unnest(string_to_array(nullif(p_funding_types_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as funding_types
  ),
  ntee_match as (
    select gp.foundation_id
    from parsed p
    join public.foundation_grant_ntee_profiles gp
      on cardinality(p.ntee_codes) > 0
     and gp.ntee_prefixes && p.ntee_codes
  ),
  location_match as (
    select glp.foundation_id
    from parsed p
    join public.foundation_grant_location_profiles glp
      on cardinality(p.locations_served) > 0
     and glp.location_tokens && p.locations_served
  ),
  funding_type_match as (
    select fp.foundation_id
    from parsed p
    join public.foundation_grant_funding_type_profiles fp
      on cardinality(p.funding_types) > 0
     and fp.funding_type_tokens && p.funding_types
  ),
  filtered as (
    select
      m.*
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
        or exists (
          select 1
          from location_match lm
          where lm.foundation_id = m.funder_id
        )
      )
      and (
        cardinality(p.ntee_codes) = 0
        or exists (
          select 1
          from ntee_match nm
          where nm.foundation_id = m.funder_id
        )
      )
      and (
        cardinality(p.funding_types) = 0
        or exists (
          select 1
          from funding_type_match fm
          where fm.foundation_id = m.funder_id
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
  text, text, text, text, numeric, numeric, text, text, text, text, integer, integer
) to anon, authenticated;
