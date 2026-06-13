-- FM-IC-AI-002: Learning loop for AI grant writing.
--
-- The grant-writer edge function previously only learned from documents the
-- user uploaded in the current session. To "resurface and learn from past
-- successful applications" (Instrumentl gap AI-002) we let users mark the
-- outcome of each knowledge-base entry and opt entries in/out of the learning
-- corpus. grant-writer then prioritises entries marked 'awarded' when it
-- builds the style guide for a new draft.

ALTER TABLE public.application_knowledge_base
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS use_for_learning boolean NOT NULL DEFAULT true;

-- Constrain outcome to a known set. Use a NOT VALID check then validate so the
-- statement is safe on tables that already hold rows (all default to 'unknown').
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_knowledge_base_outcome_check'
  ) THEN
    ALTER TABLE public.application_knowledge_base
      ADD CONSTRAINT application_knowledge_base_outcome_check
      CHECK (outcome IN ('awarded', 'submitted', 'rejected', 'draft', 'unknown'));
  END IF;
END $$;

-- Partial index to make the "awarded, opted-in" lookup in grant-writer cheap.
CREATE INDEX IF NOT EXISTS idx_kb_user_outcome_learning
  ON public.application_knowledge_base (user_id, outcome)
  WHERE use_for_learning = true;
