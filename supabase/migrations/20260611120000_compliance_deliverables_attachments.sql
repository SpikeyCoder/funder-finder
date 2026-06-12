-- FM-IC-RPT-002: Post-award compliance tracking — deliverables + attachments
--
-- The compliance_requirements table (Phase 5) already tracks a reporting
-- requirement's type, due_date, status and assignee. The 2026-06-11 usability
-- audit flagged that two pieces of a real post-award compliance tracker were
-- still missing: a structured list of *deliverables* per requirement, and
-- persisted *attachments* (proof of submission / report files). Previously the
-- ProjectWorkspace UI let a user pick a file but the name was dropped server
-- side, and there was no deliverables concept at all.
--
-- Both additions are purely additive (new columns with safe defaults), so this
-- migration is backward compatible with existing rows and code paths.

ALTER TABLE public.compliance_requirements
  ADD COLUMN IF NOT EXISTS deliverables jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attachments  jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Shape documentation (enforced in the application layer / edge function):
--   deliverables: [ { "id": text, "text": text, "done": boolean } ]
--   attachments:  [ { "name": text, "url": text|null, "uploaded_at": timestamptz } ]
COMMENT ON COLUMN public.compliance_requirements.deliverables IS
  'Checklist of deliverables for this reporting requirement: [{id,text,done}]';
COMMENT ON COLUMN public.compliance_requirements.attachments IS
  'Attached files (proof of submission / report docs): [{name,url,uploaded_at}]';
