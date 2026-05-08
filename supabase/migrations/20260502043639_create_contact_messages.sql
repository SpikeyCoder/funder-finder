CREATE TABLE contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the service role (edge function) can insert
ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;

-- No public access — only service_role can read/write
CREATE POLICY "service_role_full_access" ON contact_messages
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
