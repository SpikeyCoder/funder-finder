-- Rollback for 20261004140000_irs_bmf_coverage.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never applies it.
-- Puts back search_organizations and prewarm_search_indexes as of
-- 20261004120000, then drops the alias table and the IRS functions and
-- table. Organizations the IRS load added stay (they are real organizations);
-- the last section removes them if wanted.
--
-- Disable the sync-irs-bmf workflow first, and deploy match-funders from
-- before this change (its filter reads recipient_organizations.source) if
-- that column is dropped.
--
-- Apply manually: psql "$DATABASE_URL" -f supabase/rollbacks/20261004140000_irs_bmf_coverage.down.sql

BEGIN;

-- search_organizations as of 20261004120000.
CREATE OR REPLACE FUNCTION public.search_organizations(
  p_query text, p_limit integer DEFAULT 15, p_state text DEFAULT NULL)
RETURNS TABLE(id text, ein text, name text, state text, entity_type text, grant_count bigint, total_funding numeric)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
-- PostgREST pools connections, so after five calls PL/pgSQL may switch this
-- function's queries to a generic plan that can't see the patterns. Always
-- plan with the actual patterns.
SET plan_cache_mode = force_custom_plan
-- The candidate queries cap rows without sorting (so a common word stops
-- scanning early); a non-parallel scan returns them in a stable order, so the
-- results are the same from call to call.
SET max_parallel_workers_per_gather = 0
SET synchronize_seqscans = off
AS $function$
DECLARE
  v_q text;         -- the query, normalized as match_name is
  v_nothe text;     -- v_q without a leading "the"
  v_core text;      -- v_nothe without a trailing legal form (exact matching only)
  v_exacts text[];  -- names that are v_core with those put back
  v_spaced text;    -- v_q with camelCase split ("SitStayRead" → "sit stay read"), else NULL
  v_ein text;
  v_all_words text[];
  v_distinctive text[];
  v_stop text[] := ARRAY['the','of','for','and','a','an','inc','incorporated','llc','co','org','corp','corporation','ltd'];
  v_last text;    -- the query's last word, which may be partly typed
  w text;
  v_driver text;
  v_loose text;   -- single-word candidate pattern
  v_loose2 text;  -- second pattern for a short word (word start mid-name)
  v_long text[];  -- distinctive words with 3+ characters (indexable)
  v_all1 text;    -- up to four patterns a name must ALL match
  v_all2 text;
  v_all3 text;
  v_all4 text;
  e_first text;   -- the query's first word (past "the"), unless a stop word
  v_min_len int;  -- shortest word length that counts as a hit
  v_counted int;  -- how many query words count toward hits
  v_key_words text[];  -- the words that count; a candidate must contain one
  v_all_cap int;  -- row cap for the all-words set
  v_short text;   -- a 2-letter word the all-words set must also contain
  v_typed text[]; -- the query's words as typed (before any camelCase split)
BEGIN
  -- No organization name is this long, and every query word costs a string
  -- search per candidate row: bound the work an anonymous caller can ask for.
  p_query := btrim(left(btrim(regexp_replace(left(p_query, 4000), '\s+', ' ', 'g')), 200));
  -- Anon can call this RPC directly, past the Edge Function's clamp.
  p_limit := LEAST(GREATEST(coalesce(p_limit, 15), 1), 50);
  p_state := upper(btrim(p_state));
  IF p_state !~ '^[A-Z]{2}$' THEN
    p_state := NULL;
  END IF;

  IF p_query IS NULL OR p_query !~ '[[:alnum:]]' THEN
    RETURN;
  END IF;

  -- EIN lookup: 7-9 digits, or the dashed "12-3456789" form. Stored EINs may
  -- or may not keep a leading zero, so match both forms.
  IF p_query ~ '^\d{7,9}$' OR p_query ~ '^\d{2}-\d{7}$' THEN
    v_ein := replace(p_query, '-', '');
    -- One row per organization, the recipient row preferred.
    RETURN QUERY
    SELECT DISTINCT ON (lpad(x._ein, 9, '0'))
           x._id, x._ein, x._name, x._state, x._etype, x._gc, x._tf
    FROM (
      SELECT f.id::text AS _id, f.id::text AS _ein, f.name::text AS _name, f.state::text AS _state,
             'funder'::text AS _etype, 0::bigint AS _gc, coalesce(f.total_giving, 0)::numeric AS _tf
      FROM funders f
      WHERE f.id IN (v_ein, lpad(v_ein, 9, '0'), ltrim(v_ein, '0'))
      UNION ALL
      SELECT r.id::text, r.ein::text, r.name::text, r.primary_state::text, 'recipient'::text,
             coalesce(r.grant_count, 0)::bigint, coalesce(r.total_funding, 0)::numeric
      FROM recipient_organizations r
      WHERE r.ein IN (v_ein, lpad(v_ein, 9, '0'), ltrim(v_ein, '0'))
    ) x
    ORDER BY lpad(x._ein, 9, '0'), (x._etype = 'recipient') DESC, x._id
    LIMIT p_limit;
    RETURN;
  END IF;

  v_q := public.org_search_norm(p_query);
  IF v_q = '' THEN
    RETURN;
  END IF;
  -- "the community foundation" also finds "COMMUNITY FOUNDATION …", and
  -- "foster foundation" finds "FOSTER FOUNDATION INC".
  -- A trailing "co"/"corp" may be a word being typed ("peace corp"), so only
  -- exact matching drops it.
  v_nothe := regexp_replace(v_q, '^the ', '');
  v_core := public.org_search_core(v_q);
  SELECT array_agg(p || v_core || x) INTO v_exacts
  FROM unnest(ARRAY['', 'the ']) p,
       unnest(ARRAY['', ' inc', ' incorporated', ' corp', ' corporation', ' co', ' llc', ' ltd', ' lp', ' pc']) x;
  v_spaced := public.org_search_norm(regexp_replace(p_query, '([a-z])([A-Z])', '\1 \2', 'g'));
  IF v_spaced = v_q THEN
    v_spaced := NULL;
  END IF;

  -- Words are runs of letters/digits (all that's left after normalizing), so
  -- they're safe in LIKE patterns and regexes as they are.
  v_all_words := string_to_array(coalesce(v_spaced, v_q), ' ');
  v_last := v_all_words[cardinality(v_all_words)];
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

  -- The first word, for the first-word tier: past a leading "the", as typed
  -- (or a run-together name's first camelCase part, when that's a real
  -- word), and not a stop word.
  v_typed := CASE WHEN v_spaced IS NULL THEN v_all_words ELSE string_to_array(v_q, ' ') END;
  e_first := v_typed[CASE WHEN v_typed[1] = 'the' THEN 2 ELSE 1 END];
  IF v_spaced IS NOT NULL
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

  -- The words that count toward hits (and that a candidate must contain one
  -- of): not stop words ("of", "inc"), unless the query is nothing but stop
  -- words ("the"), and not 1-letter words ("j paul getty"), unless the query
  -- has nothing longer ("c#").
  v_min_len := CASE WHEN EXISTS (SELECT 1 FROM unnest(v_all_words) x WHERE length(x) >= 2) THEN 2 ELSE 1 END;
  v_key_words := ARRAY(SELECT x FROM unnest(v_all_words) x WHERE length(x) >= v_min_len AND NOT (x = ANY(v_stop)));
  IF cardinality(v_key_words) = 0 THEN
    v_key_words := ARRAY(SELECT x FROM unnest(v_all_words) x WHERE length(x) >= v_min_len);
  END IF;
  v_counted := GREATEST(cardinality(v_key_words), 1);

  -- A 2-letter word can't drive the index but still narrows the all-words set
  -- ("uw madison"), unless a long word already contains it.
  SELECT '%' || dw || '%' INTO v_short FROM unnest(v_distinctive) WITH ORDINALITY AS t(dw, ord)
  WHERE length(dw) = 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_long) l WHERE strpos(l, dw) > 0)
  ORDER BY ord LIMIT 1;

  IF v_driver IS NULL THEN
    -- Only short words ("st", "uw") or stop words: names with a word starting
    -- with it, at the start or mid-name.
    v_loose := v_distinctive[1] || '%';
    v_loose2 := '% ' || v_distinctive[1] || '%';
  ELSIF array_length(v_long, 1) > 1 OR v_short IS NOT NULL THEN
    -- The driver alone, unnarrowed by the other words.
    v_loose := '%' || v_driver || '%';
  END IF;
  -- A camelCase split can leave the real word unsearched ("McDonald" → 'mc' +
  -- 'donald'): search the typed word too.
  IF v_spaced IS NOT NULL THEN
    SELECT x INTO w FROM unnest(v_typed) WITH ORDINALITY AS t(x, ord)
    WHERE length(x) >= 3 AND NOT (x = ANY(v_all_words)) ORDER BY ord LIMIT 1;
    IF w IS NOT NULL AND v_driver IS NOT NULL AND strpos(w, v_driver) = 1 THEN
      NULL;
    ELSIF w IS NOT NULL AND v_driver IS NULL THEN
      v_loose2 := '%' || w || '%';
    ELSIF w IS NOT NULL THEN
      v_loose := '%' || w || '%';
    END IF;
  END IF;

  v_all1 := '%' || v_long[1] || '%';
  v_all2 := '%' || v_long[2] || '%';  -- NULL when absent
  v_all3 := '%' || v_long[3] || '%';
  v_all4 := '%' || v_long[4] || '%';
  -- With 2+ words the all-words set is selective by construction, so a larger
  -- cap costs little; with one word it's as broad as the other sets.
  v_all_cap := CASE WHEN array_length(v_long, 1) > 1 OR v_short IS NOT NULL THEN 2000 ELSE 500 END;

  RETURN QUERY
  WITH combined AS (
    -- Bounded candidate sets, each capped without sorting so a common word
    -- stops scanning early; ranking happens on their union below. Funders and
    -- recipients are capped separately. The exact-name set guarantees an
    -- exact match is never cut by the others' caps.
    (SELECT s.id AS _id, s.ein AS _ein, s.name AS _name, s.match_name AS _match, s.state AS _state,
            s.kind AS _etype, s.grant_count AS _gc, s.total_funding AS _tf
       FROM org_search s
      WHERE s.kind = 'funder' AND s.match_name = ANY(v_exacts)
      LIMIT 500)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'funder' AND v_all1 IS NOT NULL AND s.match_name LIKE v_all1
        AND (v_all2 IS NULL OR s.match_name LIKE v_all2)
        AND (v_all3 IS NULL OR s.match_name LIKE v_all3)
        AND (v_all4 IS NULL OR s.match_name LIKE v_all4)
        AND (v_short IS NULL OR s.match_name LIKE v_short)
      LIMIT v_all_cap)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'funder'
        AND (s.match_name LIKE v_nothe || '%' OR s.match_name LIKE 'the ' || v_nothe || '%')
      LIMIT 500)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'funder' AND v_loose IS NOT NULL
        AND (s.match_name LIKE v_loose OR s.match_name LIKE v_loose2)
      LIMIT 500)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'recipient' AND s.match_name = ANY(v_exacts)
      LIMIT 500)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'recipient' AND v_all1 IS NOT NULL AND s.match_name LIKE v_all1
        AND (v_all2 IS NULL OR s.match_name LIKE v_all2)
        AND (v_all3 IS NULL OR s.match_name LIKE v_all3)
        AND (v_all4 IS NULL OR s.match_name LIKE v_all4)
        AND (v_short IS NULL OR s.match_name LIKE v_short)
      LIMIT v_all_cap)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'recipient'
        AND (s.match_name LIKE v_nothe || '%' OR s.match_name LIKE 'the ' || v_nothe || '%')
      LIMIT 500)
    UNION
    (SELECT s.id, s.ein, s.name, s.match_name, s.state, s.kind, s.grant_count, s.total_funding
       FROM org_search s
      WHERE s.kind = 'recipient' AND v_loose IS NOT NULL
        AND (s.match_name LIKE v_loose OR s.match_name LIKE v_loose2)
      LIMIT 500)
  ),
  measured AS (
    -- Per-row values the tiers share, computed once, on the normalized name.
    -- A query word hits when the name has it as a whole word, or (the last
    -- word, which may be partly typed) as the start of one; a word found only
    -- inside another ("mary" in "maryland") is half a hit.
    SELECT n.*,
      (SELECT coalesce(sum(CASE
                WHEN strpos(' ' || n._match || ' ', ' ' || kw || ' ') > 0 THEN 1
                WHEN kw = v_last AND strpos(' ' || n._match, ' ' || kw) > 0 THEN 1
                WHEN strpos(n._match, kw) > 0 THEN 0.5
                ELSE 0 END), 0)
         FROM unnest(v_key_words) kw) AS _hits,
      EXISTS (SELECT 1 FROM unnest(v_key_words) kw WHERE strpos(n._match, kw) > 0) AS _relevant,
      n._core = v_core AS _exact,
      n._core = v_core AND (n._nothe = v_nothe OR n._core = n._nothe OR v_core = v_nothe) AS _full_exact
    FROM (
      SELECT c.*,
        regexp_replace(c._match, '^the ', '') AS _nothe,
        public.org_search_core(c._match) AS _core
      FROM combined c
    ) n
  ),
  scored AS (
    SELECT m.*,
      -- Relevance tiers.
      -- Exact: the name is the query, give or take "the" and a legal form
      -- (half when both have one and they differ: "peace corp" may be
      -- "PEACE CORPS" being typed rather than "PEACE INC").
      CASE WHEN NOT m._exact THEN 0 WHEN m._full_exact THEN 1.0 ELSE 0.5 END
      -- Starts with the whole query; else (much less) with its first word.
      + CASE
        WHEN m._nothe LIKE v_nothe || '%' THEN 0.80
        WHEN e_first IS NOT NULL AND m._nothe ~ ('^' || e_first || '( |$)') THEN 0.20
        ELSE 0
      END
      -- The whole query as whole words anywhere ("bill and melinda gates
      -- foundation" for "gates foundation").
      + CASE WHEN strpos(' ' || m._match || ' ', ' ' || v_nothe || ' ') > 0 THEN 0.50 ELSE 0 END
      -- Every query word; else a share.
      + CASE
        WHEN m._hits = v_counted THEN 0.30
        ELSE m._hits / v_counted * 0.25
      END
      AS _tier,
      -- With a state asked for, its organizations come first within each
      -- class of match: the name is (or starts with) the query's words; has
      -- them as a phrase, or starts with the query mid-word (still typing);
      -- has all its words. So "ymca" in CA lists CA's "YMCA OF …" before
      -- other states' "YMCA"s, but "care" in NY doesn't list CAREERWISE NEW
      -- YORK before CARE, and a weaker match never comes first.
      CASE
        WHEN m._full_exact OR m._nothe = v_nothe OR m._nothe LIKE v_nothe || ' %' THEN 3
        WHEN strpos(' ' || m._match || ' ', ' ' || v_nothe || ' ') > 0
          OR m._nothe LIKE v_nothe || '%' THEN 2
        WHEN m._hits = v_counted THEN 1
        ELSE 0
      END AS _class,
      (p_state IS NOT NULL AND m._state IS NOT DISTINCT FROM p_state) AS _in_state,
      -- Tiebreaks: trigram similarity and funding (each ≤ 0.05).
      extensions.similarity(m._match, coalesce(v_spaced, v_q)) * 0.05
      + CASE WHEN m._tf > 0 THEN LEAST(ln(m._tf + 1) / 24.0 * 0.05, 0.05) ELSE 0 END
      AS _fine
    FROM measured m
    -- A candidate must contain at least one distinctive query word.
    WHERE m._relevant
  ),
  deduped AS (
    -- One row per organization (EIN); fall back to the row id if an EIN is
    -- missing so such rows don't collapse together. The more relevant row
    -- wins; on a tie the recipient, then the lower id.
    SELECT DISTINCT ON (coalesce(lpad(nullif(s._ein, ''), 9, '0'), 'id:' || s._id))
      s._id, s._ein, s._name, s._state, s._etype, s._gc, s._tf, s._tier, s._class, s._in_state, s._fine
    FROM scored s
    ORDER BY coalesce(lpad(nullif(s._ein, ''), 9, '0'), 'id:' || s._id),
             CASE WHEN p_state IS NULL THEN 0 ELSE s._class END DESC,
             s._tier DESC, s._in_state DESC, s._fine DESC, (s._etype = 'recipient') DESC, s._id
  )
  SELECT d._id, d._ein, d._name, d._state, d._etype, d._gc, d._tf
  FROM deduped d
  ORDER BY
    CASE WHEN p_state IS NULL THEN 0 ELSE d._class END DESC,
    (d._in_state AND d._class > 0) DESC,
    d._tier DESC, d._in_state DESC, d._fine DESC, d._tf DESC, d._id
  LIMIT p_limit;
END;
$function$;

-- prewarm_search_indexes as of 20261004120000.
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
    ['public.org_search_funder_match', 'read'],
    ['public.org_search_recipient_match', 'read'],
    ['public.org_search_funder_match_trgm', 'read'],
    ['public.org_search_recipient_match_trgm', 'read'],
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

DROP FUNCTION IF EXISTS public.org_search_refresh_alt(text, text, integer);
DROP FUNCTION IF EXISTS public.org_search_alt(text, text, text);
DROP TABLE IF EXISTS public.org_search_alias;

DROP FUNCTION IF EXISTS public.irs_bmf_add_recipients(timestamptz, text, integer);
DROP FUNCTION IF EXISTS public.irs_bmf_stage(jsonb, date);
DROP FUNCTION IF EXISTS public.irs_name_normalized(text);
DROP FUNCTION IF EXISTS public.irs_bmf_eligible(text, text, text, bigint);
DROP FUNCTION IF EXISTS public.irs_display_name(text, text, text, integer);
DROP FUNCTION IF EXISTS public.irs_own_name(text, text, text, integer);
DROP TABLE IF EXISTS public.irs_organizations;

COMMIT;

SELECT public.prewarm_search_indexes();

-- Optional, to also remove the organizations the IRS load added (and then the
-- source column). Recipients someone has since linked to (projects, saved
-- lists) or that have since received grants would be lost; check first.
-- DELETE FROM public.recipient_organizations WHERE source = 'irs_bmf' AND coalesce(grant_count, 0) = 0;
-- ALTER TABLE public.recipient_organizations DROP COLUMN IF EXISTS source;
