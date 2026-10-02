-- FM-2026-10-02-01: make search_organizations use its trigram indexes.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDING
-- -------
-- Trello #153: /search intermittently returned {"results":[],"error":"Search
-- failed"} (502). Postgres logged "canceling statement due to statement
-- timeout": the search-organizations Edge Function calls this RPC with the anon
-- key, and anon has statement_timeout = 3s.
--
-- Both candidate filters were written as
--     WHERE lower(f.name) ILIKE v_pattern
--     WHERE lower(r.name) ILIKE v_pattern
-- but the trigram indexes are on the bare column:
--     idx_funders_name_trgm          ON funders USING gin (name gin_trgm_ops)
--     idx_recipient_org_name_trgm2   ON recipient_organizations USING gin (name gin_trgm_ops)
-- An index on name can't serve a predicate on lower(name), so every search
-- sequentially scanned funders (312k rows, ~29k blocks) and
-- recipient_organizations (449k rows). On a cold cache that exceeds 3s.
--
-- FIX
-- ---
-- Drop the redundant lower(): ILIKE is already case-insensitive, so
-- `name ILIKE p` matches exactly the rows `lower(name) ILIKE p` does. Only
-- these two WHERE lines change; the body is otherwise the one from
-- 20260326100000_fix_recipients_showing_as_funders.sql, verified identical
-- (md5 of prosrc) to production on 2026-10-02.
--
-- Measured on production, pattern '%students%' (EXPLAIN ANALYZE):
--   recipient_organizations  1,570 ms seq scan  →  58 ms bitmap index scan (221 rows both)
--   funders                  2,265 ms seq scan  → 137 ms bitmap index scan (144 rows both)
-- Patterns under 3 characters can't use a trigram index and still seq scan,
-- as before.
--
-- CREATE OR REPLACE keeps the function's owner and grants.

CREATE OR REPLACE FUNCTION public.search_organizations(p_query text, p_limit integer DEFAULT 15)
RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $function$
DECLARE
  v_query_lower text;
  v_query_normalized text;
  v_query_spaced text;
  v_first_word text;
  v_all_words text[];
  v_distinctive text[];
  v_stop text[] := ARRAY['the','of','for','and','a','an','inc','llc','co','org','corp'];
  w text;
  v_pattern text;
BEGIN
  v_query_lower := lower(trim(p_query));
  v_query_normalized := regexp_replace(v_query_lower, '^the\s+', '');

  -- Split camelCase/PascalCase: "SitStayRead" → "sit stay read"
  v_query_spaced := lower(regexp_replace(trim(p_query), '([a-z])([A-Z])', '\1 \2', 'g'));
  IF v_query_spaced = v_query_lower THEN
    v_query_spaced := NULL;
  END IF;

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

  -- Split into all words and distinctive words
  v_all_words := string_to_array(coalesce(v_query_spaced, v_query_lower), ' ');
  v_distinctive := ARRAY[]::text[];
  FOREACH w IN ARRAY v_all_words LOOP
    IF length(w) >= 2 AND NOT (w = ANY(v_stop)) THEN
      v_distinctive := array_append(v_distinctive, w);
    END IF;
  END LOOP;

  IF array_length(v_distinctive, 1) IS NULL OR array_length(v_distinctive, 1) = 0 THEN
    v_distinctive := ARRAY[v_query_lower];
  END IF;

  v_pattern := '%' || v_distinctive[1] || '%';
  v_first_word := v_all_words[1];

  RETURN QUERY
  WITH funder_hits AS (
    -- FIXED: Only include legitimate grantmaking funders (NTEE T-code)
    SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
      'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(f.name), dw) > 0) AS _word_hits
    FROM funders f
    WHERE f.name ILIKE v_pattern  -- bare column so idx_funders_name_trgm applies
      AND (f.ntee_code LIKE 'T%' OR EXISTS (
        SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id
      ))
    LIMIT 500
  ),
  recipient_hits AS (
    SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text,
      'recipient'::text, coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(r.name), dw) > 0)
    FROM recipient_organizations r
    WHERE r.name ILIKE v_pattern  -- bare column so idx_recipient_org_name_trgm2 applies
    LIMIT 500
  ),
  combined AS (
    SELECT * FROM funder_hits
    UNION ALL
    SELECT * FROM recipient_hits
  ),
  scored AS (
    SELECT c.*,
      -- TIER 1: EXACT MATCHES (1.0)
      CASE
        WHEN lower(trim(c._name)) = v_query_lower THEN 1.0
        WHEN regexp_replace(lower(trim(c._name)), '^the\s+', '') = v_query_lower THEN 1.0
        WHEN lower(trim(c._name)) = v_query_normalized THEN 1.0
        ELSE 0
      END
      -- TIER 2: PREFIX MATCHES (0.80)
      + CASE
        WHEN lower(trim(c._name)) LIKE v_first_word || '%' THEN 0.80
        WHEN lower(trim(c._name)) LIKE v_query_lower || '%' THEN 0.80
        WHEN lower(trim(c._name)) LIKE v_query_normalized || '%' THEN 0.80
        ELSE 0
      END
      -- TIER 3: FULL PHRASE MATCH (0.50)
      + CASE WHEN strpos(lower(c._name), v_query_lower) > 0 THEN 0.50 ELSE 0 END
      -- TIER 4: PARTIAL/FUZZY - word count match
      + CASE
        WHEN (SELECT count(*)::numeric FROM unnest(v_all_words) aw
              WHERE length(aw) >= 2 AND strpos(lower(c._name), aw) > 0)
             = GREATEST(array_length(v_all_words, 1), 1)
        THEN 0.30
        ELSE (SELECT count(*)::numeric FROM unnest(v_all_words) aw
              WHERE length(aw) >= 2 AND strpos(lower(c._name), aw) > 0)
             / GREATEST(array_length(v_all_words, 1), 1) * 0.15
      END
      -- Funding tiebreaker (0-0.05)
      + CASE WHEN c._tf > 0 THEN LEAST(ln(c._tf + 1) / 24.0 * 0.05, 0.05) ELSE 0 END
      -- REMOVED: Funder preference bias (+0.05) that caused recipients to
      -- incorrectly show as funders when they existed in both tables.
      -- Previously: + CASE WHEN c._etype = 'funder' THEN 0.05 ELSE 0 END
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
