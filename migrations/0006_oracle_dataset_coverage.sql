-- Per-county, per-source dataset coverage for Donphan qualify-by-coverage and getOracleDatasetInfo.
-- Teammates upsert rows (e.g. source = 'permits', 'appraisal') after inline harvest or bulk load.

CREATE TABLE IF NOT EXISTS oracle_dataset_coverage (
  county TEXT NOT NULL,
  source TEXT NOT NULL,
  ingested_count BIGINT NOT NULL DEFAULT 0,
  expected_count BIGINT,
  first_loaded_at TIMESTAMPTZ,
  last_loaded_at TIMESTAMPTZ,
  cid TEXT,
  ipns_label TEXT,
  PRIMARY KEY (county, source)
);

CREATE INDEX IF NOT EXISTS oracle_dataset_coverage_county_idx
  ON oracle_dataset_coverage (county);
