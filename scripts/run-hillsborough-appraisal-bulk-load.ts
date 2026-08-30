#!/usr/bin/env node
/**
 * Bulk-stream transformed Hillsborough appraisal parcel artifacts into Neon PostgreSQL
 * via temporary bulk stage tables and set-based SQL merges.
 *
 * @module elephant-query-db/scripts/run-hillsborough-appraisal-bulk-load
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { opendir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

import AdmZip from "adm-zip";
import { from as copyFrom } from "pg-copy-streams";
import { Client } from "pg";

import {
  mapAppraisalTransformedFile,
  mergeBulkStageTable,
  readBulkTableColumns,
  serializeBulkStageCsvHeader,
  serializeBulkStageCsvRow,
  type BulkMergeResult,
  type BulkTableColumn,
  type JsonObject,
  type LogicalTableName,
  type PreparedRow,
  type QueryClient,
  type QueryRowsResult,
} from "../src/loader/index.js";

const APPRAISAL_TABLE_ORDER: readonly LogicalTableName[] = [
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
];

export type HillsboroughAppraisalBulkLoadOptions = {
  readonly envFile: string;
  readonly parcelsDir: string;
  readonly countyName: string;
  readonly stateCode: string;
  readonly sourceSystem: string;
  readonly batchParcels: number;
  readonly limit: number | null;
  readonly offset: number;
  readonly dryRun: boolean;
  readonly checkpointFile: string;
};

/**
 * Parse CLI options.
 *
 * @param argv - CLI args array.
 * @returns Parsed options.
 */
export function parseOptions(argv: readonly string[]): HillsboroughAppraisalBulkLoadOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const limitRaw = values.get("limit");
  const limit = limitRaw === undefined ? null : Number(limitRaw);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  const offsetRaw = values.get("offset");
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error("--offset must be a non-negative number");
  }

  const batchParcelsRaw = values.get("batch-parcels");
  const batchParcels = batchParcelsRaw === undefined ? 10000 : Number(batchParcelsRaw);
  if (!Number.isFinite(batchParcels) || batchParcels <= 0) {
    throw new Error("--batch-parcels must be a positive number");
  }

  return {
    envFile: values.get("env-file") ?? ".env.local",
    parcelsDir:
      values.get("parcels-dir") ??
      "../oracle-node-hillsborough/downloads/hillsborough/full-run",
    countyName: values.get("county-name") ?? "Hillsborough",
    stateCode: values.get("state-code") ?? "FL",
    sourceSystem: values.get("source-system") ?? "hillsborough_appraiser",
    batchParcels,
    limit,
    offset,
    dryRun: values.get("dry-run") === "true",
    checkpointFile:
      values.get("checkpoint-file") ??
      "../oracle-node-hillsborough/downloads/hillsborough/appraisal-bulk-checkpoint.json",
  };
}

/**
 * Read DATABASE_URL from .env file.
 *
 * @param envFile - Env file path.
 * @returns Connection string.
 */
export function readDatabaseUrl(envFile: string): string {
  const text = readFileSync(envFile, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^DATABASE_URL=(.*)$/.exec(trimmed);
    if (match?.[1]) {
      return match[1].replace(/^['"]|['"]$/g, "");
    }
  }
  throw new Error(`DATABASE_URL not found in ${envFile}`);
}

/**
 * Create a keepalive PostgreSQL client for long operations.
 *
 * @param databaseUrl - Database connection string.
 * @returns Connected pg Client.
 */
async function createKeepaliveClient(databaseUrl: string): Promise<Client> {
  const client = new Client({
    connectionString: databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 60_000,
    application_name: "hillsborough-appraisal-bulk-loader",
  });
  await client.connect();
  return client;
}

/**
 * Wrap a pg Client in the narrow QueryClient interface.
 *
 * @param client - pg Client.
 * @returns QueryClient object.
 */
function createQueryClient(client: Client): QueryClient {
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ): Promise<QueryRowsResult<Row>> {
      const result = await client.query<Row>(text, values as unknown[]);
      return { rows: result.rows };
    },
  };
}

/**
 * Fast parallel loader for a single parcel directory.
 * Prioritizes `transformed_output.zip` for ~10x faster I/O over loose disk files.
 *
 * @param parcelDir - Path to parcel folder.
 * @param options - Configuration options.
 * @returns Array of prepared rows.
 */
async function loadParcelFast(
  parcelDir: string,
  options: HillsboroughAppraisalBulkLoadOptions,
): Promise<readonly PreparedRow[]> {
  const rows: PreparedRow[] = [];

  try {
    const zipPath = join(parcelDir, "transformed_output.zip");
    const zipBuf = await readFile(zipPath).catch(() => null);

    if (zipBuf !== null && zipBuf.length > 0) {
      const zip = new AdmZip(zipBuf);
      const entries = zip.getEntries();
      for (const entry of entries) {
        const entryName = entry.entryName;
        if (
          entryName.endsWith(".json") &&
          !entryName.startsWith("relationship_") &&
          !entry.isDirectory
        ) {
          try {
            const text = entry.getData().toString("utf8");
            const record = JSON.parse(text) as unknown;
            const bundle = mapAppraisalTransformedFile({
              filePath: entryName,
              record,
              artifactUri: `file://${parcelDir}/${entryName}`,
              sourceSystem: options.sourceSystem,
              countyName: options.countyName,
              stateCode: options.stateCode,
            });
            rows.push(...bundle.rows);
          } catch {}
        }
      }
      return rows;
    }

    // Fallback: loose files
    const dataDir = join(parcelDir, "data");
    const [dataFiles, seedText, addrText] = await Promise.all([
      readdir(dataDir).catch(() => []),
      readFile(join(parcelDir, "property_seed.json"), "utf8").catch(() => null),
      readFile(join(parcelDir, "unnormalized_address.json"), "utf8").catch(() => null),
    ]);

    if (seedText) {
      const b = mapAppraisalTransformedFile({
        filePath: "property_seed.json",
        record: JSON.parse(seedText) as unknown,
        artifactUri: `file://${join(parcelDir, "property_seed.json")}`,
        sourceSystem: options.sourceSystem,
        countyName: options.countyName,
        stateCode: options.stateCode,
      });
      rows.push(...b.rows);
    }
    if (addrText) {
      const b = mapAppraisalTransformedFile({
        filePath: "unnormalized_address.json",
        record: JSON.parse(addrText) as unknown,
        artifactUri: `file://${join(parcelDir, "unnormalized_address.json")}`,
        sourceSystem: options.sourceSystem,
        countyName: options.countyName,
        stateCode: options.stateCode,
      });
      rows.push(...b.rows);
    }

    const fileReads = dataFiles
      .filter((f) => f.endsWith(".json") && !f.startsWith("relationship_"))
      .map(async (fileName) => {
        try {
          const text = await readFile(join(dataDir, fileName), "utf8");
          const b = mapAppraisalTransformedFile({
            filePath: fileName,
            record: JSON.parse(text) as unknown,
            artifactUri: `file://${join(dataDir, fileName)}`,
            sourceSystem: options.sourceSystem,
            countyName: options.countyName,
            stateCode: options.stateCode,
          });
          return b.rows;
        } catch {
          return [];
        }
      });

    const fileResults = await Promise.all(fileReads);
    for (const r of fileResults) rows.push(...r);
  } catch {}

  return rows;
}

/**
 * Stage and merge one batch of prepared appraisal rows into Neon.
 *
 * @param params - Database connection and batch payload.
 * @returns Batch merge statistics.
 */
async function stageAndMergeBatch(params: {
  readonly databaseUrl: string;
  readonly batchIndex: number;
  readonly rows: readonly PreparedRow[];
  readonly columnsByTable: ReadonlyMap<LogicalTableName, readonly BulkTableColumn[]>;
}): Promise<readonly BulkMergeResult[]> {
  const stageTableName = `elephant_bulk_stage_appraisal_b${params.batchIndex}_${Date.now()}`;
  const stageCsvPath = `/tmp/${stageTableName}.csv`;

  // Write stage CSV
  const csvStream = createWriteStream(stageCsvPath, { encoding: "utf8" });
  csvStream.write(serializeBulkStageCsvHeader());
  for (let rowIndex = 0; rowIndex < params.rows.length; rowIndex += 1) {
    const row = params.rows[rowIndex];
    if (row !== undefined) {
      csvStream.write(serializeBulkStageCsvRow({ rowIndex, row }));
    }
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    csvStream.end((err?: Error | null) => {
      if (err) rejectPromise(err);
      else resolvePromise();
    });
  });

  const client = await createKeepaliveClient(params.databaseUrl);
  const queryClient = createQueryClient(client);

  try {
    await client.query(`DROP TABLE IF EXISTS public."${stageTableName}"`);
    await client.query(
      [
        `CREATE UNLOGGED TABLE public."${stageTableName}" (`,
        `"row_index" bigint NOT NULL,`,
        `"table_name" text NOT NULL,`,
        `"source_system" text NOT NULL,`,
        `"source_record_key" text NOT NULL,`,
        `"source_record_hash" text,`,
        `"source_artifact_uri" text,`,
        `"values_json" jsonb NOT NULL,`,
        `"references_json" jsonb NOT NULL DEFAULT '{}'::jsonb`,
        `)`,
      ].join(" "),
    );

    const copySql = `COPY public."${stageTableName}" ("row_index", "table_name", "source_system", "source_record_key", "source_record_hash", "source_artifact_uri", "values_json", "references_json") FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;
    const copyStream = client.query(copyFrom(copySql));
    await pipeline(createReadStream(stageCsvPath), copyStream);

    await client.query("SET maintenance_work_mem TO '256MB'");
    await client.query(
      `CREATE INDEX "${stageTableName}_table_idx" ON public."${stageTableName}" ("table_name")`,
    );
    await client.query(
      `CREATE INDEX "${stageTableName}_source_idx" ON public."${stageTableName}" ("source_system", "source_record_key")`,
    );
    await client.query(`ANALYZE public."${stageTableName}"`);

    const results: BulkMergeResult[] = [];
    await client.query("SET search_path TO public");
    await client.query("SET work_mem TO '128MB'");
    await client.query("SET random_page_cost TO 1.1");

    const presentRes = await client.query<{ table_name: string }>(
      `SELECT DISTINCT "table_name" FROM public."${stageTableName}"`,
    );
    const presentTables = new Set(presentRes.rows.map((r) => r.table_name));

    for (const tableName of APPRAISAL_TABLE_ORDER) {
      if (!presentTables.has(tableName)) continue;
      const columns = params.columnsByTable.get(tableName);
      if (columns === undefined) continue;

      await client.query("BEGIN");
      const res = await mergeBulkStageTable(queryClient, {
        stageTableName,
        tableName,
        columns,
      });
      await client.query("COMMIT");
      results.push(res);
    }

    await client.query(`DROP TABLE IF EXISTS public."${stageTableName}"`);
    return results;
  } finally {
    await client.end();
    try {
      unlinkSync(stageCsvPath);
    } catch {}
  }
}

/**
 * Main execution function.
 */
export async function runHillsboroughAppraisalBulkLoad(
  options: HillsboroughAppraisalBulkLoadOptions,
): Promise<{
  readonly totalParcelsRead: number;
  readonly totalPreparedRows: number;
  readonly batchesProcessed: number;
  readonly mergeResults: readonly BulkMergeResult[];
}> {
  const databaseUrl = readDatabaseUrl(options.envFile);
  const parcelsDir = resolve(options.parcelsDir);

  const metaClient = await createKeepaliveClient(databaseUrl);
  let columnsByTable: ReadonlyMap<LogicalTableName, readonly BulkTableColumn[]>;
  try {
    columnsByTable = await readBulkTableColumns(
      createQueryClient(metaClient),
      APPRAISAL_TABLE_ORDER,
    );
  } finally {
    await metaClient.end();
  }

  let totalParcelsRead = 0;
  let totalPreparedRows = 0;
  let batchIndex = 0;
  let currentBatchRows: PreparedRow[] = [];
  const allMergeResults: BulkMergeResult[] = [];
  const startedAtMs = Date.now();
  let lastCheckpointTime = startedAtMs;
  let lastCheckpointParcels = 0;

  const updateCheckpoint = (status: "in_progress" | "merging" | "completed"): void => {
    try {
      const now = Date.now();
      const elapsedTotalSec = Math.max(1, (now - startedAtMs) / 1000);
      const overallRatePerSec = totalParcelsRead / elapsedTotalSec;

      const windowSec = (now - lastCheckpointTime) / 1000;
      const windowParcels = totalParcelsRead - lastCheckpointParcels;
      const currentRatePerSec = windowSec >= 5 ? windowParcels / windowSec : overallRatePerSec;
      if (windowSec >= 15) {
        lastCheckpointTime = now;
        lastCheckpointParcels = totalParcelsRead;
      }

      const activeRate = currentRatePerSec > 0 ? currentRatePerSec : overallRatePerSec;
      const parcelsPerSecond = Number(activeRate.toFixed(1));
      const parcelsPerMinute = Math.round(activeRate * 60);
      const remainingParcels = Math.max(0, 524196 - totalParcelsRead);
      const etaSeconds = activeRate > 0 ? remainingParcels / activeRate : null;
      const etaIso = etaSeconds !== null ? new Date(now + etaSeconds * 1000).toISOString() : null;

      writeFileSync(
        options.checkpointFile,
        JSON.stringify({
          status,
          parcelsRead: totalParcelsRead,
          preparedRows: totalPreparedRows,
          batchesProcessed: batchIndex,
          targetParcels: 524196,
          startedAt: new Date(startedAtMs).toISOString(),
          updatedAt: new Date(now).toISOString(),
          parcelsPerMinute,
          parcelsPerSecond,
          etaIso,
          etaSeconds: etaSeconds !== null ? Math.round(etaSeconds) : null,
        }),
        "utf8",
      );
    } catch {}
  };

  const dirStream = await opendir(parcelsDir);
  let skippedOffset = 0;
  const CHUNK_SIZE = 128;
  let parcelChunk: string[] = [];

  const processChunk = async (chunk: string[]): Promise<void> => {
    const chunkResults = await Promise.all(
      chunk.map((dirPath) => loadParcelFast(dirPath, options)),
    );
    for (const rows of chunkResults) {
      if (rows.length > 0) {
        currentBatchRows.push(...rows);
        totalPreparedRows += rows.length;
        totalParcelsRead += 1;
      }
    }

    if (totalParcelsRead % 1000 < CHUNK_SIZE) {
      updateCheckpoint("in_progress");
    }

    if (currentBatchRows.length >= options.batchParcels * 25) {
      batchIndex += 1;
      if (!options.dryRun) {
        updateCheckpoint("merging");
        const batchResults = await stageAndMergeBatch({
          databaseUrl,
          batchIndex,
          rows: currentBatchRows,
          columnsByTable,
        });
        allMergeResults.push(...batchResults);
        console.log(
          JSON.stringify({
            event: "appraisal_batch_merged",
            batchIndex,
            parcelsRead: totalParcelsRead,
            preparedRows: totalPreparedRows,
          }),
        );
        updateCheckpoint("in_progress");
      }
      currentBatchRows = [];
    }
  };

  for await (const dirent of dirStream) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;

    if (skippedOffset < options.offset) {
      skippedOffset += 1;
      continue;
    }

    parcelChunk.push(join(parcelsDir, dirent.name));

    if (parcelChunk.length >= CHUNK_SIZE) {
      await processChunk(parcelChunk);
      parcelChunk = [];
    }

    if (options.limit !== null && totalParcelsRead >= options.limit) break;
  }

  if (parcelChunk.length > 0) {
    await processChunk(parcelChunk);
  }

  if (currentBatchRows.length > 0) {
    batchIndex += 1;
    if (!options.dryRun) {
      updateCheckpoint("merging");
      const batchResults = await stageAndMergeBatch({
        databaseUrl,
        batchIndex,
        rows: currentBatchRows,
        columnsByTable,
      });
      allMergeResults.push(...batchResults);
      console.log(
        JSON.stringify({
          event: "appraisal_batch_merged",
          batchIndex,
          parcelsRead: totalParcelsRead,
          preparedRows: totalPreparedRows,
        }),
      );
    }
  }

  updateCheckpoint("completed");

  return {
    totalParcelsRead,
    totalPreparedRows,
    batchesProcessed: batchIndex,
    mergeResults: allMergeResults,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  console.log(JSON.stringify({ event: "hillsborough_appraisal_bulk_load_started", ...options }));

  const t0 = Date.now();
  const summary = await runHillsboroughAppraisalBulkLoad(options);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    JSON.stringify({
      event: "hillsborough_appraisal_bulk_load_completed",
      elapsedSec: `${elapsedSec}s`,
      ...summary,
    }),
  );
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
    console.error(JSON.stringify({ event: "hillsborough_appraisal_bulk_load_failed", error: message }));
    process.exit(1);
  });
}
