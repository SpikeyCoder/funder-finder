-- FM-IC-CFG-001: user-defined custom fields on tracked grants/opportunities.
--
-- Instrumentl lets users add arbitrary custom data fields to opportunities.
-- We store them as a JSON object of string -> string on tracked_grants so no
-- schema migration is needed when a user invents a new field. RLS on
-- tracked_grants already scopes rows to the owner.

ALTER TABLE public.tracked_grants
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
