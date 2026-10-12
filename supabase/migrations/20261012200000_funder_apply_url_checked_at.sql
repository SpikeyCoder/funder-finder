-- FM-2026-10-12-01 (Trello #285): remember which funder homepages were scanned.
-- ─────────────────────────────────────────────────────────────────────────────
-- match-funders scans the homepage of each matched funder that has a website
-- but no apply_url / discovered_apply_url, looking for a grant application
-- link. Only hits were stored (discovered_apply_url), so the ~93% of homepages
-- without one (5,293 of 5,696 funders with a website) were fetched again on
-- every search, adding 6-24 s to matching and failing its 20 s SLA.
--
-- apply_url_checked_at records when a homepage was last scanned, hit or miss;
-- match-funders skips funders scanned within the last 30 days. It reads the
-- column in its own query and ignores errors, so the function works before
-- and after this migration.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.funders
  ADD COLUMN IF NOT EXISTS apply_url_checked_at timestamptz;

COMMENT ON COLUMN public.funders.apply_url_checked_at IS
  'When match-funders last scanned this funder''s homepage for a grant application link, '
  'found or not (FM-2026-10-12-01). Rescanned after 30 days.';
