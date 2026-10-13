-- FM-2026-10-12-01 (Trello #285): remember which funder homepages to leave alone.
-- ─────────────────────────────────────────────────────────────────────────────
-- match-funders scanned the homepage of each matched funder that has a website
-- but no apply_url / discovered_apply_url for a grant application link, inside
-- the visitor's request. Only hits were stored (discovered_apply_url), so the
-- ~93% of homepages without one (5,293 of 5,696 funders with a website) were
-- fetched again on every search, adding 6-24 s to matching and failing its
-- 20 s SLA. The scan now runs after the response.
--
-- apply_url_recheck_at is when a homepage is next worth scanning: 30 days
-- after one is scanned without a grant link (or is gone, or not HTML), 1 day
-- after one fails to load. match-funders skips funders until then. It reads
-- the column in its own query and ignores errors, so the function works
-- before and after this migration. Moving a funder's website to another page
-- clears it, and the discovered_apply_url found on the old one (rewriting the
-- same page, e.g. adding https://, www. or a trailing slash, doesn't).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.funders
  ADD COLUMN IF NOT EXISTS apply_url_recheck_at timestamptz;

COMMENT ON COLUMN public.funders.apply_url_recheck_at IS
  'When match-funders may next scan this funder''s homepage for a grant application link: '
  '30 days after a scan finds none, 1 day after the homepage fails to load; cleared, with '
  'discovered_apply_url, when website moves to another page (FM-2026-10-12-01).';

-- A funders.website value as host and path: no scheme, www., query, fragment,
-- trailing slash or case.
CREATE OR REPLACE FUNCTION public.funder_website_key(website text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT nullif(rtrim(regexp_replace(lower(btrim(website)), '^([a-z][a-z0-9+.-]*://)?(www\.)?([^?#]*).*$', '\3'), '/'), '')
$function$;

CREATE OR REPLACE FUNCTION public.funders_reset_apply_url_discovery()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Each unless this update sets it for the new site too
  IF NEW.apply_url_recheck_at IS NOT DISTINCT FROM OLD.apply_url_recheck_at THEN
    NEW.apply_url_recheck_at := NULL;
  END IF;
  IF NEW.discovered_apply_url IS NOT DISTINCT FROM OLD.discovered_apply_url THEN
    NEW.discovered_apply_url := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER funders_reset_apply_url_discovery
  BEFORE UPDATE OF website ON public.funders
  FOR EACH ROW
  WHEN (public.funder_website_key(NEW.website) IS DISTINCT FROM public.funder_website_key(OLD.website))
  EXECUTE FUNCTION public.funders_reset_apply_url_discovery();
