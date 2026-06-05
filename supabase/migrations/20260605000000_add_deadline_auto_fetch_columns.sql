-- Add deadline auto-fetch metadata columns to tracked_grants
-- These columns track the source, confidence, and recency of auto-scraped deadlines
-- populated by the fetch-grant-deadline edge function when a user tracks a funder.

ALTER TABLE public.tracked_grants
  ADD COLUMN IF NOT EXISTS deadline_source       text,
  ADD COLUMN IF NOT EXISTS deadline_confidence   text,
  ADD COLUMN IF NOT EXISTS deadline_last_checked timestamptz;

COMMENT ON COLUMN public.tracked_grants.deadline_source IS
  'How this grant's deadline was obtained: auto-scraped, manual, check-deadlines.';
COMMENT ON COLUMN public.tracked_grants.deadline_confidence IS
  'LLM-reported confidence in the extracted deadline: high, medium, low, none.';
COMMENT ON COLUMN public.tracked_grants.deadline_last_checked IS
  'Timestamp of the most recent deadline fetch attempt.';
