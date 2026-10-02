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
-- Candidates are the union of four sets, each capped *without* sorting so a
-- common word stops scanning early, then ranked together:
--   exact       names equal to the query (also "The <query>"), by B-tree on
--               lower(btrim(name)) — an ILIKE without wildcards still goes through
--               the trigram index and rechecks every row sharing the word's
--               trigrams (6.6 s for "foundation"); never lost to other caps;
--   all words   names containing every indexable distinctive word (up to 4)
--               and the first 2-letter one ("uw madison") — 2000 rows when
--               there are 2+ such words (small by construction), else 500;
--   prefix      names starting with the query or "The <query>", by range
--               scan of the same B-tree (500);
--   one word    the first word with a 3+ letter/digit run when other words
--               narrow the all-words set, or the word as typed when a
--               camelCase split broke it up ("McDonald" → '%mcdonald%');
--               with only short words, names with a word starting with it
--               ('st%' / '% st%', served via leading trigrams) (500).
-- Input is cut to 200 characters with whitespace collapsed, and p_limit is
-- clamped to 1-50 (anon can call this RPC directly).
-- Parallel workers and synchronized seq scans are off for the function, so
-- each capped set — and the result — is the same call to call. LIKE wildcards
-- in input are escaped; a query with no letters or digits returns nothing.
-- Ranking keeps the previous tiers (now on escaped patterns), adds trigram
-- similarity to the whole (camelCase-split) query as a small tiebreaker
-- (weight ≤ 0.01, below the funding tiebreaker), and breaks remaining ties by
-- id (recipient preferred over funder on an exact tie for the same EIN, per
-- 20260326100000).
--
-- An earlier draft ranked every match *before* capping; "foundation" (148k
-- funders) took 22 s. Don't do that.
--
-- MEASURED on production data: this exact body as a pg_temp function over
-- session-temporary copies of funders and recipient_organizations carrying
-- all of this migration's indexes (identical ordered results on repeat calls
-- for every query), warm ms (a cold first call took up to ~1 s):
--   foundation 88 · community foundation 244 · the community foundation 280 ·
--   habitat for humanity 46 · y.m.c.a 33 · st jude 12 · red cross 56 ·
--   Students feeding students 27 · c# 60 · NULL / %% / __ 0
-- Before the prefix set used the lower(btrim(name)) B-tree, "foundation" took
-- ~380 ms warm and up to 3.3 s cold (over anon's 3 s timeout).
-- Words are split on any non-letter/digit (as pg_trgm does): "Habitat for
-- Humanity, Inc." (168 ms) → HABITAT FOR HUMANITY INTERNATIONAL INC first;
-- "red  cross" and "the community foundation" behave like their clean forms.
-- Top results: "y.m.c.a" → YMCA OF …; "j paul getty trust" → J PAUL
-- GETTY TRUST; "foundation for children" →
-- FOUNDATION FOR CHILDREN WITH NEUROIMMUNE DISORDERS INC; "church of st
-- mary" → CHURCH OF ST MARY; "united way of king county" → UNITED WAY OF KING
-- COUNTY; "SitStayRead" → SIT STAY READ INC.
--
-- The pg_trgm extension and both trigram indexes already exist in production;
-- they're declared here (IF NOT EXISTS) so the schema this depends on is in
-- source control. The two lower(btrim(name)) B-tree indexes are new. (Not
-- CONCURRENTLY: migrations run in a transaction. Building them briefly blocks
-- writes to these tables, which are batch-loaded.) CREATE OR REPLACE keeps the function's owner and grants.
-- Rollback: supabase/rollbacks/20261002120000_search_organizations_use_trgm_index.down.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
-- IF NOT EXISTS keeps an install in another schema; everything below names
-- extensions.* explicitly, so say so plainly rather than fail obscurely.
DO $$
BEGIN
  IF (SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_trgm') <> 'extensions' THEN
    RAISE EXCEPTION 'pg_trgm must be in schema extensions (run: ALTER EXTENSION pg_trgm SET SCHEMA extensions)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_funders_name_trgm
  ON public.funders USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_recipient_org_name_trgm2
  ON public.recipient_organizations USING gin (name extensions.gin_trgm_ops);

-- New: exact-name lookups for the "exact" candidate set.
-- Trimmed, as ranking compares names (one funder name has stray whitespace).
-- text_pattern_ops lets the prefix set use them too: a trigram index can't
-- range-scan 'foundation%', so it rechecks every name containing the word
-- (148k funders, ~200 ms warm and seconds cold) where this reads ~400 pages.
CREATE INDEX IF NOT EXISTS idx_funders_lower_name
  ON public.funders (lower(btrim(name)) text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_recipient_org_lower_name
  ON public.recipient_organizations (lower(btrim(name)) text_pattern_ops);
-- Expression indexes have no statistics until the table is analyzed; without
-- them the planner may skip the new indexes for the exact set.
ANALYZE public.funders;
ANALYZE public.recipient_organizations;

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
  v_exact text;   -- the whole (normalized) query, matched by lower(btrim(name)) equality
  v_prefix text;  -- names starting with the query
  -- LIKE-escaped forms of the query, for every pattern built from input.
  e_lower text;
  e_norm text;
  e_first text;
  v_min_len int;  -- shortest word length that counts as a hit
  v_counted int;  -- how many query words can count
  v_key_words text[];  -- words a candidate must contain one of
  v_acronym boolean := false;  -- query was single letters joined into one word
  v_all_cap int;  -- row cap for the all-words set
  v_short text;   -- a 2-letter word the all-words set must also contain
  v_typed text[]; -- the query's words as typed (before any camelCase split)
BEGIN
  -- No organization name is this long, and every query word costs a string
  -- search per candidate row: bound the work an anonymous caller can ask for.
  -- Any run of whitespace (tabs, newlines) means one space ("red  cross" is
  -- "red cross"), and none at either end.
  p_query := btrim(left(btrim(regexp_replace(p_query, '\s+', ' ', 'g')), 200));
  -- Anon can call this RPC directly, past the Edge Function's clamp.
  p_limit := LEAST(GREATEST(coalesce(p_limit, 15), 1), 50);
  v_query_lower := lower(p_query);
  -- Leading punctuation means nothing in a name search, and left in a prefix
  -- pattern ("% foundation%") only the common word's trigrams would remain.
  v_query_normalized := regexp_replace(
    regexp_replace(regexp_replace(v_query_lower, '^[^[:alnum:]]+', ''), '^the\s+', ''),
    '^[^[:alnum:]]+', '');

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

  -- Escape LIKE wildcards in the patterns built from the whole query, so "%"
  -- and "_" are literal text rather than match-anything patterns.
  e_lower := replace(replace(replace(v_query_lower, '\', '\\'), '%', '\%'), '_', '\_');
  e_norm := replace(replace(replace(v_query_normalized, '\', '\\'), '%', '\%'), '_', '\_');
  -- "the ." normalizes to nothing: no prefix to match (a bare '%' would match
  -- and credit every row).
  IF e_norm = '' THEN
    e_norm := NULL;
  END IF;

  -- Words are runs of letters/digits, like pg_trgm's own words, so
  -- "Humanity, Inc." gives 'humanity' and 'inc' (not 'humanity,' / 'inc.',
  -- which IRS-style names never contain) and extra spaces give no empty words.
  -- Being alphanumeric, they need no LIKE escaping.
  v_all_words := array_remove(
    regexp_split_to_array(coalesce(v_query_spaced, v_query_lower), '[^[:alnum:]]+'), '');
  -- A dotted acronym ("y.m.c.a", "a b c", "h&m") is one word, not single
  -- letters.
  IF array_length(v_all_words, 1) >= 2
     AND NOT EXISTS (SELECT 1 FROM unnest(v_all_words) x WHERE length(x) > 1) THEN
    v_all_words := ARRAY[array_to_string(v_all_words, '')];
    v_acronym := true;
  END IF;
  v_distinctive := ARRAY[]::text[];
  FOREACH w IN ARRAY v_all_words LOOP
    IF length(w) >= 2 AND NOT (w = ANY(v_stop)) THEN
      v_distinctive := array_append(v_distinctive, w);
    END IF;
  END LOOP;

  -- A trigram index can only serve a word of 3+ characters ('%st%' would
  -- scan every row). Only such words drive the indexed candidate sets.
  SELECT coalesce(array_agg(dw ORDER BY ord), ARRAY[]::text[]) INTO v_long
  FROM unnest(v_distinctive) WITH ORDINALITY AS t(dw, ord)
  WHERE length(dw) >= 3;
  v_driver := v_long[1];

  -- Tier-2 prefix bonus: names starting with the query's first word, past a
  -- leading "the" (which would credit every "THE …" name). A stop word there
  -- ("for the children", "the of") gives no word bonus; only the
  -- whole-query prefixes below earn it then. It must be a whole word ("st
  -- jude" credits "ST …", not "STANFORD …"); being alphanumeric, it is safe
  -- in a regex. It's the word as typed, so "McDonald House" credits
  -- "MCDONALD …" just as "mcdonald house" does.
  v_typed := CASE WHEN v_query_spaced IS NULL THEN v_all_words
    ELSE array_remove(regexp_split_to_array(v_query_lower, '[^[:alnum:]]+'), '') END;
  e_first := v_typed[CASE WHEN v_typed[1] = 'the' THEN 2 ELSE 1 END];
  IF e_first = ANY(v_stop) THEN
    e_first := NULL;
  END IF;
  IF array_length(v_distinctive, 1) IS NULL THEN
    -- Only stop words or 1-letter words: match on the first word.
    v_distinctive := v_all_words[1:1];
  END IF;

  -- Word hits ignore 1-letter words ("j paul getty") unless the query has
  -- nothing longer ("c#"); the Tier-4 denominator counts the same words.
  v_min_len := CASE WHEN EXISTS (SELECT 1 FROM unnest(v_all_words) x WHERE length(x) >= 2) THEN 2 ELSE 1 END;
  SELECT count(*) INTO v_counted FROM unnest(v_all_words) x WHERE length(x) >= v_min_len;
  -- A candidate must contain a non-stop word ("of" inside "PROFESSIONAL"
  -- isn't relevance), unless the query is nothing but stop words ("the").
  v_key_words := ARRAY(SELECT x FROM unnest(v_all_words) x WHERE length(x) >= v_min_len AND NOT (x = ANY(v_stop)));
  IF cardinality(v_key_words) = 0 THEN
    v_key_words := ARRAY(SELECT x FROM unnest(v_all_words) x WHERE length(x) >= v_min_len);
  END IF;

  -- A 2-letter word can't drive the index but still narrows the all-words set
  -- ("uw madison" shouldn't be a 500-row sample of '%madison%').
  -- (Not one the long words already contain: '%st%' adds nothing to
  -- '%stephen%'.)
  SELECT '%' || dw || '%' INTO v_short FROM unnest(v_distinctive) WITH ORDINALITY AS t(dw, ord)
  WHERE length(dw) = 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_long) l WHERE strpos(l, dw) > 0)
  ORDER BY ord LIMIT 1;

  IF v_driver IS NULL THEN
    -- Only short words ("st", "uw") or stop words ("the"): match where a word
    -- starts with it, at the start or mid-name — both forms have leading
    -- trigrams the index can use.
    v_loose := v_distinctive[1] || '%';
    v_loose2 := '% ' || v_distinctive[1] || '%';
  ELSIF array_length(v_long, 1) > 1 OR v_short IS NOT NULL THEN
    -- The driver alone, unnarrowed by the other words (so "washington dc"
    -- still reaches "WASHINGTON D.C. …"). With one word and nothing to narrow
    -- it, the all-words set is already this.
    v_loose := '%' || v_driver || '%';
  END IF;
  -- A camelCase split can leave the real word unsearched ("McDonald" →
  -- 'mc' + 'donald', and 'mc' can't drive a set): search the typed word too
  -- so "RONALD MCDONALD HOUSE" isn't left to a capped '%donald%' sample.
  IF v_query_spaced IS NOT NULL THEN
    SELECT x INTO w FROM unnest(v_typed) WITH ORDINALITY AS t(x, ord)
    WHERE length(x) >= 3 AND NOT (x = ANY(v_all_words)) ORDER BY ord LIMIT 1;
    IF w IS NOT NULL AND v_driver IS NULL THEN
      -- Keep the name-start pattern ('st%' for "StJo"); the typed word
      -- replaces the mid-name one.
      v_loose2 := '%' || w || '%';
    ELSIF w IS NOT NULL THEN
      -- '%donald%' would subsume '%mcdonald%': search the typed word alone.
      v_loose := '%' || w || '%';
    END IF;
  END IF;

  -- All-words set: only indexable words; skipped (NULL) when there are none.
  v_all1 := '%' || v_long[1] || '%';
  v_all2 := '%' || v_long[2] || '%';  -- NULL when absent
  v_all3 := '%' || v_long[3] || '%';
  v_all4 := '%' || v_long[4] || '%';
  v_exact := nullif(v_query_normalized, '');
  v_prefix := e_norm || '%';  -- NULL when there's no prefix to match
  -- With 2+ words (a 2-letter one counts) the all-words set is selective by
  -- construction, so a larger cap costs little and keeps the other sets'
  -- shared tail ("habitat for humanity": ~551) reachable. With one word it is
  -- just '%word%', as broad as the other sets.
  v_all_cap := CASE WHEN array_length(v_long, 1) > 1 OR v_short IS NOT NULL THEN 2000 ELSE 500 END;

  RETURN QUERY
  WITH funder_ids AS (
    -- Bounded candidate sets, each capped without sorting so a common word
    -- stops scanning early; ranking happens on their union below. The exact-
    -- name set guarantees an exact match is never cut by the others' caps.
    -- Only legitimate grantmaking funders (NTEE T-code or 990-PF filers)
    -- count.
    (SELECT f.id FROM funders f
      WHERE lower(btrim(f.name)) IN (v_exact, 'the ' || v_exact)
        AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id))
      LIMIT 500)
    UNION
    (SELECT f.id FROM funders f
      WHERE v_all1 IS NOT NULL AND f.name ILIKE v_all1
        AND (v_all2 IS NULL OR f.name ILIKE v_all2)
        AND (v_all3 IS NULL OR f.name ILIKE v_all3)
        AND (v_all4 IS NULL OR f.name ILIKE v_all4)
        AND (v_short IS NULL OR f.name ILIKE v_short)
        AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id))
      LIMIT v_all_cap)
    UNION
    (SELECT f.id FROM funders f WHERE v_prefix IS NOT NULL AND (lower(btrim(f.name)) LIKE v_prefix OR lower(btrim(f.name)) LIKE 'the ' || v_prefix) AND (f.ntee_code LIKE 'T%' OR EXISTS (SELECT 1 FROM foundation_filings ff WHERE ff.foundation_id = f.id)) LIMIT 500)
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
      WHERE lower(btrim(r.name)) IN (v_exact, 'the ' || v_exact)
      LIMIT 500)
    UNION
    (SELECT r.id FROM recipient_organizations r
      WHERE v_all1 IS NOT NULL AND r.name ILIKE v_all1
        AND (v_all2 IS NULL OR r.name ILIKE v_all2)
        AND (v_all3 IS NULL OR r.name ILIKE v_all3)
        AND (v_all4 IS NULL OR r.name ILIKE v_all4)
        AND (v_short IS NULL OR r.name ILIKE v_short)
      LIMIT v_all_cap)
    UNION
    (SELECT r.id FROM recipient_organizations r WHERE v_prefix IS NOT NULL AND (lower(btrim(r.name)) LIKE v_prefix OR lower(btrim(r.name)) LIKE 'the ' || v_prefix) LIMIT 500)
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
  measured AS (
    -- Per-row values the tiers share, computed once. Word hits are checked
    -- against the name with punctuation removed, matching how the query was
    -- tokenized ("y.m.c.a" → 'ymca' must hit "Y.M.C.A. OF …"); for a joined
    -- acronym, spaces go too ('abc' must hit "A B C CHILD CARE").
    SELECT n.*,
      (SELECT count(*)::numeric FROM unnest(v_all_words) aw
        WHERE length(aw) >= v_min_len AND strpos(n._bare, aw) > 0) AS _hits,
      EXISTS (SELECT 1 FROM unnest(v_key_words) kw WHERE strpos(n._bare, kw) > 0) AS _relevant,
      -- The name without a leading "the", as the query was normalized.
      regexp_replace(n._lname, '^the\s+', '') AS _core
    FROM (
      SELECT c.*, lower(trim(c._name)) AS _lname,
        regexp_replace(lower(c._name),
          CASE WHEN v_acronym THEN '[^[:alnum:]]' ELSE '[^[:alnum:][:space:]]' END, '', 'g') AS _bare
      FROM combined c
    ) n
  ),
  scored AS (
    SELECT m.*,
      -- TIER 1: EXACT MATCHES (1.0)
      CASE
        WHEN m._lname = v_query_lower THEN 1.0
        WHEN m._core IN (v_query_lower, v_query_normalized) THEN 1.0
        WHEN m._lname = v_query_normalized THEN 1.0
        ELSE 0
      END
      -- TIER 2: PREFIX MATCHES (0.80)
      + CASE
        WHEN m._core ~ ('^' || e_first || '([^[:alnum:]]|$)') THEN 0.80
        WHEN m._lname LIKE e_lower || '%' THEN 0.80
        WHEN m._core LIKE e_norm || '%' THEN 0.80
        ELSE 0
      END
      -- TIER 3: FULL PHRASE MATCH (0.50)
      + CASE WHEN strpos(m._lname, v_query_lower) > 0 THEN 0.50 ELSE 0 END
      -- TIER 4: PARTIAL/FUZZY - word count match
      + CASE
        WHEN m._hits = GREATEST(v_counted, 1) THEN 0.30
        ELSE m._hits / GREATEST(v_counted, 1) * 0.15
      END
      -- Similarity to the whole (camelCase-split) query: a tiebreaker only,
      -- kept below the funding tiebreaker and every tier step (including one
      -- more matched word of a long query: 0.15 / v_counted).
      + extensions.similarity(m._name, coalesce(v_query_spaced, v_query_lower))
        * LEAST(0.01, 0.05 / GREATEST(v_counted, 1))
      -- Funding tiebreaker (0-0.05)
      + CASE WHEN m._tf > 0 THEN LEAST(ln(m._tf + 1) / 24.0 * 0.05, 0.05) ELSE 0 END
      -- REMOVED: Funder preference bias (+0.05) that caused recipients to
      -- incorrectly show as funders when they existed in both tables.
      -- Previously: + CASE WHEN c._etype = 'funder' THEN 0.05 ELSE 0 END
      AS _rel
    FROM measured m
    -- A candidate must contain at least one distinctive query word (as before
    -- this migration); e.g. a one-letter fallback match alone isn't relevant.
    WHERE m._relevant
  ),
  deduped AS (
    -- One row per organization (EIN); fall back to the row id if an EIN is
    -- ever missing or blank so such rows don't collapse together.
    SELECT DISTINCT ON (coalesce(lpad(nullif(s._ein, ''), 9, '0'), 'id:' || s._id))
      s._id, s._ein, s._name, s._state, s._etype, s._gc, s._tf, s._rel
    FROM scored s
    -- The more relevant row wins, as in 20260326100000; on an exact tie,
    -- prefer the recipient, then the lower id, so the pick is deterministic.
    ORDER BY coalesce(lpad(nullif(s._ein, ''), 9, '0'), 'id:' || s._id), s._rel DESC, (s._etype = 'recipient') DESC, s._id
  )
  SELECT d._id, d._ein, d._name, d._state, d._etype, d._gc, d._tf
  FROM deduped d
  ORDER BY d._rel DESC, d._tf DESC, d._id
  LIMIT p_limit;
END;
$function$;
