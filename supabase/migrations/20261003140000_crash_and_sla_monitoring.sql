-- FM-2026-10-03-02: crashes and slow pages open Trello cards automatically.
-- ─────────────────────────────────────────────────────────────────────────────
-- Free, in-house replacement for a hosted crash reporter (Sentry's free plan
-- has no webhooks, so it can't open a card).
--
--   browser ──monitor-report──▶ monitor_crashes / monitor_vitals
--   pg_cron every 15 min ──▶ monitor-sweep ──▶ Trello (report-bug's list)
--                                 └─ also times live searches ──▶ monitor_sla_checks
--
-- The sweep opens a card for:
--   * each new crash fingerprint (most frequent first, at most 5 per run and
--     10 per 24 h; past that, one summary card a day says how many wait),
--     with its stack and how often it happened. A card that fails is retried
--     an hour later, and after 3 failures once a day;
--   * a page whose 75th-percentile LCP, INP or CLS over the last 24 h is
--     "poor" by web-vitals' thresholds, with at least 20 page views (once per
--     page and metric per 7 days; at most 5 a day). Paths are the app's
--     routes (anything else is "(other)"), so made-up paths add nothing;
--   * search breaching its SLA: synthetic checks failed or took over 2 s in
--     2 or more of the last hour's sweep runs (once per 24 h).
--
-- Only the public Edge Function writes reports, and only the sweep opens
-- cards, so flooding the endpoint can't flood Trello: at most 10 crash cards
-- a day plus one summary, and 5 page-speed cards, whatever is reported. Reports are rate-limited per
-- IP in the function (crashes 120/h, vitals 600/h).
--
-- Access: RLS on, no policies, no grants to anon/authenticated; only the
-- service role (the two Edge Functions) touches these tables.
--
-- Retention (compliance/retention-and-deletion.md): crash kinds unseen for
-- 90 days, vitals and SLA checks after 30 days, alert markers after 90 days,
-- and this sweep job's own run history after 30 days. Daily at 10:45 UTC.
-- Nothing here identifies a person: no user id, no IP; paths have ids and
-- query strings removed; email addresses in error text are masked.
-- Rollback: supabase/rollbacks/20261003140000_crash_and_sla_monitoring.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monitor_crashes (
  fingerprint      text PRIMARY KEY,           -- sha-256 hex, computed by monitor-report
  kind             text NOT NULL CHECK (kind IN ('boundary', 'error', 'rejection')),
  name             text NOT NULL,
  message          text NOT NULL,
  stack            text NOT NULL DEFAULT '',
  component_stack  text NOT NULL DEFAULT '',
  path             text NOT NULL,              -- of the latest occurrence
  release          text NOT NULL DEFAULT '',   -- entry chunk of the latest occurrence
  user_agent       text NOT NULL DEFAULT '',   -- of the latest occurrence
  occurrences      integer NOT NULL DEFAULT 1,
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  trello_card_url  text,
  -- The sweep claims a crash before opening its card, so overlapping runs
  -- can't both open one; a failed card is retried an hour later, and after
  -- 3 failures once a day.
  card_attempted_at timestamptz,
  card_attempts    integer NOT NULL DEFAULT 0,
  -- When it last took one of the day's card slots (its first try in 24 h;
  -- retries within the day don't move it), for the daily cap.
  card_counted_at  timestamptz,
  -- Set when a card's Trello call timed out: it may or may not exist, so
  -- it isn't retried (no duplicate) until the crash happens again a day
  -- later (see record_client_crash).
  card_uncertain_at timestamptz,
  -- A regression's earlier card, which may still be open: the new card
  -- links it so the two can be merged.
  previous_card_url text
);

-- The sweep's order for uncarded crashes: fewest tries, most frequent.
CREATE INDEX IF NOT EXISTS monitor_crashes_uncarded
  ON public.monitor_crashes (card_attempts, occurrences DESC, first_seen)
  WHERE trello_card_url IS NULL AND card_uncertain_at IS NULL;
-- The sweep's daily card count (crashes that took a slot in the last 24 h).
CREATE INDEX IF NOT EXISTS monitor_crashes_counted
  ON public.monitor_crashes (card_counted_at) WHERE card_counted_at IS NOT NULL;

-- One row per metric per page view: the browser re-sends a metric whenever
-- its value changes (INP and CLS keep growing while the page is open), keyed
-- by web-vitals' own per-page-view id, and the row keeps the latest value.
-- created_at is when it was last reported.
CREATE TABLE IF NOT EXISTS public.monitor_vitals (
  metric_id   text PRIMARY KEY,
  metric      text NOT NULL CHECK (metric IN ('LCP', 'INP', 'CLS')),
  value       double precision NOT NULL,
  rating      text NOT NULL CHECK (rating IN ('good', 'needs-improvement', 'poor')),
  path        text NOT NULL,
  release     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monitor_vitals_created ON public.monitor_vitals (created_at);

CREATE TABLE IF NOT EXISTS public.monitor_sla_checks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_name  text NOT NULL,
  ok          boolean NOT NULL,                -- 200 with a valid body, within the SLA
  status      integer,                         -- HTTP status; NULL on timeout/network error
  ms          integer NOT NULL,
  detail      text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monitor_sla_checks_checked ON public.monitor_sla_checks (checked_at);

-- One row per alert, claimed (last_carded_at = now, no URL yet) before its
-- card is opened, so overlapping runs can't both open it. A claim with no
-- card is retried after an hour; recording an opened card's URL is retried
-- too, and only if that keeps failing could a second card open.
CREATE TABLE IF NOT EXISTS public.monitor_alerts (
  alert_key        text PRIMARY KEY,           -- e.g. 'vitals:LCP:/search', 'sla:search'
  last_carded_at   timestamptz NOT NULL,
  trello_card_url  text
);

ALTER TABLE public.monitor_crashes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_vitals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_sla_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_alerts     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monitor_crashes, public.monitor_vitals, public.monitor_sla_checks, public.monitor_alerts
  FROM anon, authenticated;

-- ── Recording a crash ───────────────────────────────────────────────────────
-- One row per fingerprint: a repeat bumps the count and keeps the latest
-- occurrence's details (its release and browser are the most useful). The
-- kind becomes 'boundary' once any occurrence showed the error screen, so
-- the card says the worst way it was seen. A carded crash that comes back
-- after 7 quiet days (and 7 days after its card) counts as a regression: it
-- starts over and gets a new card. One still waiting for its card keeps its
-- count and its place in the queue. One whose card timed out (it may or may
-- not exist) is carded again if it happens again a day later; after 7 quiet
-- days that's a regression too.

CREATE OR REPLACE FUNCTION public.record_client_crash(
  p_fingerprint text, p_kind text, p_name text, p_message text, p_stack text,
  p_component_stack text, p_path text, p_release text, p_user_agent text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  -- A regression first starts over as if new (count 0, no card; the upsert
  -- below then counts it), so the 7-day rule lives in one place. Carded
  -- crashes, ones whose card timed out (it may exist), and ones the sweep
  -- gave up carding (10 tries: MAX_CARD_TRIES in monitor-sweep).
  UPDATE public.monitor_crashes
     SET occurrences = 0, first_seen = now(), kind = p_kind,
         -- (A timed-out card has no URL: keep the link to the one before.)
         previous_card_url = coalesce(trello_card_url, previous_card_url),
         trello_card_url = NULL, card_uncertain_at = NULL, card_attempted_at = NULL, card_counted_at = NULL,
         card_attempts = 0
   WHERE fingerprint = p_fingerprint AND last_seen < now() - interval '7 days'
     AND (trello_card_url IS NOT NULL OR card_uncertain_at IS NOT NULL OR card_attempts >= 10)
     AND card_attempted_at < now() - interval '7 days';

  -- Its card timed out a day or more ago (it may or may not exist) and it's
  -- still happening: due for a card again, since a crash that keeps
  -- happening must reach the board.
  UPDATE public.monitor_crashes
     SET card_uncertain_at = NULL
   WHERE fingerprint = p_fingerprint AND card_uncertain_at < now() - interval '1 day';

  INSERT INTO public.monitor_crashes AS c
    (fingerprint, kind, name, message, stack, component_stack, path, release, user_agent)
  VALUES
    (p_fingerprint, p_kind, p_name, p_message, p_stack, p_component_stack, p_path, p_release, p_user_agent)
  ON CONFLICT (fingerprint) DO UPDATE
    SET occurrences = c.occurrences + 1,
        kind = CASE WHEN EXCLUDED.kind = 'boundary' THEN 'boundary' ELSE c.kind END,
        last_seen = now(),
        message = EXCLUDED.message,
        stack = EXCLUDED.stack,
        component_stack = EXCLUDED.component_stack,
        path = EXCLUDED.path,
        release = EXCLUDED.release,
        user_agent = EXCLUDED.user_agent;
$$;

REVOKE EXECUTE ON FUNCTION public.record_client_crash(text, text, text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_client_crash(text, text, text, text, text, text, text, text, text)
  TO service_role;

-- ── Slow pages ──────────────────────────────────────────────────────────────
-- Pages whose 75th-percentile value over the last 24 h is "poor" (the
-- threshold Core Web Vitals use), with enough page views to mean something.
-- Thresholds are web-vitals' own: LCP > 4000 ms, INP > 500 ms, CLS > 0.25.

CREATE OR REPLACE FUNCTION public.monitor_vitals_breaches(p_min_samples integer DEFAULT 20)
RETURNS TABLE (metric text, path text, samples bigint, p75 double precision, poor_share double precision)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT g.metric, g.path, g.samples, g.p75, g.poor_share
    FROM (
      SELECT v.metric, v.path, count(*) AS samples,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY v.value) AS p75,
             avg((v.rating = 'poor')::int)::double precision AS poor_share
        FROM public.monitor_vitals v
       WHERE v.created_at >= now() - interval '24 hours'
       GROUP BY v.metric, v.path
      HAVING count(*) >= p_min_samples
    ) g
   WHERE g.p75 > CASE g.metric WHEN 'LCP' THEN 4000 WHEN 'INP' THEN 500 ELSE 0.25 END
   ORDER BY g.samples DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.monitor_vitals_breaches(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monitor_vitals_breaches(integer) TO service_role;

-- ── Retention ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_monitoring()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_deleted integer := 0;
  v_n integer;
BEGIN
  DELETE FROM public.monitor_crashes WHERE last_seen < now() - interval '90 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  DELETE FROM public.monitor_vitals WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  DELETE FROM public.monitor_sla_checks WHERE checked_at < now() - interval '30 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  DELETE FROM public.monitor_alerts WHERE last_carded_at < now() - interval '90 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  -- The 15-minute sweep's own run history (96 rows a day), matched by its
  -- jobid or its command, and a run with no timestamps (failed before it
  -- started) aged by its runid, as purge_prewarm_run_details does.
  DELETE FROM cron.job_run_details
   WHERE (jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'monitor-sweep')
          OR command = 'SELECT public.invoke_monitor_sweep()')
     AND (coalesce(end_time, start_time) < now() - interval '30 days'
          OR (start_time IS NULL AND end_time IS NULL
              AND runid < (SELECT min(runid) FROM cron.job_run_details
                            WHERE start_time >= now() - interval '30 days')));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  RAISE LOG 'purge_monitoring: deleted % rows', v_deleted;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_monitoring() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'purge-monitoring',
  '45 10 * * *',
  $$SELECT public.purge_monitoring()$$
);

-- ── The sweep ───────────────────────────────────────────────────────────────
-- Called by pg_cron through pg_net, authenticated with CRON_SECRET from Vault,
-- exactly like invoke_organization_request_processor (20261002140000). A
-- no-op until both Vault secrets exist. At :06, :21, :36, :51: clear of the
-- 15-minute and hourly jobs, and 4 minutes after a prewarm-search-indexes
-- run (:02, :07, …), when its caches are coldest, so the SLA checks see
-- what visitors see at the worst point rather than the best.

CREATE OR REPLACE FUNCTION public.invoke_monitor_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret text;
  v_url text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
  SELECT rtrim(decrypted_secret, '/') INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE NOTICE 'invoke_monitor_sweep: vault secrets cron_secret / project_url are not set; skipping';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url     := v_url || '/functions/v1/monitor-sweep',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 120000
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.invoke_monitor_sweep() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'monitor-sweep',
  '6-59/15 * * * *',
  $$SELECT public.invoke_monitor_sweep()$$
);
