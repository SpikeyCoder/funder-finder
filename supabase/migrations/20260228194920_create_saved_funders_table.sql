
-- saved_funders: persists a user's saved funder list across devices
CREATE TABLE IF NOT EXISTS public.saved_funders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  funder_id   text NOT NULL,
  funder_data jsonb NOT NULL,          -- snapshot of the Funder row at save time
  saved_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, funder_id)           -- one row per user+funder pair
);

-- Index for fast per-user lookups
CREATE INDEX IF NOT EXISTS saved_funders_user_id_idx ON public.saved_funders (user_id);

-- Enable RLS
ALTER TABLE public.saved_funders ENABLE ROW LEVEL SECURITY;

-- Users can only see their own saved funders
CREATE POLICY "Users can view their own saved funders"
  ON public.saved_funders
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own saved funders
CREATE POLICY "Users can insert their own saved funders"
  ON public.saved_funders
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own saved funders
CREATE POLICY "Users can delete their own saved funders"
  ON public.saved_funders
  FOR DELETE
  USING (auth.uid() = user_id);
;
