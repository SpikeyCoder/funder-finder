-- Fix Browse Grants international-location filtering to use grant geography
-- instead of keyword matching against funder text vectors.

create table if not exists public.foundation_grant_location_profiles (
  foundation_id text primary key references public.funders(id) on delete cascade,
  location_tokens text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_foundation_grant_location_profiles_tokens
  on public.foundation_grant_location_profiles using gin (location_tokens);

create or replace function public.refresh_foundation_grant_location_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.foundation_grant_location_profiles;

  insert into public.foundation_grant_location_profiles (foundation_id, location_tokens, updated_at)
  with raw_grants as (
    select
      fg.foundation_id,
      upper(
        trim(
          regexp_replace(
            regexp_replace(coalesce(fg.grantee_country, ''), '\s+', ' ', 'g'),
            '[\.,;:]+',
            '',
            'g'
          )
        )
      ) as country_raw
    from public.foundation_grants fg
  ),
  mapped as (
    select
      foundation_id,
      country_raw,
      case
        when country_raw = '' then null
        when country_raw like '%GLOBAL%' or country_raw like '%WORLDWIDE%' or country_raw like '%INTERNATIONAL%' then null
        when country_raw in ('US', 'USA', 'U.S.', 'U.S.A.', 'UNITED STATES', 'UNITED STATES OF AMERICA') then 'UNITED STATES'
        when country_raw like '%CANADA%' then 'CANADA'
        when country_raw like '%BRAZIL%' then 'BRAZIL'
        when country_raw like '%CHINA%' then 'CHINA'
        when country_raw like '%COLOMBIA%' then 'COLOMBIA'
        when country_raw like '%ETHIOPIA%' then 'ETHIOPIA'
        when country_raw like '%GHANA%' then 'GHANA'
        when country_raw like '%INDIA%' then 'INDIA'
        when country_raw like '%INDONESIA%' then 'INDONESIA'
        when country_raw like '%KENYA%' then 'KENYA'
        when country_raw like '%MEXICO%' then 'MEXICO'
        when country_raw like '%NIGERIA%' then 'NIGERIA'
        when country_raw like '%PAKISTAN%' then 'PAKISTAN'
        when country_raw like '%PHILIPPINES%' then 'PHILIPPINES'
        when country_raw like '%RWANDA%' then 'RWANDA'
        when country_raw like '%SOUTH AFRICA%' then 'SOUTH AFRICA'
        when country_raw like '%TANZANIA%' then 'TANZANIA'
        when country_raw like '%UGANDA%' then 'UGANDA'
        when country_raw like '%UNITED KINGDOM%' or country_raw in ('UK', 'GREAT BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND') then 'UNITED KINGDOM'
        when country_raw like '%VIETNAM%' then 'VIETNAM'
        when country_raw like '%ZIMBABWE%' then 'ZIMBABWE'
        else null
      end as canonical_country,
      case
        when country_raw in ('', 'US', 'USA', 'U.S.', 'U.S.A.', 'UNITED STATES', 'UNITED STATES OF AMERICA') then false
        when country_raw like '%GLOBAL%' or country_raw like '%WORLDWIDE%' or country_raw like '%INTERNATIONAL%' then true
        else true
      end as is_non_us,
      case
        when country_raw like '%LATIN AMERICA%' then 'LATIN AMERICA'
        when country_raw like '%CARIBBEAN%' then 'CARIBBEAN'
        when country_raw like '%MIDDLE EAST%' then 'MIDDLE EAST'
        when country_raw like '%NORTH AFRICA%' then 'MIDDLE EAST'
        when country_raw like '%SUB-SAHARAN AFRICA%' then 'AFRICA'
        when country_raw like '%OCEANIA%' then 'OCEANIA'
        when country_raw like '%EUROPE%' then 'EUROPE'
        when country_raw like '%ASIA%' then 'ASIA'
        when country_raw like '%AFRICA%' then 'AFRICA'
        when country_raw like '%CANADA%' then 'NORTH AMERICA'
        when country_raw like '%MEXICO%' then 'LATIN AMERICA'
        when country_raw like '%BRAZIL%' or country_raw like '%COLOMBIA%' then 'LATIN AMERICA'
        when country_raw like '%CHINA%' or country_raw like '%INDIA%' or country_raw like '%INDONESIA%' or country_raw like '%PAKISTAN%' or country_raw like '%PHILIPPINES%' or country_raw like '%VIETNAM%' then 'ASIA'
        when country_raw like '%ETHIOPIA%' or country_raw like '%GHANA%' or country_raw like '%KENYA%' or country_raw like '%NIGERIA%' or country_raw like '%RWANDA%' or country_raw like '%SOUTH AFRICA%' or country_raw like '%TANZANIA%' or country_raw like '%UGANDA%' or country_raw like '%ZIMBABWE%' then 'AFRICA'
        when country_raw like '%UNITED KINGDOM%' or country_raw in ('UK', 'GREAT BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND') then 'EUROPE'
        when country_raw like '%SAUDI ARABIA%' or country_raw like '%UNITED ARAB EMIRATES%' or country_raw like '%UAE%' or country_raw like '%QATAR%' or country_raw like '%OMAN%' or country_raw like '%KUWAIT%' or country_raw like '%BAHRAIN%' or country_raw like '%JORDAN%' or country_raw like '%LEBANON%' or country_raw like '%IRAQ%' or country_raw like '%IRAN%' or country_raw like '%SYRIA%' or country_raw like '%YEMEN%' or country_raw like '%ISRAEL%' or country_raw like '%PALESTIN%' or country_raw like '%TURKEY%' then 'MIDDLE EAST'
        when country_raw like '%JAMAICA%' or country_raw like '%HAITI%' or country_raw like '%BAHAMAS%' or country_raw like '%BARBADOS%' or country_raw like '%TRINIDAD%' or country_raw like '%TOBAGO%' or country_raw like '%DOMINICAN REPUBLIC%' or country_raw like '%PUERTO RICO%' or country_raw like '%CUBA%' or country_raw like '%GRENADA%' or country_raw like '%SAINT LUCIA%' or country_raw like '%ANTIGUA%' then 'CARIBBEAN'
        when country_raw like '%AUSTRALIA%' or country_raw like '%NEW ZEALAND%' or country_raw like '%FIJI%' or country_raw like '%PAPUA NEW GUINEA%' or country_raw like '%SAMOA%' or country_raw like '%TONGA%' then 'OCEANIA'
        else null
      end as region_token
    from raw_grants
  ),
  exploded as (
    select
      m.foundation_id,
      unnest(
        array_remove(
          array[
            m.canonical_country,
            m.region_token,
            case
              when m.country_raw like '%GLOBAL%'
                or m.country_raw like '%WORLDWIDE%'
                or m.country_raw like '%INTERNATIONAL%'
              then 'GLOBAL'
              when m.is_non_us then 'INTERNATIONAL'
            end,
            case when m.is_non_us then 'GLOBAL' end,
            case when m.is_non_us then 'WORLDWIDE' end,
            case
              when m.country_raw like '%GLOBAL%'
                or m.country_raw like '%WORLDWIDE%'
                or m.country_raw like '%INTERNATIONAL%'
              then 'INTERNATIONAL'
            end
          ],
          null
        )
      ) as token
    from mapped m
  )
  select
    foundation_id,
    array_agg(distinct token order by token),
    now()
  from exploded
  group by foundation_id;
end;
$$;

-- Backfill profiles for existing grant data.
select public.refresh_foundation_grant_location_profiles();

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
          select upper(trim(v))
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
  location_match as (
    select glp.foundation_id
    from parsed p
    join public.foundation_grant_location_profiles glp
      on cardinality(p.locations_served) > 0
     and glp.location_tokens && p.locations_served
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
