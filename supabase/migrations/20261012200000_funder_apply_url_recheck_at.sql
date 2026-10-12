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
-- before and after this migration. Changing a funder's website clears it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.funders
  ADD COLUMN IF NOT EXISTS apply_url_recheck_at timestamptz;

COMMENT ON COLUMN public.funders.apply_url_recheck_at IS
  'When match-funders may next scan this funder''s homepage for a grant application link: '
  '30 days after a scan finds none, 1 day after the homepage fails to load; cleared when '
  'website changes (FM-2026-10-12-01).';

CREATE OR REPLACE FUNCTION public.funders_clear_apply_url_recheck()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.apply_url_recheck_at := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS funders_clear_apply_url_recheck ON public.funders;
CREATE TRIGGER funders_clear_apply_url_recheck
  BEFORE UPDATE OF website ON public.funders
  FOR EACH ROW
  WHEN (NEW.website IS DISTINCT FROM OLD.website)
  EXECUTE FUNCTION public.funders_clear_apply_url_recheck();
