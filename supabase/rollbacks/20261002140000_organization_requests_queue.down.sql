-- Rollback for 20261002140000_organization_requests_queue.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never applies it.
-- Apply manually: psql "$DATABASE_URL" -f supabase/rollbacks/20261002140000_organization_requests_queue.down.sql
--
-- Also undeploy the request-organization and process-organization-requests
-- Edge Functions, and revert get-recipient-profile.

BEGIN;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname IN ('process-organization-requests', 'purge-organization-requests')
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;
END $$;

-- Organizations the queue added have no grants and exist only because of it.
-- Remove them (only if they still have no grants) so search doesn't keep
-- linking to them after the profile fallback is reverted. (Only those whose
-- request rows still exist: rows are purged after 180 days, so a later
-- rollback leaves older additions in place.)
DELETE FROM public.recipient_organizations r
 USING public.organization_requests q
 WHERE q.status = 'added'
   AND q.resolved_entity_type = 'recipient'
   AND r.id::text = q.resolved_id
   AND coalesce(r.grant_count, 0) = 0;

DROP FUNCTION IF EXISTS public.invoke_organization_request_processor();
DROP FUNCTION IF EXISTS public.add_requested_recipient(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.purge_expired_organization_requests();
DROP TABLE IF EXISTS public.organization_requests;

COMMIT;
