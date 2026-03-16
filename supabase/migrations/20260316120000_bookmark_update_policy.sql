-- Add missing UPDATE policy for bookmarked_passages (needed for star rating changes)
CREATE POLICY bookmarks_update ON public.bookmarked_passages FOR UPDATE USING (user_id = auth.uid());
