-- Fix search scoring: "foundation" was a stop word so "Ford Foundation" only matched on "ford".
-- All orgs with "Ford" scored equally. Now we:
-- 1. Use ALL query words (including stop words) for full-phrase matching
-- 2. Give a big bonus for containing the full query phrase as a substring
-- 3. Give a bonus for exact name match (ignoring common prefixes like "THE")
-- 4. Match on all words (not just distinctive ones) for word-count scoring

CREATE OR REPLACE FUNCTION public.search_organizations(p_query text, p_limit integer DEFAULT 15)
RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $function$
DECLARE
  v_query_lower text;
  v_all_words text[];
  v_distinctive text[];
  v_stop text[] := ARRAY['the','of','for','and','a','an','inc','llc','co','org','corp'];
  w text;
  v_pattern text;
BEGIN
  v_query_lower := lower(trim(p_query));

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

  -- Split into all words (for phrase matching) and distinctive words (for filtering)
  v_all_words := string_to_array(v_query_lower, ' ');
  v_distinctive := ARRAY[]::text[];
  FOREACH w IN ARRAY v_all_words LOOP
    IF length(w) >= 2 AND NOT (w = ANY(v_stop)) THEN
      v_distinctive := array_append(v_distinctive, w);
    END IF;
  END LOOP;

  -- If no distinctive words, use the full query
  IF array_length(v_distinctive, 1) IS NULL OR array_length(v_distinctive, 1) = 0 THEN
    v_distinctive := ARRAY[v_query_lower];
  END IF;

  -- Primary filter pattern from first distinctive word
  v_pattern := '%' || v_distinctive[1] || '%';

  RETURN QUERY
  WITH funder_hits AS (
    SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
      'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(f.name), dw) > 0) AS _word_hits
    FROM funders f
    WHERE lower(f.name) ILIKE v_pattern
    LIMIT 500
  ),
  recipient_hits AS (
    SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text,
      'recipient'::text, coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(r.name), dw) > 0)
    FROM recipient_organizations r
    WHERE lower(r.name) ILIKE v_pattern
    LIMIT 500
  ),
  combined AS (
    SELECT * FROM funder_hits
    UNION ALL
    SELECT * FROM recipient_hits
  ),
  scored AS (
    SELECT c.*,
      -- 1. Exact name match (0.50): name equals query, ignoring "THE " prefix
      CASE
        WHEN lower(trim(c._name)) = v_query_lower THEN 0.50
        WHEN regexp_replace(lower(trim(c._name)), '^the\s+', '') = v_query_lower THEN 0.50
        WHEN lower(trim(c._name)) = regexp_replace(v_query_lower, '^the\s+', '') THEN 0.50
        ELSE 0
      END
      -- 2. Full phrase contained in name (0.25): "ford foundation" found in name
      + CASE WHEN strpos(lower(c._name), v_query_lower) > 0 THEN 0.25 ELSE 0 END
      -- 3. All-words match count (0-0.15): how many of ALL query words appear
      + (SELECT count(*)::numeric FROM unnest(v_all_words) aw
         WHERE length(aw) >= 2 AND strpos(lower(c._name), aw) > 0
        ) / GREATEST(array_length(v_all_words, 1), 1) * 0.15
      -- 4. Funding tiebreaker (0-0.05)
      + CASE WHEN c._tf > 0 THEN LEAST(ln(c._tf + 1) / 24.0 * 0.05, 0.05) ELSE 0 END
      -- 5. Funder preference (0.05)
      + CASE WHEN c._etype = 'funder' THEN 0.05 ELSE 0 END
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
