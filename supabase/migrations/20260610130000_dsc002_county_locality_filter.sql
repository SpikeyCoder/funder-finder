-- =====================================================================
-- FM-IC-DSC-002: Filter discovery by sub-state locality (county / city)
--
-- Audit finding: Browse/Discovery only supported state-level location
-- filtering ("State only"), while Instrumentl lets users narrow funders
-- to a county/city. The org profile already captures county-level location
-- (FM-IC-ONB-003); this migration brings the same granularity to the
-- funder-discovery side so a user can find funders that actually give in
-- their county/city.
--
-- 990 grant rows store grantee geography as grantee_city + grantee_state
-- (there is no structured county column). We therefore derive a per-
-- foundation set of "locality tokens" from the cities a foundation has
-- funded in. Where a 990 records county-level geography in the city field
-- (common, e.g. "LOS ANGELES COUNTY"), county queries match directly.
--
-- Pattern mirrors the existing foundation_grant_location_profiles /
-- foundation_grant_funding_type_profiles facets: precompute normalized
-- tokens per foundation, GIN-index them, and array-overlap at query time.
-- =====================================================================

create table if not exists public.foundation_grant_locality_profiles (
  foundation_id text primary key references public.funders(id) on delete cascade,
  locality_tokens text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_foundation_grant_locality_profiles_tokens
  on public.foundation_grant_locality_profiles using gin (locality_tokens);

create or replace function public.refresh_foundation_grant_locality_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.foundation_grant_locality_profiles;

  insert into public.foundation_grant_locality_profiles (foundation_id, locality_tokens, updated_at)
  with normalized as (
    select
      fg.foundation_id,
      nullif(
        upper(
          trim(
            regexp_replace(
              regexp_replace(coalesce(fg.grantee_city, ''), '\s+', ' ', 'g'),
              '[\.,;:]+$',
              '',
              'g'
            )
          )
        ),
        ''
      ) as city_token,
      nullif(upper(trim(coalesce(fg.grantee_state, ''))), '') as state_token
    from public.foundation_grants fg
  ),
  tokens as (
    select
      foundation_id,
      unnest(
        array_remove(
          array[
            city_token,
            case
              when city_token is not null and state_token is not null
              then city_token || ', ' || state_token
            end
          ],
          null
        )
      ) as token
    from normalized
    where city_token is not null
  )
  select
    foundation_id,
    array_agg(distinct token order by token) as locality_tokens,
    now() as updated_at
  from tokens
  group by foundation_id;
end;
$$;

-- Initial backfill for existing data.
select public.refresh_foundation_grant_locality_profiles();

-- ---------------------------------------------------------------------
-- Recreate filter_funders_grant_level with an added p_localities_csv param.
-- CREATE OR REPLACE cannot change arity, so drop the prior 12-arg signature.
-- ---------------------------------------------------------------------
drop function if exists public.filter_funders_grant_level(
  text, text, text, text, numeric, numeric, text, text, text, text, integer, integer
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
  p_localities_csv text default '',
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
      ) as funding_types,
      coalesce(
        array(
          select upper(trim(v))
          from unnest(string_to_array(nullif(p_localities_csv, ''), ',')) as v
          where trim(v) <> ''
        ),
        array[]::text[]
      ) as localities
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
  locality_match as (
    select lp.foundation_id
    from parsed p
    join public.foundation_grant_locality_profiles lp
      on cardinality(p.localities) > 0
     and (
       lp.locality_tokens && p.localities
       or exists (
         select 1
         from unnest(lp.locality_tokens) as lt
         join unnest(p.localities) as req on lt like '%' || req || '%'
       )
     )
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
      and (
        cardinality(p.localities) = 0
        or exists (
          select 1
          from locality_match lcm
          where lcm.foundation_id = m.funder_id
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
  text, text, text, text, numeric, numeric, text, text, text, text, text, integer, integer
) to anon, authenticated;
