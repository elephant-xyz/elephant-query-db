import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";

import {
  ORACLE_DATASET_COVERAGE_TABLE,
  type OracleDatasetCoverageRow,
  type OracleDatasetCoverageSnapshot,
} from "../src/coverage/oracleDatasetCoverage.js";

/**
 * Read `oracle_dataset_coverage` for a county and write a JSON snapshot to the
 * incremental-status bucket (for operators) AND to a local file so the publish
 * step can push it to public IPFS (for MCP `getOracleDatasetInfo` reads via
 * DATASET_COVERAGE_MAP).
 */

export type WriteCoverageSnapshotOptions = {
  readonly county: string;
  readonly databaseUrl: string;
  readonly statusBucket: string;
  readonly statusKeyPrefix?: string;
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
 * Load all coverage rows for a county from Neon.
 *
 * @param databaseUrl - Direct Postgres connection string.
 * @param county - Hyphen county slug.
 * @returns Coverage rows for the county.
 */
export async function loadCoverageRowsForCounty(
  databaseUrl: string,
  county: string,
): Promise<readonly OracleDatasetCoverageRow[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<OracleDatasetCoverageRow>(
      `SELECT county, source, ingested_count, expected_count,
              first_loaded_at::text AS first_loaded_at,
              last_loaded_at::text AS last_loaded_at,
              cid, ipns_label
       FROM ${ORACLE_DATASET_COVERAGE_TABLE}
       WHERE county = $1
       ORDER BY source`,
      [county],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

/**
 * Write the coverage snapshot object to S3.
 *
 * @param options - County, DB URL, and destination bucket/key parts.
 * @returns The snapshot that was written.
 */
export async function writeCoverageSnapshotToS3(
  options: WriteCoverageSnapshotOptions,
): Promise<OracleDatasetCoverageSnapshot> {
  const prefix = options.statusKeyPrefix ?? `incremental-status/${options.county}`;
  const key = `${prefix}/dataset-coverage.json`;
  const datasets = await loadCoverageRowsForCounty(options.databaseUrl, options.county);
  const snapshot: OracleDatasetCoverageSnapshot = {
    county: options.county,
    exportedAt: new Date().toISOString(),
    datasets,
  };
  const body = JSON.stringify(snapshot);
  const s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: options.statusBucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }),
  );

  // Also write a local copy so the publish step can push it to public IPFS.
  const localPath = options.localPath ?? defaultCoverageLocalPath(options.county);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, body, "utf8");

  console.log(
    JSON.stringify({
      event: "oracle_dataset_coverage_snapshot_written",
      bucket: options.statusBucket,
      key,
      localPath,
      datasetCount: datasets.length,
    }),
  );
  return snapshot;
}

async function main(): Promise<void> {
  const county = process.env.COUNTY;
  const statusBucket = process.env.STATUS_BUCKET;
  const databaseUrl = process.env.DATABASE_URL;
  if (county === undefined || county.length === 0) {
    throw new Error("COUNTY is required");
  }
  if (statusBucket === undefined || statusBucket.length === 0) {
    throw new Error("STATUS_BUCKET is required");
  }
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  await writeCoverageSnapshotToS3({ county, statusBucket, databaseUrl });
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
