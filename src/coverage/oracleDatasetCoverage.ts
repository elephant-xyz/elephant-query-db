/**
 * Shared contract for the `oracle_dataset_coverage` table.
 *
 * This module was referenced by the coverage backfill/upsert/snapshot scripts
 * and `tests/coverage.test.ts` but was missing from the repo (the coverage PRs
 * landed without it, breaking `npm run typecheck` and the test suite on main).
 * Reconstructed from those consumers: the table/column names come from
 * `migrations/0006_oracle_dataset_coverage.sql`, and
 * {@link toDatasetInfoCoverageEntry} mirrors the camelCase `datasets[]` entry
 * shape the MCP's `getOracleDatasetInfo` publishes.
 */

/** Physical Neon table holding per-county / per-source ingestion coverage. */
export const ORACLE_DATASET_COVERAGE_TABLE = "oracle_dataset_coverage";

/** Locked column set, in stable order (mirrors migration 0006). */
export const ORACLE_DATASET_COVERAGE_COLUMNS = [
  "county",
  "source",
  "ingested_count",
  "expected_count",
  "first_loaded_at",
  "last_loaded_at",
  "cid",
  "ipns_label",
] as const;

/** One coverage row (numeric counts — see `normalizeCoverageRow`). */
export type OracleDatasetCoverageRow = {
  readonly county: string;
  readonly source: string;
  readonly ingested_count: number;
  readonly expected_count: number | null;
  readonly first_loaded_at: string | null;
  readonly last_loaded_at: string | null;
  readonly cid: string | null;
  readonly ipns_label: string | null;
};

/** Published snapshot consumed by the MCP via `DATASET_COVERAGE_MAP`. */
export type OracleDatasetCoverageSnapshot = {
  readonly county: string;
  readonly exportedAt: string;
  readonly datasets: readonly OracleDatasetCoverageRow[];
};

/** CamelCase `datasets[]` entry as surfaced by `getOracleDatasetInfo`. */
export type DatasetInfoCoverageEntry = {
  readonly source: string;
  readonly ingestedCount: number;
  readonly expectedCount: number | null;
  readonly firstLoadedAt: string | null;
  readonly lastLoadedAt: string | null;
  readonly cid: string | null;
  readonly ipnsLabel: string | null;
};

/**
 * Map a DB coverage row to the camelCase MCP dataset-info entry.
 *
 * @param row - Coverage row with numeric counts.
 * @returns CamelCase entry for the published `datasets[]` array.
 */
export function toDatasetInfoCoverageEntry(
  row: OracleDatasetCoverageRow,
): DatasetInfoCoverageEntry {
  return {
    source: row.source,
    ingestedCount: row.ingested_count,
    expectedCount: row.expected_count,
    firstLoadedAt: row.first_loaded_at,
    lastLoadedAt: row.last_loaded_at,
    cid: row.cid,
    ipnsLabel: row.ipns_label,
  };
}
