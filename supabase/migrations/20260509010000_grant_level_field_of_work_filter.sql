-- Apply Field of Work filtering at grant level (foundation_grants.ntee_code)
-- so Browse Grants can filter funders by the NTEE profile of their awarded grants.

-- Speeds up EXISTS checks by foundation + ntee prefix.
create index if not exists idx_foundation_grants_foundation_ntee
  on public.foundation_grants (foundation_id, ntee_code)
  where ntee_code is not null;

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
  filtered as (
    select m.*
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
          from public.foundation_grants fg
          where fg.foundation_id = m.funder_id
            and fg.ntee_code is not null
            and exists (
              select 1
              from unnest(p.ntee_codes) as ntee_prefix
              where upper(fg.ntee_code) like ntee_prefix || '%'
            )
        )
      )
  )
  select
    f.funder_id,
    f.ein,
    f.name,
    f.state,
    f.entity_type,
    f.ntee_code,
    f.total_giving,
    f.avg_grant_size,
    f.grant_count,
    f.grant_range_min,
    f.grant_range_max,
    count(*) over () as total_count
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
    -- Stable tie-breaker.
    f.total_giving desc nulls last,
    f.name asc nulls last
  offset v_offset
  limit v_per_page;
end;
$$;

grant execute on function public.filter_funders_grant_level(
  text, text, text, text, numeric, numeric, text, text, text, integer, integer
) to anon, authenticated;
