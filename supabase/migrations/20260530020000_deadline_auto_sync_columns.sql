-- =====================================================================
-- FM-IC-NTF-002 / PR #21 consolidation: deadline auto-sync metadata
--
-- Adds throttle metadata so the check-deadlines cron can re-fetch each
-- tracked grant's deadline from its source URL without spamming a
-- funder's website. The actual scrape lives in the fetch-grant-deadline
-- edge function.
--
-- Columns:
--   deadline_synced_at      timestamptz — last scrape attempt (regardless of outcome)
--   deadline_sync_status    text         — 'high'|'medium'|'low'|'none'|'error'|null
--   deadline_sync_note      text         — short human-readable explanation from the LLM
-- =====================================================================

ALTER TABLE public.tracked_grants
  ADD COLUMN IF NOT EXISTS deadline_synced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_sync_status text,
  ADD COLUMN IF NOT EXISTS deadline_sync_note   text;

COMMENT ON COLUMN public.tracked_grants.deadline_synced_at IS
  'Most recent fetch-grant-deadline attempt against grant_url (FM-IC-NTF-002 auto-update).';
COMMENT ON COLUMN public.tracked_grants.deadline_sync_status IS
  'Confidence reported by the LLM extractor: high|medium|low|none|error.';
COMMENT ON COLUMN public.tracked_grants.deadline_sync_note IS
  'One-line explanation surfaced from the LLM extractor for audit/UI display.';

-- Partial index lets the cron find grants due for a refresh quickly without
-- scanning awarded/rejected rows.
CREATE INDEX IF NOT EXISTS idx_tracked_grants_due_for_deadline_sync
  ON public.tracked_grants (deadline_synced_at NULLS FIRST)
  WHERE grant_url IS NOT NULL;
