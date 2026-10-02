-- FM-2026-10-02-02: let people request an organization that isn't in FunderMatch.
-- ─────────────────────────────────────────────────────────────────────────────
-- Trello #153: "If a non-profit or foundation isn't available or in the
-- system, there should be [an] error message and opportunity to submit it as a
-- request, which would get searched and processed in a queue in an automated
-- way."
--
-- Flow:
--   1. /search shows "No organizations match …" with a "Request it" form.
--   2. The public `request-organization` Edge Function validates the request,
--      rate-limits it per IP and inserts a `pending` row here.
--   3. pg_cron calls `process-organization-requests` every 15 minutes (only
--      when something is pending). It looks the organization up in IRS data
--      via the ProPublica Nonprofit Explorer API and resolves each request to:
--        already_listed — the EIN is already in funders / recipient_organizations
--        added          — a public charity, matched by EIN or a near-exact name,
--                         inserted into recipient_organizations so it shows up in
--                         search (its profile renders from IRS data until grants
--                         are ingested)
--        needs_review   — a private foundation (needs the 990-PF funder pipeline)
--                         or only approximate name matches (kept in `candidates`)
--        not_found      — no IRS record matches
--        failed         — the lookup errored 3 times
--   4. If the requester left an email and RESEND_API_KEY is set, they're told
--      the outcome.
--
-- Access: RLS on with no policies, and no grants to anon/authenticated — only
-- the service role (the two Edge Functions) touches this table.
--
-- Retention (see compliance/retention-and-deletion.md): requester_email is
-- cleared 30 days after a request is processed; rows are deleted after 180
-- days. Scheduled at 10:35 UTC, after the existing 10:xx purge jobs.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.organization_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query                text NOT NULL CHECK (char_length(query) BETWEEN 2 AND 200),
  ein                  text CHECK (ein ~ '^\d{9}$'),
  state                text CHECK (state ~ '^[A-Z]{2}$'),
  requester_email      text CHECK (
                         requester_email IS NULL
                         OR (char_length(requester_email) <= 254
                             AND requester_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN
                         ('pending', 'added', 'already_listed', 'needs_review', 'not_found', 'failed')),
  attempts             integer NOT NULL DEFAULT 0,
  resolved_entity_type text CHECK (resolved_entity_type IN ('funder', 'recipient')),
  resolved_id          text,
  candidates           jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  notified_at          timestamptz
);

-- One open request per organization: a repeat submission joins the pending one.
CREATE UNIQUE INDEX IF NOT EXISTS organization_requests_pending_dedupe
  ON public.organization_requests (lower(query), coalesce(ein, ''))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS organization_requests_status_created
  ON public.organization_requests (status, created_at);

ALTER TABLE public.organization_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organization_requests FROM anon, authenticated;

-- ── Retention ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_expired_organization_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.organization_requests
     SET requester_email = NULL
   WHERE requester_email IS NOT NULL
     AND processed_at < now() - interval '30 days';

  DELETE FROM public.organization_requests
   WHERE created_at < now() - interval '180 days';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_expired_organization_requests() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'purge-organization-requests';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'purge-organization-requests',
  '35 10 * * *',
  $$SELECT public.purge_expired_organization_requests()$$
);

-- ── Queue processing ────────────────────────────────────────────────────────
-- pg_cron can't call HTTPS itself, so it calls this function, which POSTs to
-- the processor via pg_net. The processor requires CRON_SECRET (same scheme as
-- send-reminders / process-notifications); this reads the same value from
-- Vault under the name 'cron_secret'. Until that secret exists the job is a
-- no-op, so deploying this migration before configuring it is safe.

CREATE OR REPLACE FUNCTION public.invoke_organization_request_processor()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_requests WHERE status = 'pending'
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'cron_secret'
   LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'invoke_organization_request_processor: vault secret cron_secret is not set; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := 'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/process-organization-requests',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', v_secret
    ),
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.invoke_organization_request_processor() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'process-organization-requests';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
END $$;

SELECT cron.schedule(
  'process-organization-requests',
  '*/15 * * * *',
  $$SELECT public.invoke_organization_request_processor()$$
);
