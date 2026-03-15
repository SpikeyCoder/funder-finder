-- BUG-010: Replace search_organizations function to use ILIKE instead of pg_trgm operators
-- The pg_trgm extension may not be available, causing the function to fail
-- This migration replaces the trigram-based search with ILIKE pattern matching

CREATE OR REPLACE FUNCTION public.search_organizations(p_query text, p_limit integer DEFAULT 15)
RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $function$
DECLARE
  v_words text[];
  v_distinctive text[];
  v_stop text[] := ARRAY['the','of','for','and','a','an','inc','llc','co','org','corp',
                          'foundation','trust','fund','charitable','family','society',
                          'association','institute','national','international','american'];
  w text;
  v_pattern text;
BEGIN
  -- Handle EIN lookup (exact match on 7-9 digit numbers)
  IF p_query ~ '^\d{7,9}$' THEN
    RETURN QUERY
    SELECT f.id::text, f.id::text, f.name::text, f.state::text, 'funder'::text,
           0::bigint, coalesce(f.total_giving, 0)::numeric
    FROM funders f WHERE f.id = p_query
    UNION ALL
    SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text, 'recipient'::text,
           coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric
    FROM recipient_organizations r WHERE r.ein = p_query
    LIMIT p_limit;
    RETURN;
  END IF;

  -- Extract distinctive words (length >= 2, not in stop word list)
  v_words := string_to_array(lower(trim(p_query)), ' ');
  v_distinctive := ARRAY[]::text[];
  FOREACH w IN ARRAY v_words LOOP
    IF length(w) >= 2 AND NOT (w = ANY(v_stop)) THEN
      v_distinctive := array_append(v_distinctive, w);
    END IF;
  END LOOP;

  -- If no distinctive words found, use the raw query as fallback
  IF array_length(v_distinctive, 1) IS NULL OR array_length(v_distinctive, 1) = 0 THEN
    v_distinctive := ARRAY[lower(trim(p_query))];
  END IF;

  -- Build ILIKE pattern from first distinctive word (primary filter for performance)
  v_pattern := '%' || v_distinctive[1] || '%';

  RETURN QUERY
  WITH funder_hits AS (
    SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
      'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(f.name), dw) > 0) AS _word_hits
    FROM funders f
    WHERE lower(f.name) ILIKE v_pattern
    LIMIT 300
  ),
  recipient_hits AS (
    SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text,
      'recipient'::text, coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(r.name), dw) > 0)
    FROM recipient_organizations r
    WHERE lower(r.name) ILIKE v_pattern
    LIMIT 300
  ),
  combined AS (
    SELECT * FROM funder_hits
    UNION ALL
    SELECT * FROM recipient_hits
  ),
  scored AS (
    SELECT c.*,
      -- Score breakdown:
      -- - Exact full name match bonus (0 or 0.40): huge boost if name matches query exactly
      -- - Whole-word match ratio (0-0.30): words that match as whole words (not substrings)
      -- - Any-word match ratio (0-0.10): partial substring matches
      -- - Funding log scale (0-0.10): logarithmic scale of total_funding
      -- - Type preference (0-0.10): favor funders over recipients
      CASE WHEN lower(trim(c._name)) = lower(trim(p_query)) THEN 0.40 ELSE 0 END
      + (SELECT count(*)::numeric FROM unnest(v_distinctive) dw
         WHERE c._name ~* ('\m' || dw || '\M')) / GREATEST(array_length(v_distinctive, 1), 1) * 0.30
      + (c._word_hits / GREATEST(array_length(v_distinctive, 1), 1)) * 0.10
      + CASE WHEN c._tf > 0 THEN LEAST(ln(c._tf + 1) / 24.0 * 0.10, 0.10) ELSE 0 END
      + CASE WHEN c._etype = 'funder' THEN 0.10 ELSE 0 END
      AS _rel
    FROM combined c
    WHERE c._word_hits > 0
  ),
  deduped AS (
    SELECT DISTINCT ON (lpad(s._ein, 9, '0'))
      s._id, s._ein, s._name, s._state, s._etype, s._gc, s._tf, s._rel
    FROM scored s
    ORDER BY lpad(s._ein, 9, '0'), s._rel DESC
  )
  SELECT d._id, d._ein, d._name, d._state, d._etype, d._gc, d._tf
  FROM deduped d
  ORDER BY d._rel DESC, d._tf DESC
  LIMIT p_limit;
END;
$function$;
