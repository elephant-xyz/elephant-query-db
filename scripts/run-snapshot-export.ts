import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";

export type SnapshotManifest = {
  readonly schemaVersion: "1";
  readonly county: string;
  readonly snapshotAt: string;
  readonly dumpFile: string;
  readonly dumpBytes: number;
  readonly dumpSha256: string;
  readonly tableCounts: Record<string, number>;
  readonly migrationVersion: string;
};

export type SnapshotExportOptions = {
  readonly bucket: string;
  readonly county: string;
  readonly envFile: string;
  readonly keyPrefix: string | null;
  readonly outDir: string;
};

type S3Keys = {
  readonly dumpKey: string;
  readonly manifestKey: string;
};

const DEFAULT_BUCKET = "elephant-oracle-node-environmentbucket-mmsoo3xbdi80";

const SNAPSHOT_TABLES: readonly string[] = [
  "unnormalized_addresses",
  "addresses",
  "parcels",
  "properties",
  "property_improvements",
  "people",
  "companies",
  "deeds",
  "fact_sheets",
  "geometries",
  "sales_histories",
  "taxes",
  "property_valuations",
  "structures",
  "utilities",
  "layouts",
  "lots",
  "flood_storm_information",
  "files",
  "ownerships",
  "permit_contacts",
  "inspections",
  "permit_events",
  "permit_fees",
  "permit_links",
  "permit_custom_fields",
  "permit_list_windows",
  "business_registrations",
  "business_registration_annual_reports",
  "business_registration_addresses",
  "business_registration_parties",
  "business_reputation_profiles",
  "business_reputation_alternate_names",
  "business_reputation_categories",
  "business_reputation_rating_reasons",
  "business_reputation_contacts",
  "business_reputation_licenses",
  "business_reputation_service_areas",
  "business_reputation_locations",
  "business_reputation_reviews",
  "business_reputation_complaints",
  "business_reputation_complaint_events",
  "business_reputation_media",
  "business_reputation_external_links",
  "contractor_quality_scores",
];

/**
 * Build the S3 key prefix for a snapshot.
 *
 * @param county - County slug used to scope the prefix.
 * @param snapshotAt - ISO 8601 timestamp used to build the path segment.
 * @returns Key prefix string ending with `/`.
 */
export function buildKeyPrefix(county: string, snapshotAt: string): string {
  const timestamp = formatTimestamp(snapshotAt);
  return `snapshots/${county}/${timestamp}/`;
}

/**
 * Build the dump and manifest S3 keys from a prefix, county, and timestamp.
 *
 * @param prefix - Key prefix (must end with `/`).
 * @param county - County slug.
 * @param timestamp - Compact timestamp string (YYYYMMDDTHHMMSSZ).
 * @returns Dump and manifest S3 keys.
 */
export function buildS3Keys(prefix: string, county: string, timestamp: string): S3Keys {
  return {
    dumpKey: `${prefix}snapshot-${county}-${timestamp}.sql.gz`,
    manifestKey: `${prefix}manifest.json`,
  };
}

/**
 * Compute the SHA-256 hex digest of a file by streaming its contents.
 *
 * @param filePath - Absolute path to the file to hash.
 * @returns Hex-encoded SHA-256 digest.
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const readStream = createReadStream(filePath);
  await pipeline(readStream, hash);
  return hash.digest("hex");
}

/**
 * Read the last migration tag from a Drizzle journal JSON file.
 *
 * @param journalPath - Absolute path to the `_journal.json` file.
 * @returns Tag string from the last journal entry.
 */
export async function readMigrationVersion(journalPath: string): Promise<string> {
  const text = readFileSync(journalPath, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error(`Invalid journal file at ${journalPath}: missing entries array`);
  }
  const entries = parsed.entries;
  const last = entries[entries.length - 1];
  if (last === undefined) {
    throw new Error(`Journal file at ${journalPath} has no entries`);
  }
  if (typeof last !== "object" || last === null || !("tag" in last) || typeof last.tag !== "string") {
    throw new Error(`Invalid journal entry in ${journalPath}: missing tag field`);
  }
  return last.tag;
}

/**
 * Parse CLI arguments into snapshot export options.
 *
 * @param argv - Raw command-line argument list after the script path.
 * @returns Normalized snapshot export options.
 */
export function parseOptions(argv: readonly string[]): SnapshotExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.startsWith("--") === false) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && next.startsWith("--") === false) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  return {
    bucket: values.get("bucket") ?? DEFAULT_BUCKET,
    county: values.get("county") ?? "lee",
    envFile: values.get("env-file") ?? ".env.local",
    keyPrefix: values.get("key-prefix") ?? null,
    outDir: values.get("out-dir") ?? ".snapshot-export",
  };
}

/**
 * Spawn pg_dump and pipe its output through gzip into a local file.
 *
 * @param params.connectionString - PostgreSQL connection string.
 * @param params.outputPath - Local file path to write the gzip-compressed dump.
 * @returns Promise that resolves when the dump is complete.
 */
export async function runPgDump(params: {
  readonly connectionString: string;
  readonly outputPath: string;
}): Promise<void> {
  const pgDumpStderr: Buffer[] = [];
  const gzipStderr: Buffer[] = [];

  const pgDump = spawn("pg_dump", ["--format=plain", "--no-password", params.connectionString], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const gzip = spawn("gzip", ["-c"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  pgDump.stderr?.on("data", (chunk: Buffer) => { pgDumpStderr.push(chunk); });
  gzip.stderr?.on("data", (chunk: Buffer) => { gzipStderr.push(chunk); });

  const fileWriteStream = createWriteStream(params.outputPath);

  await Promise.all([
    pipeline(pgDump.stdout!, gzip.stdin!),
    pipeline(gzip.stdout!, fileWriteStream),
    new Promise<void>((resolve, reject) => {
      pgDump.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const stderr = Buffer.concat(pgDumpStderr).toString("utf8").trim();
          reject(new Error(`pg_dump exited with code ${String(code)}: ${stderr}`));
        }
      });
      pgDump.on("error", reject);
    }),
    new Promise<void>((resolve, reject) => {
      gzip.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const stderr = Buffer.concat(gzipStderr).toString("utf8").trim();
          reject(new Error(`gzip exited with code ${String(code)}: ${stderr}`));
        }
      });
      gzip.on("error", reject);
    }),
  ]);
}

/**
 * Query row counts for all tracked tables using a pg Pool.
 *
 * @param pool - Postgres connection pool.
 * @returns Map of table name to row count.
 */
async function fetchTableCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SNAPSHOT_TABLES) {
    const result = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM "${table}"`);
    const row = result.rows[0];
    counts[table] = row !== undefined ? Number.parseInt(row.count, 10) : 0;
  }
  return counts;
}

/**
 * Load key-value pairs from a dotenv-style file without echoing secrets.
 *
 * @param envFile - File path containing `KEY=value` pairs.
 */
function loadEnvFile(envFile: string): void {
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex);
      const value = trimmed.slice(equalsIndex + 1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return;
    throw caught;
  }
}

/**
 * Format an ISO 8601 timestamp as a compact YYYYMMDDTHHMMSSZ string.
 *
 * @param isoString - ISO 8601 timestamp string.
 * @returns Compact timestamp string.
 */
function formatTimestamp(isoString: string): string {
  return isoString.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/Z$/, "Z");
}

/**
 * Upload a local file to S3 with the given key and content type.
 *
 * @param params.s3 - AWS S3 client.
 * @param params.bucket - Target S3 bucket.
 * @param params.key - Target S3 object key.
 * @param params.filePath - Local path to the file to upload.
 * @param params.contentType - MIME type for the uploaded object.
 * @param params.contentLength - Byte size of the file.
 * @returns Promise that resolves after the upload completes.
 */
async function uploadFileToS3(params: {
  readonly s3: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly filePath: string;
  readonly contentType: string;
  readonly contentLength: number;
}): Promise<void> {
  const body = createReadStream(params.filePath);
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: body,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    }),
  );
}

/**
 * Upload a JSON string to S3 with the given key.
 *
 * @param params.s3 - AWS S3 client.
 * @param params.bucket - Target S3 bucket.
 * @param params.key - Target S3 object key.
 * @param params.body - JSON string to upload.
 * @returns Promise that resolves after the upload completes.
 */
async function uploadJsonToS3(params: {
  readonly s3: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly body: string;
}): Promise<void> {
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: "application/json",
    }),
  );
}

/**
 * Run the snapshot export: dump database, build manifest, upload both to S3.
 *
 * @returns Promise that resolves after the export finishes or rejects on error.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile} or the environment`);
  }

  const snapshotAt = new Date().toISOString();
  const timestamp = formatTimestamp(snapshotAt);
  const keyPrefix = options.keyPrefix ?? buildKeyPrefix(options.county, snapshotAt);
  const { dumpKey, manifestKey } = buildS3Keys(keyPrefix, options.county, timestamp);

  const dumpFileName = `snapshot-${options.county}-${timestamp}.sql.gz`;
  const dumpFilePath = join(options.outDir, dumpFileName);
  const manifestFilePath = join(options.outDir, "manifest.json");

  // TODO(multi-county): per-track scoping (sunbiz/BBB scope by address-match, not a column)
  const county = options.county;

  console.log(
    JSON.stringify({
      event: "snapshot_export_started",
      county,
      bucket: options.bucket,
      keyPrefix,
    }),
  );

  const s3 = new S3Client({});
  const pg = new Pool({
    application_name: "elephant-snapshot-export",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 2,
  });

  pg.on("error", (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "database_pool_error", error: message }));
  });

  try {
    // Ensure output directory exists
    const { mkdir } = await import("node:fs/promises");
    await mkdir(options.outDir, { recursive: true });

    console.log(JSON.stringify({ event: "snapshot_db_dump_started" }));

    await runPgDump({ connectionString: databaseUrl, outputPath: dumpFilePath });

    const dumpStats = await stat(dumpFilePath);
    const dumpBytes = dumpStats.size;
    const dumpSha256 = await computeFileSha256(dumpFilePath);

    console.log(
      JSON.stringify({
        event: "snapshot_db_dump_finished",
        dumpFile: dumpFileName,
        dumpBytes,
      }),
    );

    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const journalPath = join(scriptDir, "..", "migrations", "meta", "_journal.json");
    const migrationVersion = await readMigrationVersion(journalPath);
    const tableCounts = await fetchTableCounts(pg);

    const manifest: SnapshotManifest = {
      schemaVersion: "1",
      county,
      snapshotAt,
      dumpFile: dumpFileName,
      dumpBytes,
      dumpSha256,
      tableCounts,
      migrationVersion,
    };

    await writeFile(manifestFilePath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      JSON.stringify({
        event: "snapshot_manifest_built",
        tableCounts,
        migrationVersion,
      }),
    );

    const dumpUri = `s3://${options.bucket}/${dumpKey}`;
    const manifestUri = `s3://${options.bucket}/${manifestKey}`;

    console.log(
      JSON.stringify({
        event: "snapshot_s3_upload_started",
        dumpKey,
        manifestKey,
      }),
    );

    await uploadFileToS3({
      s3,
      bucket: options.bucket,
      key: dumpKey,
      filePath: dumpFilePath,
      contentType: "application/gzip",
      contentLength: dumpBytes,
    });

    await uploadJsonToS3({
      s3,
      bucket: options.bucket,
      key: manifestKey,
      body: `${JSON.stringify(manifest, null, 2)}\n`,
    });

    console.log(
      JSON.stringify({
        event: "snapshot_s3_upload_finished",
        dumpUri,
        manifestUri,
      }),
    );

    console.log(
      JSON.stringify({
        event: "snapshot_export_finished",
        county,
        dumpUri,
        manifestUri,
        dumpBytes,
      }),
    );
  } catch (caught) {
    // Clean up partial dump file on failure
    await rm(dumpFilePath, { force: true });
    throw caught;
  } finally {
    await pg.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ event: "snapshot_export_failed", error: message }));
  process.exit(1);
});
