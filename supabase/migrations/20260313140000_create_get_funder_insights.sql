-- Fix: Compute funder 990 insights server-side via SQL function
--
-- Problems fixed:
--   1. PostgREST 1000-row default limit truncated large funders' grant data,
--      causing the edge function to only see the most recent year's grants.
--      E.g., Walton Foundation (4,476 grants across 4 years) only showed 1,000
--      grants from 2024, making all grantees appear in one year = 0 repeats.
--
--   2. "Repeat grantee" was defined as "existed before the 5-year window" but
--      since all grant data is from 2020-2024 and the window starts at 2021,
--      nearly every grantee's first year was within the window → all "new."
--      Fixed: repeat = grantee who received grants in MORE THAN ONE year.
--
-- Solution: Created a PostgreSQL function that computes all aggregates
-- (year trends, grantee analysis, geographic footprint, key recipients,
-- grant purposes, data quality) directly in SQL. The edge function now
-- calls this via RPC instead of fetching raw rows.

CREATE OR REPLACE FUNCTION public.get_funder_insights(p_funder_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_result jsonb;
  v_current_year int := extract(year from now())::int;
  v_min_year int := v_current_year - 10;
  v_recent_cutoff int := v_current_year - 5;
  v_total_grants bigint;
BEGIN
  -- Check if funder has any grants
  SELECT count(*) INTO v_total_grants
  FROM foundation_grants
  WHERE foundation_id = p_funder_id AND grant_year >= v_min_year;

  IF v_total_grants = 0 THEN
    RETURN jsonb_build_object(
      'funderId', p_funder_id,
      'grantHistory', jsonb_build_object('totalGrants', 0, 'totalAmount', 0, 'yearTrend', '[]'::jsonb),
      'granteeAnalysis', jsonb_build_object('totalGrantees5y', 0, 'newGrantees', 0, 'repeatGrantees', 0, 'pctRepeat', 0),
      'geographicFootprint', '[]'::jsonb,
      'keyRecipients', '[]'::jsonb,
      'recentGrantPurposes', '[]'::jsonb,
      'dataQuality', jsonb_build_object('completenessScore', 0, 'totalRecords', 0)
    );
  END IF;

  WITH all_grants AS (
    SELECT grant_year, grant_amount, grantee_name, grantee_ein, grantee_state, purpose_text
    FROM foundation_grants
    WHERE foundation_id = p_funder_id AND grant_year >= v_min_year
  ),
  -- 1. Year trends
  year_agg AS (
    SELECT grant_year,
      count(*) as grant_count,
      coalesce(sum(grant_amount), 0)::bigint as total_amount,
      CASE WHEN count(*) > 0 THEN round(coalesce(sum(grant_amount), 0) / count(*))::bigint ELSE 0 END as avg_grant
    FROM all_grants
    GROUP BY grant_year
    ORDER BY grant_year
  ),
  year_trend_json AS (
    SELECT jsonb_agg(jsonb_build_object(
      'year', grant_year,
      'grantCount', grant_count,
      'totalAmount', total_amount,
      'avgGrant', avg_grant
    ) ORDER BY grant_year) as data
    FROM year_agg
  ),  -- 2. Grantee analysis: a "repeat grantee" received grants in MORE THAN ONE year
  grantee_keys AS (
    SELECT
      COALESCE(NULLIF(grantee_ein, ''), upper(regexp_replace(grantee_name, '[^A-Za-z0-9]', '', 'g'))) as gkey,
      grant_year
    FROM all_grants
    WHERE grant_year >= v_recent_cutoff
  ),
  grantee_year_counts AS (
    SELECT gkey, count(DISTINCT grant_year) as years_active
    FROM grantee_keys
    GROUP BY gkey
  ),
  grantee_stats AS (
    SELECT
      count(*) as total_grantees_5y,
      count(*) FILTER (WHERE years_active > 1) as repeat_grantees,
      count(*) FILTER (WHERE years_active = 1) as new_grantees
    FROM grantee_year_counts
  ),
  -- 3. Geographic footprint (recent 5 years)
  geo_agg AS (
    SELECT
      upper(trim(grantee_state)) as state,
      count(*) as grant_count,
      coalesce(sum(grant_amount), 0)::bigint as total_amount
    FROM all_grants
    WHERE grant_year >= v_recent_cutoff AND grantee_state IS NOT NULL AND trim(grantee_state) <> ''
    GROUP BY upper(trim(grantee_state))
    ORDER BY count(*) DESC
    LIMIT 15
  ),
  geo_total AS (
    SELECT sum(grant_count)::bigint as total FROM geo_agg
  ),
  geo_json AS (
    SELECT jsonb_agg(jsonb_build_object(
      'state', g.state,
      'grantCount', g.grant_count,
      'totalAmount', g.total_amount,
      'pctOfGrants', CASE WHEN gt.total > 0 THEN round((g.grant_count::numeric / gt.total) * 100)::int ELSE 0 END
    ) ORDER BY g.grant_count DESC) as data
    FROM geo_agg g, geo_total gt
  ),
  -- 4. Key recipients (all years)
  recipient_agg AS (
    SELECT
      COALESCE(NULLIF(grantee_ein, ''), upper(regexp_replace(grantee_name, '[^A-Za-z0-9]', '', 'g'))) as gkey,
      max(grantee_ein) as ein,
      max(grantee_name) as name,
      count(*) as grant_count,
      coalesce(sum(grant_amount), 0)::bigint as total_amount,
      max(grant_year) as last_year
    FROM all_grants
    GROUP BY gkey
    ORDER BY coalesce(sum(grant_amount), 0) DESC
    LIMIT 20
  ),
  recipients_json AS (
    SELECT jsonb_agg(jsonb_build_object(
      'granteeEin', ein,
      'granteeName', name,
      'grantCount', grant_count,
      'totalAmount', total_amount,
      'lastYear', last_year
    ) ORDER BY total_amount DESC) as data
    FROM recipient_agg
  ),  -- 5. Recent grant purposes
  purposes AS (
    SELECT DISTINCT ON (left(upper(trim(purpose_text)), 60))
      purpose_text as purpose,
      grantee_name,
      grant_amount as amount,
      grant_year as year
    FROM all_grants
    WHERE purpose_text IS NOT NULL AND length(trim(purpose_text)) >= 10
    ORDER BY left(upper(trim(purpose_text)), 60), grant_year DESC
    LIMIT 25
  ),
  purposes_json AS (
    SELECT jsonb_agg(jsonb_build_object(
      'purpose', purpose,
      'granteeName', grantee_name,
      'amount', amount,
      'year', year
    ) ORDER BY year DESC) as data
    FROM purposes
  ),
  -- 6. Data quality
  quality AS (
    SELECT
      count(*) as total_records,
      round(
        (count(*) FILTER (WHERE grant_amount IS NOT NULL)::numeric / GREATEST(count(*), 1)) * 25 +
        (count(*) FILTER (WHERE grantee_ein IS NOT NULL AND grantee_ein <> '')::numeric / GREATEST(count(*), 1)) * 25 +
        (count(*) FILTER (WHERE grantee_state IS NOT NULL AND grantee_state <> '')::numeric / GREATEST(count(*), 1)) * 25 +
        (count(*) FILTER (WHERE purpose_text IS NOT NULL AND purpose_text <> '')::numeric / GREATEST(count(*), 1)) * 25
      )::int as completeness_score
    FROM all_grants
  ),
  last_year_data AS (
    SELECT max(grant_year) as last_year FROM year_agg
  )
  SELECT jsonb_build_object(
    'funderId', p_funder_id,
    'grantHistory', jsonb_build_object(
      'totalGrants', v_total_grants,
      'totalAmount', (SELECT coalesce(sum(total_amount), 0) FROM year_agg),
      'yearTrend', coalesce((SELECT data FROM year_trend_json), '[]'::jsonb)
    ),
    'granteeAnalysis', jsonb_build_object(
      'totalGrantees5y', gs.total_grantees_5y,
      'newGrantees', gs.new_grantees,
      'repeatGrantees', gs.repeat_grantees,
      'pctRepeat', CASE WHEN gs.total_grantees_5y > 0 THEN round((gs.repeat_grantees::numeric / gs.total_grantees_5y) * 100)::int ELSE 0 END
    ),
    'geographicFootprint', coalesce((SELECT data FROM geo_json), '[]'::jsonb),
    'keyRecipients', coalesce((SELECT data FROM recipients_json), '[]'::jsonb),
    'recentGrantPurposes', coalesce((SELECT data FROM purposes_json), '[]'::jsonb),
    'dataQuality', jsonb_build_object('completenessScore', q.completeness_score, 'totalRecords', q.total_records),
    'dataAsOf', CASE WHEN ly.last_year IS NOT NULL THEN ly.last_year::text || ' IRS 990-PF filings' ELSE null END
  ) INTO v_result
  FROM grantee_stats gs, quality q, last_year_data ly;

  RETURN v_result;
END;
$function$;
