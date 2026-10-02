-- FM-2026-10-02-01: make search_organizations fast, bounded and deterministic.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDINGS
-- --------
-- Trello #153: /search intermittently returned {"results":[],"error":"Search
-- failed"} (502). Postgres logged "canceling statement due to statement
-- timeout": the search-organizations Edge Function calls this RPC with the anon
-- key, and anon has statement_timeout = 3s. And identical searches for common
-- names returned different results from call to call.
--
-- 1. The candidate filters were `lower(name) ILIKE pattern`, but the trigram
--    indexes are on the bare column, so they could never be used: every search
--    seq-scanned funders (312k rows) and recipient_organizations (449k).
--    ILIKE is already case-insensitive, so `name ILIKE pattern` is equivalent.
-- 2. PostgREST pools connections; after five calls PL/pgSQL may cache a
--    generic plan that can't see the pattern. → plan_cache_mode =
--    force_custom_plan.
-- 3. Candidates were `LIMIT 500` of whatever the scan returned first, from a
--    single word, and both parallel and synchronized seq scans make "first"
--    vary per call — hence the changing results, and the right organization
--    could be cut ("habitat for humanity" matches 551 recipients).
-- 4. User input reached ILIKE unescaped ("%%" matched everything), and a
--    2-letter word ('%st%') has no trigrams, so no index could serve it.
--
-- FIX
-- ---
-- Candidates are the union of three sets, each capped at 500 *without* sorting
-- so a common word stops scanning early, then ranked together:
--   all words   names containing every distinctive word (up to 4) — small for
--               multi-word queries and where the intended org reliably is;
--   prefix      names starting with the query;
--   one word    the first distinctive word of 3+ letters (or, with only short
--               words, names with a word starting with it: 'st%' / '% st%',
--               which the index serves via leading trigrams).
-- Parallel workers and synchronized seq scans are off for the function, so
-- each capped set — and the result — is the same call to call. LIKE wildcards
-- in input are escaped; a query with no letters or digits returns nothing.
-- Ranking keeps the previous tiers, adds trigram similarity to the whole
-- (camelCase-split) query as a fine tiebreaker, and breaks remaining ties by
-- id (recipient preferred over funder on an exact tie for the same EIN, per
-- 20260326100000).
--
-- An earlier draft ranked every match *before* capping; "foundation" (148k
-- funders) took 22 s. Don't do that.
--
-- MEASURED (production, pg_temp copy of this body, ms; identical ordered
-- results on 3 consecutive calls for every query):
--   foundation 374-653 · community foundation 445 · foundation for children
--   162-612 · family foundation 197-490 · the 161 · st 156 · the st 137 ·
--   united way of king county 305 · church of st mary 206 · habitat for
--   humanity 136 · red cross 126 · SitStayRead 86 · %% / __ 0
-- Top results: "church of st mary" → CHURCH OF ST MARY; "united way of king
-- county" → UNITED WAY OF KING COUNTY; "SitStayRead" → SIT STAY READ INC.
--
-- The pg_trgm extension and both trigram indexes already exist in production;
-- they're declared here (IF NOT EXISTS) so the schema this depends on is in
-- source control. CREATE OR REPLACE keeps the function's owner and grants.
-- Rollback: supabase/rollbacks/20261002120000_search_organizations_use_trgm_index.down.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_funders_name_trgm
  ON public.funders USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_recipient_org_name_trgm2
  ON public.recipient_organizations USING gin (name extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_organizations(p_query text, p_limit integer DEFAULT 15)
RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
-- PostgREST pools connections, so after five calls PL/pgSQL may switch this
-- function's queries to a generic plan that can't see the ILIKE patterns and
-- seq-scans both tables. Always plan with the actual patterns.
SET plan_cache_mode = force_custom_plan
-- The candidate queries below cap at 500 rows without sorting (so a common
-- word stops scanning early). A non-parallel scan returns rows in stable
-- physical order, which keeps that cap — and so the results — the same from
-- call to call; a parallel scan's row order varies between runs.
SET max_parallel_workers_per_gather = 0
-- Likewise: with synchronized scans on, a sequential scan of a big table joins
-- one already in progress mid-table, so "the first 500" would vary per call.
SET synchronize_seqscans = off
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
  v_loose text;   -- single-word candidate pattern
  v_loose2 text;  -- second pattern for a short word (word start mid-name)
  v_all1 text;    -- up to four patterns a name must ALL match
  v_all2 text;
  v_all3 text;
  v_all4 text;
  v_prefix text;  -- names starting with the query
BEGIN
  v_query_lower := lower(trim(p_query));
  v_query_normalized := regexp_replace(v_query_lower, '^the\s+', '');

  -- Split camelCase/PascalCase: "SitStayRead" → "sit stay read"
  v_query_spaced := lower(regexp_replace(trim(p_query), '([a-z])([A-Z])', '\1 \2', 'g'));
  IF v_query_spaced = v_query_lower THEN
    v_query_spaced := NULL;
  END IF;

  -- Nothing to match on (e.g. "%%" or "__"): such a pattern has no trigrams,
  -- so searching would scan both tables in full for nothing.
  IF v_query_lower !~ '[[:alnum:]]' THEN
    RETURN;
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
    IF length(w) >= 2 AND w ~ '[[:alnum:]]' AND NOT (w = ANY(v_stop)) THEN
      -- Escape LIKE wildcards so input like "%%" or "__" is literal text, not
      -- a match-everything pattern.
      v_distinctive := array_append(v_distinctive, replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_'));
    END IF;
  END LOOP;

  -- A trigram index needs a 3+ character word ('%st%' has no trigrams and
  -- would scan every row): drive the single-word match with the first one.
  -- (Counting letters and digits only: pg_trgm ignores punctuation.)
  SELECT dw INTO v_driver FROM unnest(v_distinctive) WITH ORDINALITY AS t(dw, ord)
  WHERE length(regexp_replace(dw, '[^[:alnum:]]', '', 'g')) >= 3 ORDER BY ord LIMIT 1;

  IF array_length(v_distinctive, 1) IS NULL THEN
    v_distinctive := ARRAY[replace(replace(replace(v_query_normalized, '\', '\\'), '%', '\%'), '_', '\_')];
  END IF;

  IF v_driver IS NOT NULL THEN
    v_loose := '%' || v_driver || '%';
    v_loose2 := v_loose;
  ELSE
    -- Only short words ("st", "uw") or stop words ("the"): match where a word
    -- starts with it, at the start or mid-name — both forms have leading
    -- trigrams the index can use.
    v_loose := v_distinctive[1] || '%';
    v_loose2 := '% ' || v_distinctive[1] || '%';
  END IF;

  v_all1 := '%' || v_distinctive[1] || '%';
  v_all2 := '%' || v_distinctive[2] || '%';  -- NULL when absent
  v_all3 := '%' || v_distinctive[3] || '%';
  v_all4 := '%' || v_distinctive[4] || '%';
  v_prefix := replace(replace(replace(v_query_normalized, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_first_word := v_all_words[1];

  RETURN QUERY
  WITH funder_ids AS (
    -- Three bounded candidate sets, each capped without sorting so a common
    -- word stops scanning early; ranking happens on their union below. Only
    -- legitimate grantmaking funders (NTEE T-code or 990-PF filers) count.
    (SELECT f.id FROM funders f
      WHERE f.name ILIKE v_all1
        AND (v_all2 IS NULL OR f.name ILIKE v_all2)
        AND (v_all3 IS NULL OR f.name ILIKE v_all3)
        AND (v_all4 IS NULL OR f.name ILIKE v_all4)
        AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id))
      LIMIT 500)
    UNION
    (SELECT f.id FROM funders f WHERE f.name ILIKE v_prefix AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id)) LIMIT 500)
    UNION
    (SELECT f.id FROM funders f WHERE (f.name ILIKE v_loose OR f.name ILIKE v_loose2) AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id)) LIMIT 500)
  ),
  funder_hits AS (
    SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
      'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf
    FROM funder_ids fi
    JOIN funders f ON f.id = fi.id
  ),
  recipient_ids AS (
    (SELECT r.id FROM recipient_organizations r
      WHERE r.name ILIKE v_all1
        AND (v_all2 IS NULL OR r.name ILIKE v_all2)
        AND (v_all3 IS NULL OR r.name ILIKE v_all3)
        AND (v_all4 IS NULL OR r.name ILIKE v_all4)
      LIMIT 500)
    UNION
    (SELECT r.id FROM recipient_organizations r WHERE r.name ILIKE v_prefix LIMIT 500)
    UNION
    (SELECT r.id FROM recipient_organizations r WHERE r.name ILIKE v_loose OR r.name ILIKE v_loose2 LIMIT 500)
  ),
  recipient_hits AS (
    SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text,
      'recipient'::text, coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric
    FROM recipient_ids ri
    JOIN recipient_organizations r ON r.id = ri.id
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
      -- Similarity to the whole (camelCase-split) query, as a fine tiebreaker
      + extensions.similarity(c._name, coalesce(v_query_spaced, v_query_lower)) * 0.10
      -- Funding tiebreaker (0-0.05)
      + CASE WHEN c._tf > 0 THEN LEAST(ln(c._tf + 1) / 24.0 * 0.05, 0.05) ELSE 0 END
      -- REMOVED: Funder preference bias (+0.05) that caused recipients to
      -- incorrectly show as funders when they existed in both tables.
      -- Previously: + CASE WHEN c._etype = 'funder' THEN 0.05 ELSE 0 END
      AS _rel
    FROM combined c
  ),
  deduped AS (
    -- One row per organization (EIN); fall back to the row id if an EIN is
    -- ever missing so such rows don't collapse together.
    SELECT DISTINCT ON (coalesce(lpad(s._ein, 9, '0'), 'id:' || s._id))
      s._id, s._ein, s._name, s._state, s._etype, s._gc, s._tf, s._rel
    FROM scored s
    -- On a relevance tie between a funder and recipient row for the same EIN,
    -- prefer the recipient (see 20260326100000), then break ties by id.
    ORDER BY coalesce(lpad(s._ein, 9, '0'), 'id:' || s._id), s._rel DESC, (s._etype = 'recipient') DESC, s._id
  )
  SELECT d._id, d._ein, d._name, d._state, d._etype, d._gc, d._tf
  FROM deduped d
  ORDER BY d._rel DESC, d._tf DESC, d._id
  LIMIT p_limit;
END;
$function$;
