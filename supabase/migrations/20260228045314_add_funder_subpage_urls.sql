
ALTER TABLE funders
  ADD COLUMN IF NOT EXISTS contact_url  TEXT,
  ADD COLUMN IF NOT EXISTS programs_url TEXT,
  ADD COLUMN IF NOT EXISTS apply_url    TEXT,
  ADD COLUMN IF NOT EXISTS news_url     TEXT;

COMMENT ON COLUMN funders.contact_url  IS 'Staff directory or contact/team page';
COMMENT ON COLUMN funders.programs_url IS 'Programs, initiatives, or portfolio page';
COMMENT ON COLUMN funders.apply_url    IS 'How-to-apply, LOI, RFP, or grant guidelines page';
COMMENT ON COLUMN funders.news_url     IS 'News, updates, or annual reports page';
;
