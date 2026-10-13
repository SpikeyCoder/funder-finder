-- FM-2026-10-13-01: grant-uploads files are readable and deletable only by
-- the user who uploaded them.
-- ─────────────────────────────────────────────────────────────────────────────
-- The bucket is private, but its policies (added outside migrations) only
-- checked bucket_id: anyone with the public anon key, signed in or not, could
-- list, download and delete every user's uploaded past grants and reference
-- documents, and upload into the bucket.
--
-- Both uploaders are signed in: the AI Grant Writer (`<session>/<uuid>.<ext>`,
-- for the grant-writer function) and Project Workspace reference docs
-- (`reference-docs/<user>/<grant>/<ts>.<ext>`). Storage records the uploader's
-- auth uid in owner_id, and grant-writer already treats it as the owner, so
-- the policies check owner_id rather than the path. The grant-writer and
-- ai-draft functions read files with the service role, which bypasses these
-- policies, so each checks owner_id against storage.objects itself before a
-- download (ai-draft also requires Project Workspace's path shape in the
-- caller's folder). No UPDATE policy: nothing overwrites an upload
-- (upsert: false).
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Allow anon uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon reads" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon deletes" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated reads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated deletes" ON storage.objects;

DROP POLICY IF EXISTS "grant-uploads: owner uploads" ON storage.objects;
CREATE POLICY "grant-uploads: owner uploads" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'grant-uploads' AND owner_id = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "grant-uploads: owner reads" ON storage.objects;
CREATE POLICY "grant-uploads: owner reads" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'grant-uploads' AND owner_id = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "grant-uploads: owner deletes" ON storage.objects;
CREATE POLICY "grant-uploads: owner deletes" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'grant-uploads' AND owner_id = (SELECT auth.uid())::text);
