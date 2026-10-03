-- FM-2026-10-03-03: search reads a compact table that stays in memory.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDINGS
-- --------
-- Trello #246 (opened by monitor-sweep): search missed its 2 s SLA on 4 of 12
-- synthetic checks in an hour, and at 19:06 UTC two searches failed outright
-- ("canceling statement due to statement timeout" at anon's 3 s). Warm, the
-- candidate step of a "foundation" search takes ~100 ms; cold, 2-4 s.
--
-- The database has 256 MB of shared_buffers in a 6.8 GB database. Search
-- touches the trigram and name indexes (~200 MB, prewarmed every 5 minutes
-- by 20261003120000), but also ~950 scattered heap pages of funders (225 MB,
-- ~720 bytes a row) and recipient_organizations (83 MB) to recheck names,
-- read the result columns and join back by primary key, plus an index probe
-- into foundation_filings (320 MB) per funder candidate. None of those heap
-- pages are prewarmed, and other workloads keep evicting them, so a cold
-- search is ~1000 random reads. pg_stat_statements: mean ~1 s, max 3-7 s,
-- with more blocks read from disk than found in cache.
--
-- FIX
-- ---
-- public.org_search: one narrow row (~120 bytes) per searchable organization,
-- the columns search returns and nothing else:
--   funder     a grantmaking funder (NTEE T-code or a 990-PF filing), the
--              eligibility search_organizations checked per row, decided once;
--   recipient  every recipient organization.
-- Rows with no name can't match a name search and are left out. The table is
-- written in order of total funding (largest first), so a capped candidate
-- set read in table order (a sequential or bitmap scan) is the largest
-- organizations rather than whatever the source table's order gave. Which
-- rows a capped set holds can therefore differ from before for queries
-- matching more than its cap ("the", "c#"); results for others are the same.
--
-- Measured in rolled-back runs on production data, cache warm: the new
-- function took 18-213 ms per query (foundation 166, community foundation
-- 213, habitat for humanity 45, y.m.c.a 32, red cross 52, McDonald House 18;
-- the live function: foundation 329, community foundation 639), each
-- candidate set 2-26 ms. Results: identical for community foundation,
-- habitat for humanity, Students feeding students and McDonald House. For
-- queries that fill a candidate cap the top matches are unchanged and the
-- tail now favors larger organizations: "y.m.c.a" adds YMCA OF GREATER
-- HOUSTON ($111M) and YMCA OF GREATER SEATTLE, "united way of king county"
-- UNITED WAY OF BROWARD COUNTY, "red cross" RED RIVER HOSPITAL over RED WIND
-- CONSULTING.
--
-- search_organizations now takes its candidate sets (the same four per kind,
-- with the same caps) from org_search, selecting the result columns directly:
-- no join back to the source tables and no foundation_filings probes. The
-- EIN lookup and the ranking are unchanged.
--
-- prewarm_search_indexes loads org_search's rows into shared_buffers ('buffer'
-- mode; the old list used only 'read', which warms the OS cache) and its
-- search indexes into the OS cache, instead of the source tables' search
-- indexes. The EIN lookup's primary-key and EIN indexes stay ('read').
--
-- Measured on production (rolled back): 761,372 rows; heap 91 MB, name
-- B-trees 16 + 20 MB, trigram indexes 22 + 31 MB, primary key 50 MB. The load
-- takes ~25 s and the indexes ~10 s; the triggers are created first, so writes to
-- the three source tables wait for this migration (~40 s; they're batch-
-- loaded) while searches carry on against the old function until it commits.
--
-- KEEPING IT CURRENT
-- ------------------
-- The source tables are loaded by pipelines outside this repository and by
-- process-organization-requests (REST inserts), so org_search is kept in
-- step by triggers rather than a schedule. Inserts and deletes sync per statement
-- (a batch load in one pass); an update syncs a row only when a searched
-- column changed (funders see frequent updates to other columns, e.g.
-- website_last_checked).
-- foundation_filings changes re-check their funders' eligibility. TRUNCATE
-- of a source table empties (or, for foundation_filings, re-checks) its
-- part. org_search_rebuild() rebuilds the whole table if it ever drifts.
-- The trigger and sync functions are SECURITY DEFINER (writers such as
-- service_role need no grant on org_search) and not executable by clients.
--
-- org_search is publicly readable, like its source tables (search_organizations
-- runs as the caller, and anon calls it). Clients can't write to it.
--
-- The source tables' search indexes (idx_funders_name_trgm,
-- idx_recipient_org_name_trgm2, idx_funders_lower_name,
-- idx_recipient_org_lower_name) are no longer used by search but are left in
-- place, so the rollback is a function swap; drop them in a later migration.
--
-- Rollback: supabase/rollbacks/20261003160000_org_search_table.down.sql

-- ── The table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_search (
  kind          text NOT NULL CHECK (kind IN ('funder', 'recipient')),
  id            text NOT NULL,     -- funders.id (an EIN) / recipient_organizations.id (a uuid)
  ein           text,              -- funders: the id; recipients: their ein (may be missing)
  name          text NOT NULL,
  state         text,
  grant_count   bigint NOT NULL DEFAULT 0,   -- recipients only; 0 for funders, as search returned
  total_funding numeric NOT NULL DEFAULT 0,  -- funders: total_giving
  PRIMARY KEY (kind, id)
);

ALTER TABLE public.org_search ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_search FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.org_search TO anon, authenticated, service_role;
DROP POLICY IF EXISTS "Allow public read on org_search" ON public.org_search;
CREATE POLICY "Allow public read on org_search" ON public.org_search FOR SELECT USING (true);

-- ── Sync ────────────────────────────────────────────────────────────────────
-- Each makes org_search agree with the source rows for the given ids: a row
-- that's gone, nameless or (for a funder) not a grantmaker is removed; any
-- other is inserted, or updated if a searched column changed.

CREATE OR REPLACE FUNCTION public.org_search_sync_funders(p_ids text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.org_search s
   WHERE s.kind = 'funder' AND s.id = ANY (p_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.funders f
        WHERE f.id = s.id AND f.name IS NOT NULL
          AND (f.ntee_code LIKE 'T%'
               OR EXISTS (SELECT 1 FROM public.foundation_filings ff WHERE ff.foundation_id = f.id)));

  INSERT INTO public.org_search AS s (kind, id, ein, name, state, grant_count, total_funding)
  SELECT 'funder', f.id, f.id, f.name, f.state, 0, coalesce(f.total_giving, 0)
    FROM public.funders f
   WHERE f.id = ANY (p_ids) AND f.name IS NOT NULL
     AND (f.ntee_code LIKE 'T%'
          OR EXISTS (SELECT 1 FROM public.foundation_filings ff WHERE ff.foundation_id = f.id))
  ON CONFLICT (kind, id) DO UPDATE
     SET ein = EXCLUDED.ein, name = EXCLUDED.name, state = EXCLUDED.state,
         total_funding = EXCLUDED.total_funding
   WHERE (s.ein, s.name, s.state, s.total_funding)
         IS DISTINCT FROM (EXCLUDED.ein, EXCLUDED.name, EXCLUDED.state, EXCLUDED.total_funding);
$$;

CREATE OR REPLACE FUNCTION public.org_search_sync_recipients(p_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.org_search s
   WHERE s.kind = 'recipient' AND s.id = ANY (p_ids::text[])
     AND NOT EXISTS (
       SELECT 1 FROM public.recipient_organizations r
        WHERE r.id::text = s.id AND r.name IS NOT NULL);

  INSERT INTO public.org_search AS s (kind, id, ein, name, state, grant_count, total_funding)
  SELECT 'recipient', r.id::text, r.ein, r.name, r.primary_state,
         coalesce(r.grant_count, 0), coalesce(r.total_funding, 0)
    FROM public.recipient_organizations r
   WHERE r.id = ANY (p_ids) AND r.name IS NOT NULL
  ON CONFLICT (kind, id) DO UPDATE
     SET ein = EXCLUDED.ein, name = EXCLUDED.name, state = EXCLUDED.state,
         grant_count = EXCLUDED.grant_count, total_funding = EXCLUDED.total_funding
   WHERE (s.ein, s.name, s.state, s.grant_count, s.total_funding)
         IS DISTINCT FROM (EXCLUDED.ein, EXCLUDED.name, EXCLUDED.state, EXCLUDED.grant_count, EXCLUDED.total_funding);
$$;

-- Rebuilds the whole table, largest organizations first (see the header). For
-- the initial load and for repair; takes an exclusive lock on org_search, so
-- searches wait for it (a few seconds).
CREATE OR REPLACE FUNCTION public.org_search_rebuild()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows bigint;
BEGIN
  LOCK TABLE public.org_search IN ACCESS EXCLUSIVE MODE;
  TRUNCATE public.org_search;
  INSERT INTO public.org_search (kind, id, ein, name, state, grant_count, total_funding)
  SELECT x.kind, x.id, x.ein, x.name, x.state, x.grant_count, x.total_funding
    FROM (
      SELECT 'funder' AS kind, f.id, f.id AS ein, f.name, f.state,
             0::bigint AS grant_count, coalesce(f.total_giving, 0)::numeric AS total_funding
        FROM public.funders f
       WHERE f.name IS NOT NULL
         AND (f.ntee_code LIKE 'T%'
              OR EXISTS (SELECT 1 FROM public.foundation_filings ff WHERE ff.foundation_id = f.id))
      UNION ALL
      SELECT 'recipient', r.id::text, r.ein, r.name, r.primary_state,
             coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric
        FROM public.recipient_organizations r
       WHERE r.name IS NOT NULL
    ) x
   ORDER BY x.kind, x.total_funding DESC, x.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ANALYZE public.org_search;
  RETURN v_rows;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.org_search_sync_funders(text[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_search_sync_recipients(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_search_rebuild() FROM PUBLIC, anon, authenticated;

-- ── Triggers ────────────────────────────────────────────────────────────────
-- INSERT and DELETE: statement-level with transition tables, so a batch load
-- syncs in one pass. UPDATE: row-level, firing only when a searched column
-- actually changed (UPDATE OF … WHEN), so the frequent updates to other
-- columns (funders' website_last_checked, filings' parse_status) cost
-- nothing. One function per source table serves all of its triggers.

CREATE OR REPLACE FUNCTION public.org_search_funders_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A changed id: the old one is gone and the new one added.
    PERFORM public.org_search_sync_funders(ARRAY[OLD.id, NEW.id]);
    RETURN NULL;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.org_search_sync_funders(ARRAY(SELECT n.id FROM new_rows n));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.org_search_sync_funders(ARRAY(SELECT o.id FROM old_rows o));
  ELSE  -- TRUNCATE
    DELETE FROM public.org_search WHERE kind = 'funder';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.org_search_recipients_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.org_search_sync_recipients(ARRAY[OLD.id, NEW.id]);
    RETURN NULL;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.org_search_sync_recipients(ARRAY(SELECT n.id FROM new_rows n));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.org_search_sync_recipients(ARRAY(SELECT o.id FROM old_rows o));
  ELSE  -- TRUNCATE
    DELETE FROM public.org_search WHERE kind = 'recipient';
  END IF;
  RETURN NULL;
END;
$$;

-- A funder without an NTEE T-code is searchable only while it has a filing.
CREATE OR REPLACE FUNCTION public.org_search_filings_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.org_search_sync_funders(ARRAY[OLD.foundation_id, NEW.foundation_id]);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.org_search_sync_funders(ARRAY(SELECT DISTINCT n.foundation_id FROM new_rows n));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.org_search_sync_funders(ARRAY(SELECT DISTINCT o.foundation_id FROM old_rows o));
  ELSE  -- TRUNCATE: re-check every funder (those kept only by a filing go).
    PERFORM public.org_search_sync_funders(ARRAY(SELECT s.id FROM public.org_search s WHERE s.kind = 'funder'));
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.org_search_funders_changed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_search_recipients_changed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_search_filings_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS org_search_funders_ins ON public.funders;
DROP TRIGGER IF EXISTS org_search_funders_upd ON public.funders;
DROP TRIGGER IF EXISTS org_search_funders_del ON public.funders;
DROP TRIGGER IF EXISTS org_search_funders_trunc ON public.funders;
CREATE TRIGGER org_search_funders_ins AFTER INSERT ON public.funders
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_funders_changed();
CREATE TRIGGER org_search_funders_upd AFTER UPDATE OF id, name, state, total_giving, ntee_code ON public.funders
  FOR EACH ROW
  WHEN ((OLD.id, OLD.name, OLD.state, OLD.total_giving, OLD.ntee_code)
        IS DISTINCT FROM (NEW.id, NEW.name, NEW.state, NEW.total_giving, NEW.ntee_code))
  EXECUTE FUNCTION public.org_search_funders_changed();
CREATE TRIGGER org_search_funders_del AFTER DELETE ON public.funders
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_funders_changed();
CREATE TRIGGER org_search_funders_trunc AFTER TRUNCATE ON public.funders
  FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_funders_changed();

DROP TRIGGER IF EXISTS org_search_recipients_ins ON public.recipient_organizations;
DROP TRIGGER IF EXISTS org_search_recipients_upd ON public.recipient_organizations;
DROP TRIGGER IF EXISTS org_search_recipients_del ON public.recipient_organizations;
DROP TRIGGER IF EXISTS org_search_recipients_trunc ON public.recipient_organizations;
CREATE TRIGGER org_search_recipients_ins AFTER INSERT ON public.recipient_organizations
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_recipients_changed();
CREATE TRIGGER org_search_recipients_upd
  AFTER UPDATE OF id, ein, name, primary_state, grant_count, total_funding ON public.recipient_organizations
  FOR EACH ROW
  WHEN ((OLD.id, OLD.ein, OLD.name, OLD.primary_state, OLD.grant_count, OLD.total_funding)
        IS DISTINCT FROM (NEW.id, NEW.ein, NEW.name, NEW.primary_state, NEW.grant_count, NEW.total_funding))
  EXECUTE FUNCTION public.org_search_recipients_changed();
CREATE TRIGGER org_search_recipients_del AFTER DELETE ON public.recipient_organizations
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_recipients_changed();
CREATE TRIGGER org_search_recipients_trunc AFTER TRUNCATE ON public.recipient_organizations
  FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_recipients_changed();

DROP TRIGGER IF EXISTS org_search_filings_ins ON public.foundation_filings;
DROP TRIGGER IF EXISTS org_search_filings_upd ON public.foundation_filings;
DROP TRIGGER IF EXISTS org_search_filings_del ON public.foundation_filings;
DROP TRIGGER IF EXISTS org_search_filings_trunc ON public.foundation_filings;
CREATE TRIGGER org_search_filings_ins AFTER INSERT ON public.foundation_filings
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_filings_changed();
CREATE TRIGGER org_search_filings_upd AFTER UPDATE OF foundation_id ON public.foundation_filings
  FOR EACH ROW WHEN (OLD.foundation_id IS DISTINCT FROM NEW.foundation_id)
  EXECUTE FUNCTION public.org_search_filings_changed();
CREATE TRIGGER org_search_filings_del AFTER DELETE ON public.foundation_filings
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_filings_changed();
CREATE TRIGGER org_search_filings_trunc AFTER TRUNCATE ON public.foundation_filings
  FOR EACH STATEMENT EXECUTE FUNCTION public.org_search_filings_changed();

-- ── Initial load, then the indexes ──────────────────────────────────────────
-- (Indexes after the load: building them once is much faster than
-- maintaining them row by row. The triggers above already hold, so a source
-- write that commits during this migration waits for its locks and is synced.)

SELECT public.org_search_rebuild();

-- Trigram indexes per kind (partial), so each kind's candidate set is served
-- by its own index, as it was by each source table's.
CREATE INDEX IF NOT EXISTS org_search_funder_name_trgm
  ON public.org_search USING gin (name extensions.gin_trgm_ops) WHERE kind = 'funder';
CREATE INDEX IF NOT EXISTS org_search_recipient_name_trgm
  ON public.org_search USING gin (name extensions.gin_trgm_ops) WHERE kind = 'recipient';
-- Exact and prefix lookups (text_pattern_ops: LIKE 'foundation%' range-scans),
-- also per kind. (One (kind, lower(btrim(name))) index lets the planner walk
-- a kind's names in order, filtering: 'the%' read 390k rows, 1.3 s, where a
-- BitmapOr of two range scans on these takes 4-7 ms.)
CREATE INDEX IF NOT EXISTS org_search_funder_lower_name
  ON public.org_search (lower(btrim(name)) text_pattern_ops) WHERE kind = 'funder';
CREATE INDEX IF NOT EXISTS org_search_recipient_lower_name
  ON public.org_search (lower(btrim(name)) text_pattern_ops) WHERE kind = 'recipient';
ANALYZE public.org_search;

-- ── Search ──────────────────────────────────────────────────────────────────
-- (search_organizations below is 20261002120000's with only its candidate
-- step replaced.)

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
  -- (Cut to 4000 first so the regex never runs over a huge payload.)
  p_query := btrim(left(btrim(regexp_replace(left(p_query, 4000), '\s+', ' ', 'g')), 200));
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

  -- Handle EIN lookup: 7-9 digits, or the dashed "12-3456789" form. Stored
  -- EINs may or may not keep a leading zero, so match both forms.
  IF p_query ~ '^\d{7,9}$' OR p_query ~ '^\d{2}-\d{7}$' THEN
    v_query_lower := replace(p_query, '-', '');
    -- One row per organization, the recipient row preferred (as below).
    RETURN QUERY
    SELECT DISTINCT ON (lpad(x._ein, 9, '0'))
           x._id, x._ein, x._name, x._state, x._etype, x._gc, x._tf
    FROM (
      SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
             'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf
      FROM funders f
      WHERE f.id IN (v_query_lower, lpad(v_query_lower, 9, '0'), ltrim(v_query_lower, '0'))
      UNION ALL
      SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text, 'recipient'::text,
             coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric
      FROM recipient_organizations r
      WHERE r.ein IN (v_query_lower, lpad(v_query_lower, 9, '0'), ltrim(v_query_lower, '0'))
    ) x
    ORDER BY lpad(x._ein, 9, '0'), (x._etype = 'recipient') DESC, x._id
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
  -- But a run-together name ("SitStayRead") starts with its first camelCase
  -- part: use that when it's a real word (3+ letters, so not "Mc"/"De").
  IF v_query_spaced IS NOT NULL
     AND length(v_all_words[CASE WHEN v_all_words[1] = 'the' THEN 2 ELSE 1 END]) >= 3 THEN
    e_first := v_all_words[CASE WHEN v_all_words[1] = 'the' THEN 2 ELSE 1 END];
  END IF;
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
    -- Only when the split cut a short part off the front of it ("Mc" +
    -- 'donald'): when the typed word starts with the driver ("SitStayRead
    -- foundation" → '%sit%'), the driver set can reach "SIT STAY READ INC"
    -- where '%sitstayread%' can't, so it stays.
    IF w IS NOT NULL AND v_driver IS NOT NULL AND strpos(w, v_driver) = 1 THEN
      NULL;
    ELSIF w IS NOT NULL AND v_driver IS NULL THEN
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
  WITH combined AS (
    -- Bounded candidate sets from org_search, each capped without sorting so
    -- a common word stops scanning early; ranking happens on their union
    -- below. Funders and recipients are capped separately, as before. The
    -- exact-name set guarantees an exact match is never cut by the others'
    -- caps. org_search holds only grantmaking funders, and the result
    -- columns themselves, so there's no eligibility check or join back.
    -- (UNION removes the duplicates the sets share: a row is its kind + id.)
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'funder' AND lower(btrim(s.name)) IN (v_exact, 'the ' || v_exact)
      LIMIT 500)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'funder' AND v_all1 IS NOT NULL AND s.name ILIKE v_all1
        AND (v_all2 IS NULL OR s.name ILIKE v_all2)
        AND (v_all3 IS NULL OR s.name ILIKE v_all3)
        AND (v_all4 IS NULL OR s.name ILIKE v_all4)
        AND (v_short IS NULL OR s.name ILIKE v_short)
      LIMIT v_all_cap)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'funder' AND v_prefix IS NOT NULL
        AND (lower(btrim(s.name)) LIKE v_prefix OR lower(btrim(s.name)) LIKE 'the ' || v_prefix)
      LIMIT 500)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'funder' AND v_loose IS NOT NULL AND (s.name ILIKE v_loose OR s.name ILIKE v_loose2)
      LIMIT 500)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'recipient' AND lower(btrim(s.name)) IN (v_exact, 'the ' || v_exact)
      LIMIT 500)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'recipient' AND v_all1 IS NOT NULL AND s.name ILIKE v_all1
        AND (v_all2 IS NULL OR s.name ILIKE v_all2)
        AND (v_all3 IS NULL OR s.name ILIKE v_all3)
        AND (v_all4 IS NULL OR s.name ILIKE v_all4)
        AND (v_short IS NULL OR s.name ILIKE v_short)
      LIMIT v_all_cap)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'recipient' AND v_prefix IS NOT NULL
        AND (lower(btrim(s.name)) LIKE v_prefix OR lower(btrim(s.name)) LIKE 'the ' || v_prefix)
      LIMIT 500)
    UNION
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.state AS _state, s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf FROM org_search s
      WHERE s.kind = 'recipient' AND v_loose IS NOT NULL AND (s.name ILIKE v_loose OR s.name ILIKE v_loose2)
      LIMIT 500)
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

-- ── Prewarm ─────────────────────────────────────────────────────────────────
-- org_search's rows (91 MB on production at this migration) go into
-- shared_buffers ('buffer'): the scattered heap reads were what made a cold
-- search slow. Its search indexes (~89 MB) and the EIN lookup's go into the
-- OS cache ('read'), as the old list's did; all of them in shared_buffers
-- (256 MB) would crowd out everything else. Its primary key is only used by
-- the sync triggers, so it isn't warmed. The source tables' name indexes are
-- dropped from the list: search no longer reads them.

CREATE OR REPLACE FUNCTION public.prewarm_search_indexes()
RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
SET lock_timeout = '1s'
AS $$
DECLARE
  v_item text[];
  v_rel regclass;
  v_blocks bigint := 0;
  v_skipped text[] := '{}';
BEGIN
  FOREACH v_item SLICE 1 IN ARRAY ARRAY[
    ['public.org_search', 'buffer'],
    ['public.org_search_funder_lower_name', 'read'],
    ['public.org_search_recipient_lower_name', 'read'],
    ['public.org_search_funder_name_trgm', 'read'],
    ['public.org_search_recipient_name_trgm', 'read'],
    ['public.funders_pkey', 'read'],
    ['public.recipient_organizations_pkey', 'read'],
    ['public.idx_recipient_org_ein', 'read']
  ] LOOP
    v_rel := to_regclass(v_item[1]);
    IF v_rel IS NULL THEN
      v_skipped := v_skipped || format('%s (does not exist; update this list)', v_item[1]);
      CONTINUE;
    END IF;
    BEGIN
      v_blocks := v_blocks + extensions.pg_prewarm(v_rel, v_item[2]);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || format('%s (%s)', v_item[1], SQLERRM);
    END;
  END LOOP;
  IF cardinality(v_skipped) > 0 THEN
    RAISE EXCEPTION 'prewarm_search_indexes: warmed % blocks, skipped: %',
      v_blocks, array_to_string(v_skipped, '; ');
  END IF;
  RETURN v_blocks;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prewarm_search_indexes() FROM PUBLIC, anon, authenticated;

-- Warm it now rather than at the next run.
SELECT public.prewarm_search_indexes();
