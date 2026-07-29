-- FM-2026-07-29-04 (follow-up): schedule the rate-limit bucket purge.
-- ─────────────────────────────────────────────────────────────────────────────
-- 20260729040000 created public.purge_expired_rate_limit_hits() but never
-- scheduled it, so public.rate_limit_hits would grow unbounded — one row per
-- unique (namespace, IP) pair, and five of the nineteen rate-limited functions
-- are public/unauthenticated (contact-form, report-bug, share-link,
-- calendar-feed, match-funders), so the key space is "every IP that has ever
-- touched us", not "every user".
--
-- Follows the existing retention convention from 20260515000000: a daily job in
-- the 10:xx UTC block, preceded by an unschedule-if-exists guard so the
-- migration is safe to re-run.
--
--   10:15  purge-access-log
--   10:20  purge-grant-drafts
--   10:25  purge-search-signal-events
--   10:30  purge-rate-limit-hits   <- this migration
--
-- Daily is comfortably sufficient: the longest window any caller uses is one
-- hour (contact-form), and the purge deletes anything older than a day, so a
-- row is only ever retained well past the point it can affect a decision.
-- Tighten to every few hours if the table ever grows enough to matter; the
-- delete is indexed on window_start.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-rate-limit-hits';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'purge-rate-limit-hits',
  '30 10 * * *',
  $$SELECT public.purge_expired_rate_limit_hits()$$
);
