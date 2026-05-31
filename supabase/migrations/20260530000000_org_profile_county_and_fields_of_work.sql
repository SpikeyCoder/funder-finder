-- =====================================================================
-- FM-IC-ONB-003: Org profile — county-level location & fields of work
--
-- Closes the Instrumentl competitive gap audit finding that the org
-- profile only captured state-level location and NTEE codes. We add:
--   * user_profiles.county  (text)          — county-level granularity
--   * user_profiles.fields_of_work (text[]) — plain-language program areas
--     (complements ntee_codes, which is the IRS classification system)
--
-- The handle_new_user() SECURITY DEFINER trigger is updated to persist
-- county and fields_of_work from signup metadata. Idempotent: re-running
-- is safe because columns are added with IF NOT EXISTS and the trigger
-- replaces in place.
-- =====================================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS county text;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS fields_of_work text[];

COMMENT ON COLUMN public.user_profiles.county IS
  'County-level org location (FM-IC-ONB-003). Optional; complements city + state.';
COMMENT ON COLUMN public.user_profiles.fields_of_work IS
  'Plain-language fields of work (e.g. {"Workforce Development","Youth Mentoring"}). '
  'Complements ntee_codes (IRS classification) per FM-IC-ONB-003.';

-- ---------------------------------------------------------------------
-- Refresh handle_new_user() so county + fields_of_work are persisted
-- from raw_user_meta_data at signup.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  meta   jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_ntee text[] := NULL;
  v_fow  text[] := NULL;
BEGIN
  IF jsonb_typeof(meta->'ntee_codes') = 'array' THEN
    SELECT array_agg(value)
      INTO v_ntee
      FROM jsonb_array_elements_text(meta->'ntee_codes') AS value;
  END IF;

  IF jsonb_typeof(meta->'fields_of_work') = 'array' THEN
    SELECT array_agg(value)
      INTO v_fow
      FROM jsonb_array_elements_text(meta->'fields_of_work') AS value
     WHERE value IS NOT NULL AND value <> '';
  END IF;

  INSERT INTO public.user_profiles (
    id, display_name, organization_name, ein, mission_statement,
    city, state, county, ntee_codes, fields_of_work, budget_range
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
    NULLIF(meta->>'county', ''),
    v_ntee,
    v_fow,
    NULLIF(meta->>'budget_range', '')
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name      = COALESCE(public.user_profiles.display_name, EXCLUDED.display_name),
    organization_name = COALESCE(EXCLUDED.organization_name, public.user_profiles.organization_name),
    ein               = COALESCE(EXCLUDED.ein, public.user_profiles.ein),
    mission_statement = COALESCE(EXCLUDED.mission_statement, public.user_profiles.mission_statement),
    city              = COALESCE(EXCLUDED.city, public.user_profiles.city),
    state             = COALESCE(EXCLUDED.state, public.user_profiles.state),
    county            = COALESCE(EXCLUDED.county, public.user_profiles.county),
    ntee_codes        = COALESCE(EXCLUDED.ntee_codes, public.user_profiles.ntee_codes),
    fields_of_work    = COALESCE(EXCLUDED.fields_of_work, public.user_profiles.fields_of_work),
    budget_range      = COALESCE(EXCLUDED.budget_range, public.user_profiles.budget_range),
    updated_at        = now();

  RETURN NEW;
END;
$function$;
