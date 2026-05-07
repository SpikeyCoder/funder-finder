-- Fix 1: Set search_path on auto_track_saved_funder
ALTER FUNCTION public.auto_track_saved_funder() SET search_path = public;

-- Fix 2: Set search_path on auto_untrack_removed_funder
ALTER FUNCTION public.auto_untrack_removed_funder() SET search_path = public;
