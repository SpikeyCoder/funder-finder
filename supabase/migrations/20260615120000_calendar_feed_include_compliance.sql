-- FM-IC-RPT-002: Surface post-award compliance reporting deadlines in calendar feeds
--
-- The 2026-06-11 usability audit flagged post-award compliance tracking as
-- PARTIAL: the compliance_requirements table (type, due_date, status,
-- assignee, deliverables, attachments) exists and a compliance summary is
-- shown on the Reports page, but reporting due-dates never reached the user's
-- actual calendar. Grant deadlines and tasks were emitted into the .ics feed;
-- compliance reporting deadlines were not, so a subscribed Google/Outlook/Apple
-- calendar showed application deadlines but no post-award report deadlines.
--
-- This adds an opt-out flag (default ON, mirroring include_tasks) so each feed
-- can include compliance reporting deadlines. Purely additive with a safe
-- default, so existing rows and the existing edge function path stay valid.

ALTER TABLE public.calendar_feeds
  ADD COLUMN IF NOT EXISTS include_compliance boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.calendar_feeds.include_compliance IS
  'When true, post-award compliance reporting due dates are emitted as events in the .ics feed.';
