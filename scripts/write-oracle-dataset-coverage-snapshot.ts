import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  ORACLE_DATASET_COVERAGE_TABLE,
  type OracleDatasetCoverageRow,
  type OracleDatasetCoverageSnapshot,
} from "../src/coverage/oracleDatasetCoverage.js";

/**
 * Read `oracle_dataset_coverage` for a county and write a local JSON snapshot
 * for the publish step to push to Filebase/IPFS (for MCP `getOracleDatasetInfo`
 * reads via DATASET_COVERAGE_MAP).
 */

export type WriteCoverageSnapshotOptions = {
  readonly county: string;
  readonly databaseUrl: string;
  /**
   * Local file the snapshot is also written to (for the Filebase publish step).
   * Defaults to `.dataset-coverage/<county>/dataset-coverage.json`.
   */
  readonly localPath?: string;
};

/** Default local snapshot path for a county. */
export function defaultCoverageLocalPath(county: string): string {
  return join(".dataset-coverage", county, "dataset-coverage.json");
}

/**
 * Raw coverage row as returned by the pg driver. `ingested_count` /
 * `expected_count` map to Postgres `bigint` columns, which node-postgres
 * surfaces as JS strings (not numbers) to avoid precision loss.
 */
type RawCoverageRow = {
  readonly county: string;
  readonly source: string;
  readonly ingested_count: string | number | null;
  readonly expected_count: string | number | null;
  readonly first_loaded_at: string | null;
  readonly last_loaded_at: string | null;
  readonly cid: string | null;
  readonly ipns_label: string | null;
};

/**
 * Coerce a bigint-as-text / numeric DB value into a finite JS number.
 *
 * @param value - Raw column value (string, number, null, or undefined).
 * @param fallback - Value returned when the input is null/undefined/non-finite.
 * @returns A finite number, or the fallback.
 */
export function coerceCount(
  value: string | number | null | undefined,
  fallback: number | null,
): number | null {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalize a raw pg coverage row into the numeric MCP contract shape.
 *
 * Postgres returns `bigint` columns as strings; the published snapshot MUST
 * carry numeric counts so the MCP's `OracleDatasetCoverageSnapshotSchema`
 * (`ingested_count: z.number()`) accepts it. Without this, the snapshot fails
 * schema validation and `getOracleDatasetInfo` silently drops `datasets[]`.
 *
 * @param row - Raw coverage row from Postgres.
 * @returns Coverage row with numeric `ingested_count` / `expected_count`.
 */
export function normalizeCoverageRow(
  row: RawCoverageRow,
): OracleDatasetCoverageRow {
  return {
    county: row.county,
    source: row.source,
    ingested_count: coerceCount(row.ingested_count, 0) ?? 0,
    expected_count: coerceCount(row.expected_count, null),
    first_loaded_at: row.first_loaded_at,
    last_loaded_at: row.last_loaded_at,
    cid: row.cid,
    ipns_label: row.ipns_label,
  };
}

/**
 * Load all coverage rows for a county from Neon.
 *
 * @param databaseUrl - Direct Postgres connection string.
 * @param county - Hyphen county slug.
 * @returns Coverage rows for the county, with numeric counts.
 */
export async function loadCoverageRowsForCounty(
  databaseUrl: string,
  county: string,
): Promise<readonly OracleDatasetCoverageRow[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<RawCoverageRow>(
      `SELECT county, source, ingested_count, expected_count,
              first_loaded_at::text AS first_loaded_at,
              last_loaded_at::text AS last_loaded_at,
              cid, ipns_label
       FROM ${ORACLE_DATASET_COVERAGE_TABLE}
       WHERE county = $1
       ORDER BY source`,
      [county],
    );
    return result.rows.map(normalizeCoverageRow);
  } finally {
    await pool.end();
  }
}

/**
 * Write the coverage snapshot object to a local transient file for IPFS publish.
 *
 * @param options - County, DB URL, and local destination path.
 * @returns The snapshot that was written.
 */
export async function writeCoverageSnapshot(
  options: WriteCoverageSnapshotOptions,
): Promise<OracleDatasetCoverageSnapshot> {
  const datasets = await loadCoverageRowsForCounty(options.databaseUrl, options.county);
  const snapshot: OracleDatasetCoverageSnapshot = {
    county: options.county,
    exportedAt: new Date().toISOString(),
    datasets,
  };
  const body = JSON.stringify(snapshot);
  const localPath = options.localPath ?? defaultCoverageLocalPath(options.county);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, body, "utf8");

  console.log(
    JSON.stringify({
      event: "oracle_dataset_coverage_snapshot_written",
      localPath,
      datasetCount: datasets.length,
    }),
  );
  return snapshot;
}

async function main(): Promise<void> {
  const county = process.env.COUNTY;
  const databaseUrl = process.env.DATABASE_URL;
  if (county === undefined || county.length === 0) {
    throw new Error("COUNTY is required");
  }
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  await writeCoverageSnapshot({ county, databaseUrl });
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "oracle_dataset_coverage_snapshot_failed", error: message }));
    process.exit(1);
  });
}
