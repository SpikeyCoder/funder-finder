-- FM-2026-10-12-01 (Trello #285): remember which funder homepages to leave alone.
-- ─────────────────────────────────────────────────────────────────────────────
-- match-funders scans the homepage of each returned funder that has a website
-- but no apply_url / discovered_apply_url, looking for a grant application
-- link. Only hits were stored (discovered_apply_url), so the ~93% of homepages
-- without one (5,293 of 5,696 funders with a website) were fetched again on
-- every search, adding 6-24 s to matching and failing its 20 s SLA.
--
-- apply_url_recheck_at is when a homepage is next worth scanning: 30 days
-- after one is scanned without a grant link (or is gone, not HTML, or
-- redirects off-site), 1 day after one fails to load. match-funders skips
-- funders until then. It reads the column in its own query and ignores
-- errors, so the function works before and after this migration.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.funders
  ADD COLUMN IF NOT EXISTS apply_url_recheck_at timestamptz;

COMMENT ON COLUMN public.funders.apply_url_recheck_at IS
  'When match-funders may next scan this funder''s homepage for a grant application link: '
  '30 days after a scan finds none, 1 day after the homepage fails to load (FM-2026-10-12-01).';
