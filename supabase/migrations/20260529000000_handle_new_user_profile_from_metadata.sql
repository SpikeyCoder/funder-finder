-- =====================================================================
-- Populate user_profiles from signup metadata in the SECURITY DEFINER
-- trigger instead of via a client-side upsert.
--
-- Why: the SPA signup flow ran `supabase.auth.signUp()` and then upserted
-- into user_profiles from the browser. With email confirmation enabled,
-- signUp() returns no session, so that write executed as the anon role
-- (auth.uid() IS NULL) and was correctly rejected by the
-- "Users can insert/update own profile" RLS policies
-- (WITH CHECK auth.uid() = id) -> "new row violates row-level security
-- policy for table user_profiles".
--
-- Fix: the client now passes the profile fields through signUp's
-- options.data (raw_user_meta_data). This trigger, which is SECURITY
-- DEFINER and therefore bypasses RLS, reads them and writes the full
-- profile row at account-creation time. No authenticated session needed.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  meta   jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_ntee text[] := NULL;
BEGIN
  IF jsonb_typeof(meta->'ntee_codes') = 'array' THEN
    SELECT array_agg(value)
      INTO v_ntee
      FROM jsonb_array_elements_text(meta->'ntee_codes') AS value;
  END IF;

  INSERT INTO public.user_profiles (
    id, display_name, organization_name, ein, mission_statement,
    city, state, ntee_codes, budget_range
  )
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(meta->>'organization_name', ''),
      meta->>'full_name',
      meta->>'name',
      split_part(NEW.email, '@', 1)
    ),
    NULLIF(meta->>'organization_name', ''),
    NULLIF(meta->>'ein', ''),
    NULLIF(meta->>'mission_statement', ''),
    NULLIF(meta->>'city', ''),
    NULLIF(meta->>'state', ''),
    v_ntee,
    NULLIF(meta->>'budget_range', '')
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name      = COALESCE(public.user_profiles.display_name, EXCLUDED.display_name),
    organization_name = COALESCE(EXCLUDED.organization_name, public.user_profiles.organization_name),
    ein               = COALESCE(EXCLUDED.ein, public.user_profiles.ein),
    mission_statement = COALESCE(EXCLUDED.mission_statement, public.user_profiles.mission_statement),
    city              = COALESCE(EXCLUDED.city, public.user_profiles.city),
    state             = COALESCE(EXCLUDED.state, public.user_profiles.state),
    ntee_codes        = COALESCE(EXCLUDED.ntee_codes, public.user_profiles.ntee_codes),
    budget_range      = COALESCE(EXCLUDED.budget_range, public.user_profiles.budget_range),
    updated_at        = now();

  RETURN NEW;
END;
$function$;
