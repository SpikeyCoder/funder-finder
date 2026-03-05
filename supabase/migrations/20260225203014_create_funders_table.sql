
-- Funders table: stores real nonprofit/foundation data from ProPublica
CREATE TABLE funders (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'foundation',
  description  TEXT,
  focus_areas  TEXT[] DEFAULT '{}',
  ntee_code    TEXT,
  city         TEXT,
  state        TEXT,
  website      TEXT,
  total_giving BIGINT,
  asset_amount BIGINT,
  income_amount BIGINT,
  contact_name  TEXT,
  contact_title TEXT,
  contact_email TEXT,
  grant_range_min INTEGER,
  grant_range_max INTEGER,
  next_step    TEXT,
  raw_data     JSONB DEFAULT '{}',
  last_synced  TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- FTS on a generated stored column instead
ALTER TABLE funders ADD COLUMN fts_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(name,'') || ' ' ||
      coalesce(description,'') || ' ' ||
      coalesce(ntee_code,'')
    )
  ) STORED;

CREATE INDEX funders_fts_idx    ON funders USING GIN (fts_vector);
CREATE INDEX funders_state_idx  ON funders (state);
CREATE INDEX funders_type_idx   ON funders (type);
CREATE INDEX funders_giving_idx ON funders (total_giving DESC NULLS LAST);

-- Search cache: stores semantic match results keyed by mission hash
CREATE TABLE search_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_hash TEXT NOT NULL UNIQUE,
  mission_text TEXT NOT NULL,
  results      JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX search_cache_hash_idx ON search_cache (mission_hash);
;
