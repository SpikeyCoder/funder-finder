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
-- Candidates are the union of four sets, each capped at 500 *without* sorting
-- so a common word stops scanning early, then ranked together:
--   exact       names equal to the query (also "The <query>"), by B-tree on
--               lower(name) — an ILIKE without wildcards still goes through
--               the trigram index and rechecks every row sharing the word's
--               trigrams (6.6 s for "foundation"); never lost to other caps;
--   all words   names containing every indexable distinctive word (up to 4) —
--               small for multi-word queries;
--   prefix      names starting with the query;
--   one word    the first word with a 3+ letter/digit run, when there are
--               several (with one, it's the all-words set); or, with only
--               short words, names with a word starting with it ('st%' /
--               '% st%', which the index serves via leading trigrams).
-- Parallel workers and synchronized seq scans are off for the function, so
-- each capped set — and the result — is the same call to call. LIKE wildcards
-- in input are escaped; a query with no letters or digits returns nothing.
-- Ranking keeps the previous tiers (now on escaped patterns), adds trigram
-- similarity to the whole (camelCase-split) query as a small tiebreaker
-- (weight 0.01, below the funding tiebreaker), and breaks remaining ties by
-- id (recipient preferred over funder on an exact tie for the same EIN, per
-- 20260326100000).
--
-- An earlier draft ranked every match *before* capping; "foundation" (148k
-- funders) took 22 s. Don't do that.
--
-- MEASURED (production, pg_temp copy of this body; identical ordered results
-- on repeat calls for every query), ms:
--   foundation 266-341 · "% foundation" 272 · foundation for children 569 ·
--   community foundation 934 (cold) · the 561 · st 477 · united way of king
--   county 341 · church of st mary 311 · habitat for humanity 208 · red cross
--   495 · SitStayRead 147 · xq 6 · y.m.c.a 51 · NULL / %% / __ 0
-- (The exact set was stubbed for these runs because its lower(name) indexes
-- don't exist in production until this migration runs; on a temp copy of
-- funders with that index, `lower(name) IN ('foundation','the foundation')`
-- took 0.08 ms.)
-- Top results: "foundation" → FOUNDATION FOR THE CAROLINAS; "church of st
-- mary" → CHURCH OF ST MARY; "united way of king county" → UNITED WAY OF KING
-- COUNTY; "SitStayRead" → SIT STAY READ INC.
--
-- The pg_trgm extension and both trigram indexes already exist in production;
-- they're declared here (IF NOT EXISTS) so the schema this depends on is in
-- source control. The two lower(name) B-tree indexes are new. (Not
-- CONCURRENTLY: migrations run in a transaction. Building them briefly blocks
-- writes to these tables, which are batch-loaded.) CREATE OR REPLACE keeps the function's owner and grants.
-- Rollback: supabase/rollbacks/20261002120000_search_organizations_use_trgm_index.down.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_funders_name_trgm
  ON public.funders USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_recipient_org_name_trgm2
  ON public.recipient_organizations USING gin (name extensions.gin_trgm_ops);

-- New: exact-name lookups for the "exact" candidate set.
CREATE INDEX IF NOT EXISTS idx_funders_lower_name
  ON public.funders (lower(name));
CREATE INDEX IF NOT EXISTS idx_recipient_org_lower_name
  ON public.recipient_organizations (lower(name));

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
  v_long text[];  -- distinctive words with a 3+ letter/digit run (indexable)
  v_all1 text;    -- up to four patterns a name must ALL match
  v_all2 text;
  v_all3 text;
  v_all4 text;
  v_exact text;   -- the whole (normalized) query, matched by lower(name) equality
  v_prefix text;  -- names starting with the query
  -- LIKE-escaped forms of the query, for every pattern built from input.
  e_lower text;
  e_norm text;
  e_first text;
BEGIN
  v_query_lower := lower(trim(p_query));
  -- Leading punctuation means nothing in a name search, and left in a prefix
  -- pattern ("% foundation%") only the common word's trigrams would remain.
  v_query_normalized := regexp_replace(regexp_replace(v_query_lower, '^[^[:alnum:]]+', ''), '^the\s+', '');

  -- Split camelCase/PascalCase: "SitStayRead" → "sit stay read"
  v_query_spaced := lower(regexp_replace(trim(p_query), '([a-z])([A-Z])', '\1 \2', 'g'));
  IF v_query_spaced = v_query_lower THEN
    v_query_spaced := NULL;
  END IF;

  -- Nothing to match on (e.g. "%%" or "__"): such a pattern has no trigrams,
  -- so searching would scan both tables in full for nothing.
  IF v_query_lower IS NULL OR v_query_lower !~ '[[:alnum:]]' THEN
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

  -- Escape LIKE wildcards in everything built from input, so "%" and "_" are
  -- literal text rather than match-anything patterns.
  e_lower := replace(replace(replace(v_query_lower, '\', '\\'), '%', '\%'), '_', '\_');
  e_norm := replace(replace(replace(v_query_normalized, '\', '\\'), '%', '\%'), '_', '\_');

  -- Split into all words and distinctive words
  v_all_words := string_to_array(coalesce(v_query_spaced, v_query_lower), ' ');
  e_first := replace(replace(replace(v_all_words[1], '\', '\\'), '%', '\%'), '_', '\_');
  v_distinctive := ARRAY[]::text[];
  FOREACH w IN ARRAY v_all_words LOOP
    IF length(w) >= 2 AND w ~ '[[:alnum:]]' AND NOT (w = ANY(v_stop)) THEN
      v_distinctive := array_append(v_distinctive, replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_'));
    END IF;
  END LOOP;

  -- A trigram index can only serve a word with a run of 3+ letters/digits
  -- ('%st%' or '%y.m.c.a%' would scan every row; pg_trgm splits on
  -- punctuation). Only such words drive the indexed candidate sets.
  SELECT coalesce(array_agg(dw ORDER BY ord), ARRAY[]::text[]) INTO v_long
  FROM unnest(v_distinctive) WITH ORDINALITY AS t(dw, ord)
  WHERE dw ~ '[[:alnum:]]{3}';
  v_driver := v_long[1];

  IF array_length(v_distinctive, 1) IS NULL THEN
    v_distinctive := ARRAY[e_norm];
  END IF;

  IF v_driver IS NULL THEN
    -- Only short words ("st", "uw") or stop words ("the"): match where a word
    -- starts with it, at the start or mid-name — both forms have leading
    -- trigrams the index can use.
    v_loose := v_distinctive[1] || '%';
    v_loose2 := '% ' || v_distinctive[1] || '%';
  ELSIF array_length(v_long, 1) > 1 THEN
    v_loose := '%' || v_driver || '%';  -- (with one word, the all-words set is this)
  END IF;

  -- All-words set: only indexable words; skipped (NULL) when there are none.
  v_all1 := '%' || v_long[1] || '%';
  v_all2 := '%' || v_long[2] || '%';  -- NULL when absent
  v_all3 := '%' || v_long[3] || '%';
  v_all4 := '%' || v_long[4] || '%';
  v_exact := v_query_normalized;
  v_prefix := e_norm || '%';
  v_first_word := v_all_words[1];

  RETURN QUERY
  WITH funder_ids AS (
    -- Bounded candidate sets, each capped without sorting so a common word
    -- stops scanning early; ranking happens on their union below. The exact-
    -- name set guarantees an exact match is never cut by the others' caps.
    -- Only legitimate grantmaking funders (NTEE T-code or 990-PF filers)
    -- count.
    (SELECT f.id FROM funders f
      WHERE lower(f.name) IN (v_exact, 'the ' || v_exact)
        AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id))
      LIMIT 500)
    UNION
    (SELECT f.id FROM funders f
      WHERE v_all1 IS NOT NULL AND f.name ILIKE v_all1
        AND (v_all2 IS NULL OR f.name ILIKE v_all2)
        AND (v_all3 IS NULL OR f.name ILIKE v_all3)
        AND (v_all4 IS NULL OR f.name ILIKE v_all4)
        AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id))
      LIMIT 500)
    UNION
    (SELECT f.id FROM funders f WHERE f.name ILIKE v_prefix AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id)) LIMIT 500)
    UNION
    (SELECT f.id FROM funders f WHERE v_loose IS NOT NULL AND (f.name ILIKE v_loose OR f.name ILIKE v_loose2) AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id)) LIMIT 500)
  ),
  funder_hits AS (
    SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
      'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf
    FROM funder_ids fi
    JOIN funders f ON f.id = fi.id
  ),
  recipient_ids AS (
    (SELECT r.id FROM recipient_organizations r
      WHERE lower(r.name) IN (v_exact, 'the ' || v_exact)
      LIMIT 500)
    UNION
    (SELECT r.id FROM recipient_organizations r
      WHERE v_all1 IS NOT NULL AND r.name ILIKE v_all1
        AND (v_all2 IS NULL OR r.name ILIKE v_all2)
        AND (v_all3 IS NULL OR r.name ILIKE v_all3)
        AND (v_all4 IS NULL OR r.name ILIKE v_all4)
      LIMIT 500)
    UNION
    (SELECT r.id FROM recipient_organizations r WHERE r.name ILIKE v_prefix LIMIT 500)
    UNION
    (SELECT r.id FROM recipient_organizations r WHERE v_loose IS NOT NULL AND (r.name ILIKE v_loose OR r.name ILIKE v_loose2) LIMIT 500)
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
        WHEN lower(trim(c._name)) LIKE e_first || '%' THEN 0.80
        WHEN lower(trim(c._name)) LIKE e_lower || '%' THEN 0.80
        WHEN lower(trim(c._name)) LIKE e_norm || '%' THEN 0.80
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
      -- Similarity to the whole (camelCase-split) query: a tiebreaker only,
      -- kept well below the funding tiebreaker and every tier step.
      + extensions.similarity(c._name, coalesce(v_query_spaced, v_query_lower)) * 0.01
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
