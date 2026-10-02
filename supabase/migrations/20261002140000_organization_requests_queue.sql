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
--      the outcome (for needs_review: that a person is reviewing it). The
--      address is unconfirmed, so emails never quote the visitor's text.
--
-- Access: RLS on with no policies, and no grants to anon/authenticated — only
-- the service role (the two Edge Functions) touches this table.
--
-- Retention (see compliance/retention-and-deletion.md): requester_email is
-- cleared 30 days after a request is processed; a request still unprocessed
-- after 30 days is closed as failed and its email cleared; rows are deleted
-- after 180 days. Scheduled at 10:35 UTC, after the existing 10:xx purge jobs.
-- ─────────────────────────────────────────────────────────────────────────────

-- The processor is invoked over HTTP from pg_cron (below).
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

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
  notified_at          timestamptz,
  claimed_at           timestamptz  -- set by the processor run working on it
);

-- One open request per organization and requester: a repeat submission joins
-- the pending one, but a second person asking for the same organization gets
-- their own row so they're notified too (the later one resolves as
-- already_listed once the first adds it).
-- (The state is part of it: a resubmission that adds or corrects the state
-- is a new request, not a duplicate.)
-- An EIN request is keyed by the EIN alone, however the name was typed.
CREATE UNIQUE INDEX IF NOT EXISTS organization_requests_pending_dedupe
  ON public.organization_requests
     ((CASE WHEN ein IS NULL THEN lower(query) ELSE '' END), coalesce(ein, ''), coalesce(state, ''),
      coalesce(lower(requester_email), ''))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS organization_requests_status_created
  ON public.organization_requests (status, created_at);

ALTER TABLE public.organization_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organization_requests FROM anon, authenticated;

-- ── Adding a recipient ──────────────────────────────────────────────────────
-- The processor adds an organization through this, not a plain INSERT: it
-- locks the EIN and inserts only if neither stored form (zero-padded or not)
-- exists, so two runs resolving requests for the same organization can't
-- both add it. recipient_organizations.ein has no unique constraint, and
-- adding one to a table other pipelines load is out of scope here.

CREATE OR REPLACE FUNCTION public.add_requested_recipient(
  p_ein text, p_name text, p_name_normalized text,
  p_city text, p_state text, p_ntee_code text)
RETURNS TABLE (id uuid, created boolean)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_ein !~ '^\d{9}$' THEN
    RAISE EXCEPTION 'add_requested_recipient: EIN must be 9 digits';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('organization-request:' || p_ein));

  SELECT r.id INTO v_id
    FROM public.recipient_organizations r
   WHERE r.ein IN (p_ein, ltrim(p_ein, '0'))
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  INSERT INTO public.recipient_organizations
    (ein, name, name_normalized, primary_city, primary_state, ntee_code, ntee_codes)
  VALUES
    (p_ein, p_name, p_name_normalized, p_city, p_state, p_ntee_code,
     CASE WHEN p_ntee_code IS NULL THEN '{}'::text[] ELSE ARRAY[p_ntee_code] END)
  RETURNING recipient_organizations.id INTO v_id;
  RETURN QUERY SELECT v_id, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_requested_recipient(text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_requested_recipient(text, text, text, text, text, text)
  TO service_role;

-- ── Retention ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_expired_organization_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- A request still pending after 30 days isn't going to be processed (the
  -- queue isn't running): close it out and drop the email with it. (Clearing
  -- only the email of a pending row could collide with another pending row
  -- for the same organization in the dedupe index and fail the whole job.)
  UPDATE public.organization_requests
     SET status = 'failed', processed_at = now(),
         last_error = 'expired: not processed within 30 days',
         requester_email = NULL, claimed_at = NULL
   WHERE status = 'pending'
     AND created_at < now() - interval '30 days';

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
-- Vault under the name 'cron_secret', and the project's URL (e.g.
-- https://<ref>.supabase.co) under 'project_url', so a branch or staging
-- database calls its own functions, not production's. Until both secrets
-- exist the job is a no-op, so deploying this migration before configuring
-- them is safe. pg_net sends no JWT: deploy the processor with
-- --no-verify-jwt (its CRON_SECRET check authenticates the call).

CREATE OR REPLACE FUNCTION public.invoke_organization_request_processor()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret text;
  v_url text;
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
  SELECT rtrim(decrypted_secret, '/') INTO v_url
    FROM vault.decrypted_secrets
   WHERE name = 'project_url'
   LIMIT 1;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE NOTICE 'invoke_organization_request_processor: vault secrets cron_secret / project_url are not set; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/functions/v1/process-organization-requests',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', v_secret
    ),
    timeout_milliseconds := 120000
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
