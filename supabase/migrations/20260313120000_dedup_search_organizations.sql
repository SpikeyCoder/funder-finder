-- Fix: Deduplicate search results by normalized EIN
--
-- Problem: Organizations with the same EIN appeared multiple times because:
--   1. The funders table contains ~1,275 EIN pairs where the same org exists
--      with and without a leading zero (e.g. '61458630' and '061458630')
--   2. ~94,676 EINs exist in both the funders and recipient_organizations tables
--   3. The old function used UNION ALL with no deduplication
--
-- Fix: Added a deduped CTE that uses DISTINCT ON (lpad(ein, 9, '0')) to
-- normalize EINs to 9-digit padded form and keep only the best row per EIN.
-- Tiebreaker: highest relevance score > prefer funder over recipient > highest total_funding.

CREATE OR REPLACE FUNCTION public.search_organizations(p_query text, p_limit integer DEFAULT 15)
 RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_words text[];
  v_distinctive text[];
  v_filter_query text;
  v_stop text[] := ARRAY['the','of','for','and','a','an','inc','llc','co','org','corp',
                          'foundation','trust','fund','charitable','family','society',
                          'association','institute','national','international','american'];
  w text;
BEGIN
  v_words := string_to_array(lower(trim(p_query)), ' ');
  v_distinctive := ARRAY[]::text[];
  FOREACH w IN ARRAY v_words LOOP
    IF length(w) >= 2 AND NOT (w = ANY(v_stop)) THEN
      v_distinctive := array_append(v_distinctive, w);
    END IF;
  END LOOP;

  -- Build filter query from distinctive words only
  IF array_length(v_distinctive, 1) > 0 THEN
    v_filter_query := array_to_string(v_distinctive, ' ');
  ELSE
    v_filter_query := lower(trim(p_query));
  END IF;

  RETURN QUERY
  WITH ein_match AS (
    SELECT f.id AS _id, f.id AS _ein, f.name AS _name, f.state AS _state,
      'funder'::text AS _etype, f.grant_count::bigint AS _gc,
      coalesce(f.total_grant_amount, f.total_giving, 0)::numeric AS _tf, 1.0::numeric AS _rel
    FROM funders f WHERE p_query ~ '^\d{9}$' AND f.id = p_query
    UNION ALL
    SELECT r.id::text, r.ein, r.name, r.primary_state, 'recipient'::text,
      r.grant_count::bigint, coalesce(r.total_funding, 0), 1.0::numeric
    FROM recipient_organizations r WHERE p_query ~ '^\d{9}$' AND r.ein = p_query
  ),
  -- Stage 1: Fast filter using <<% on distinctive words only (small candidate set)
  funder_candidates AS (
    SELECT f.id AS _id, f.id AS _ein, f.name AS _name, f.state AS _state,
      f.grant_count::bigint AS _gc,
      coalesce(f.total_grant_amount, f.total_giving, 0)::numeric AS _tf,
      word_similarity(p_query, f.name) AS _wsim,
      f.ntee_code AS _ntee, f.city AS _city, f.website AS _website
    FROM funders f
    WHERE NOT (p_query ~ '^\d{9}$') AND v_filter_query <<% f.name
    ORDER BY word_similarity(p_query, f.name) DESC, f.grant_count DESC NULLS LAST
    LIMIT 200
  ),
  recipient_candidates AS (
    SELECT r.id::text AS _id, r.ein AS _ein, r.name AS _name, r.primary_state AS _state,
      r.grant_count::bigint AS _gc,
      coalesce(r.total_funding, 0)::numeric AS _tf,
      word_similarity(p_query, r.name) AS _wsim
    FROM recipient_organizations r
    WHERE NOT (p_query ~ '^\d{9}$') AND v_filter_query <<% r.name
    ORDER BY word_similarity(p_query, r.name) DESC, r.grant_count DESC NULLS LAST
    LIMIT 200
  ),
  -- Stage 2: Full scoring on small candidate sets
  scored_funders AS (
    SELECT fc._id, fc._ein, fc._name, fc._state, 'funder'::text AS _etype,
      fc._gc, fc._tf,
      fc._wsim * 0.50
        + CASE WHEN array_length(v_distinctive, 1) > 0 THEN
            0.15 * (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(fc._name), dw) > 0)
            / array_length(v_distinctive, 1) ELSE 0 END
        + CASE WHEN fc._ntee IS NOT NULL THEN 0.02 ELSE 0 END
        + CASE WHEN fc._city IS NOT NULL THEN 0.015 ELSE 0 END
        + CASE WHEN fc._website IS NOT NULL THEN 0.015 ELSE 0 END
        + CASE WHEN fc._gc > 0 THEN LEAST(ln(fc._gc::numeric + 1) / 11.5 * 0.20, 0.20) ELSE 0 END
        + CASE WHEN fc._tf > 0 THEN LEAST(ln(fc._tf::numeric + 1) / 24.0 * 0.10, 0.10) ELSE 0 END
        - CASE WHEN fc._gc = 0 AND fc._ntee IS NULL AND fc._city IS NULL AND fc._website IS NULL THEN 0.20 ELSE 0 END
      AS _rel
    FROM funder_candidates fc
  ),
  scored_recipients AS (
    SELECT rc._id, rc._ein, rc._name, rc._state, 'recipient'::text AS _etype,
      rc._gc, rc._tf,
      rc._wsim * 0.50
        + CASE WHEN array_length(v_distinctive, 1) > 0 THEN
            0.15 * (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(rc._name), dw) > 0)
            / array_length(v_distinctive, 1) ELSE 0 END
        + CASE WHEN rc._gc > 0 THEN LEAST(ln(rc._gc::numeric + 1) / 11.5 * 0.18, 0.18) ELSE 0 END
        + CASE WHEN rc._tf > 0 THEN LEAST(ln(rc._tf::numeric + 1) / 24.0 * 0.08, 0.08) ELSE 0 END
      AS _rel
    FROM recipient_candidates rc
  ),
  -- Combine all sources
  combined AS (
    SELECT * FROM ein_match
    UNION ALL
    SELECT * FROM scored_funders
    UNION ALL
    SELECT * FROM scored_recipients
  ),
  -- Deduplicate: normalize EIN with leading-zero padding, keep best row per EIN
  -- Priority: highest relevance, then prefer funder over recipient, then highest total_funding
  deduped AS (
    SELECT DISTINCT ON (lpad(c._ein, 9, '0'))
      c._id, c._ein, c._name, c._state, c._etype, c._gc, c._tf, c._rel
    FROM combined c
    ORDER BY lpad(c._ein, 9, '0'),
             c._rel DESC,
             CASE WHEN c._etype = 'funder' THEN 0 ELSE 1 END,
             c._tf DESC
  )
  SELECT d._id, d._ein, d._name, d._state, d._etype, d._gc, d._tf
  FROM deduped d
  ORDER BY d._rel DESC, d._tf DESC
  LIMIT p_limit;
END;
$function$;
