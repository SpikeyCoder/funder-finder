-- FM-2026-10-02-01: make search_organizations fast and deterministic.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDING 1 — timeouts
-- --------------------
-- Trello #153: /search intermittently returned {"results":[],"error":"Search
-- failed"} (502). Postgres logged "canceling statement due to statement
-- timeout": the search-organizations Edge Function calls this RPC with the anon
-- key, and anon has statement_timeout = 3s.
--
-- a) Both candidate filters were `lower(name) ILIKE v_pattern`, but the
--    trigram indexes are on the bare column (idx_funders_name_trgm,
--    idx_recipient_org_name_trgm2), so every search seq-scanned funders (312k
--    rows) and recipient_organizations (449k rows). ILIKE is already
--    case-insensitive, so `name ILIKE v_pattern` matches the same rows and can
--    use the index. '%students%': recipients 1,570 → 58 ms, funders
--    2,265 → 137 ms (EXPLAIN ANALYZE, production).
-- b) PostgREST pools connections, and after five calls PL/pgSQL may cache a
--    generic plan that can't see the pattern and seq-scans. The function now
--    sets plan_cache_mode = force_custom_plan.
-- c) A 2-character driver word ('%st%') has no trigrams, so no index can
--    serve it. The driver is now the first distinctive word of 3+ characters;
--    with none (e.g. "st", or stop words only like "the") the filter becomes a
--    prefix match (`st%`), which the index serves via padded leading trigrams.
--
-- FINDING 2 — nondeterministic results
-- ------------------------------------
-- funder_hits / recipient_hits took `LIMIT 500` with no ORDER BY, so when the
-- driver word matched more than 500 names ("community" matches 17,558
-- recipients) an arbitrary 500 were kept before ranking. Two consecutive calls
-- of the previous function returned different top-15 lists for "community
-- foundation", "red cross", "habitat for humanity", "st" and "SitStayRead",
-- and the best match could be dropped entirely. Candidates are now ordered by
-- distinctive-word hits, then pg_trgm similarity to the whole query, then id,
-- before the cap; the final ORDER BY and the DISTINCT ON de-dup also gained
-- id tie-breakers (recipient preferred over funder on an exact relevance tie,
-- matching the intent of 20260326100000).
--
-- Measured with a pg_temp copy of this exact body on production (7th call,
-- plan cache warm): all test queries return identical ordered results on
-- repeat; "the" 730 ms, "community foundation" 379 ms, "st" 267 ms,
-- "united way of king county" 220 ms, "habitat for humanity" 29 ms,
-- "Students feeding students" 19 ms.
--
-- Everything else is the body from 20260326100000_fix_recipients_showing_as_
-- funders.sql, verified identical (md5 of prosrc) to production on 2026-10-02.
-- CREATE OR REPLACE keeps the function's owner and grants.
-- Rollback: supabase/rollbacks/20261002120000_search_organizations_use_trgm_index.down.sql

CREATE OR REPLACE FUNCTION public.search_organizations(p_query text, p_limit integer DEFAULT 15)
RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
-- PostgREST pools connections, so after five calls PL/pgSQL may switch this
-- function's queries to a generic plan that can't see the ILIKE pattern and
-- seq-scans both tables. Always plan with the actual pattern.
SET plan_cache_mode = force_custom_plan
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
  v_driver text;
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

  -- The candidate filter needs a word of 3+ characters for the trigram index
  -- to apply ('%st%' has no trigrams and would scan every row). Use the first
  -- such distinctive word; if there is none (e.g. "st", or only stop words
  -- like "the"), match names starting with the query, which the index can
  -- serve via its padded leading trigrams.
  SELECT dw INTO v_driver FROM unnest(v_distinctive) WITH ORDINALITY AS t(dw, ord)
  WHERE length(dw) >= 3 ORDER BY ord LIMIT 1;

  IF array_length(v_distinctive, 1) IS NULL OR array_length(v_distinctive, 1) = 0 THEN
    v_distinctive := ARRAY[v_query_lower];
  END IF;

  IF v_driver IS NOT NULL THEN
    v_pattern := '%' || v_driver || '%';
  ELSE
    v_pattern := v_query_lower || '%';
  END IF;
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
    -- Rank before capping so the 500 kept are the best matches, not
    -- whichever rows the scan happened to return first.
    ORDER BY _word_hits DESC, extensions.similarity(f.name, v_query_lower) DESC, f.id
    LIMIT 500
  ),
  recipient_hits AS (
    SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text,
      'recipient'::text, coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric,
      (SELECT count(*)::numeric FROM unnest(v_distinctive) dw WHERE strpos(lower(r.name), dw) > 0) AS _word_hits
    FROM recipient_organizations r
    WHERE r.name ILIKE v_pattern  -- bare column so idx_recipient_org_name_trgm2 applies
    ORDER BY _word_hits DESC, extensions.similarity(r.name, v_query_lower) DESC, r.id
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
    -- On a relevance tie between a funder and recipient row for the same EIN,
    -- prefer the recipient (see 20260326100000), then break ties by id.
    ORDER BY lpad(s._ein, 9, '0'), s._rel DESC, (s._etype = 'recipient') DESC, s._id
  )
  SELECT d._id, d._ein, d._name, d._state, d._etype, d._gc, d._tf
  FROM deduped d
  ORDER BY d._rel DESC, d._tf DESC, d._id
  LIMIT p_limit;
END;
$function$;
