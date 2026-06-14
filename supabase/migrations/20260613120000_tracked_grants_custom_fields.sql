-- FM-IC-CFG-001 — User-defined custom fields on tracked grants
--
-- Instrumentl competitive gap CFG-001: "Add custom data fields to
-- funders/opportunities." FunderMatch users want to attach their own
-- structured metadata to a tracked grant (e.g. "Program Officer",
-- "Internal Priority", "CRM ID") without us pre-defining every column.
--
-- We store these as a JSONB map of { label: value } on the tracked_grants
-- row. This keeps the schema flexible (no migration per new field), is
-- owned by the same row, and is automatically covered by the existing
-- per-user RLS policies on tracked_grants (no new policy required, since
-- access is still gated by user_id on the same row).
--
-- Values are stored/read as strings from the UI; the JSONB column tolerates
-- arbitrary JSON should future callers need richer types.

ALTER TABLE public.tracked_grants
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.tracked_grants.custom_fields IS
  'FM-IC-CFG-001: user-defined custom fields as a { label: value } JSON map. Editable from the grant detail drawer in the project workspace.';
