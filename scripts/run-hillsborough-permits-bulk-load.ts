#!/usr/bin/env node
/**
 * Bulk-stream normalized Hillsborough permit JSONL records into Neon PostgreSQL
 * via temporary bulk stage tables and set-based SQL merges.
 *
 * @module elephant-query-db/scripts/run-hillsborough-permits-bulk-load
 */

import { createReadStream, createWriteStream, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

import { from as copyFrom } from "pg-copy-streams";
import { Client } from "pg";

import {
  mapNormalizedCityPermit,
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

const PERMIT_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "people",
  "companies",
  "property_improvements",
  "permit_contacts",
  "inspections",
  "permit_events",
  "permit_fees",
  "permit_links",
  "permit_custom_fields",
  "permit_list_windows",
];

export type HillsboroughPermitsBulkLoadOptions = {
  readonly envFile: string;
  readonly inputPath: string;
  readonly permitSourceSystem: string;
  readonly batchSize: number;
  readonly limit: number | null;
  readonly dryRun: boolean;
};

/**
 * Parse CLI options.
 *
 * @param argv - CLI args array.
 * @returns Parsed options.
 */
export function parseOptions(argv: readonly string[]): HillsboroughPermitsBulkLoadOptions {
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

  const batchSizeRaw = values.get("batch-size");
  const batchSize = batchSizeRaw === undefined ? 50_000 : Number(batchSizeRaw);
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error("--batch-size must be a positive number");
  }

  return {
    envFile: values.get("env-file") ?? ".env.local",
    inputPath:
      values.get("input") ??
      "../oracle-node-hillsborough/downloads/hillsborough/full-permits/normalized-permits.jsonl",
    permitSourceSystem: values.get("permit-source-system") ?? "hillsborough_permits",
    batchSize,
    limit,
    dryRun: values.get("dry-run") === "true",
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
    application_name: "hillsborough-permit-bulk-loader",
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
 * Stage and merge one batch of prepared rows into Neon.
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
  const stageTableName = `elephant_bulk_stage_permits_b${params.batchIndex}_${Date.now()}`;
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
        `CREATE TABLE public."${stageTableName}" (`,
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
    await client.query(
      `CREATE INDEX "${stageTableName}_table_idx" ON public."${stageTableName}" ("table_name")`,
    );
    await client.query(
      `CREATE INDEX "${stageTableName}_source_idx" ON public."${stageTableName}" ("source_system", "source_record_key")`,
    );

    const copySql = `COPY public."${stageTableName}" ("row_index", "table_name", "source_system", "source_record_key", "source_record_hash", "source_artifact_uri", "values_json", "references_json") FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;
    const copyStream = client.query(copyFrom(copySql));
    await pipeline(createReadStream(stageCsvPath), copyStream);

    const results: BulkMergeResult[] = [];
    await client.query("SET search_path TO public");
    await client.query("SET work_mem TO '128MB'");
    await client.query("SET random_page_cost TO 1.1");

    for (const tableName of PERMIT_TABLE_ORDER) {
      const columns = params.columnsByTable.get(tableName);
      if (columns === undefined) continue;

      // Check if this table has rows in the staging table
      const countRes = await client.query<{ count: string }>(
        `SELECT count(*) FROM public."${stageTableName}" WHERE "table_name" = $1`,
        [tableName],
      );
      if (parseInt(countRes.rows[0]?.count ?? "0", 10) === 0) continue;

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
export async function runHillsboroughPermitsBulkLoad(
  options: HillsboroughPermitsBulkLoadOptions,
): Promise<{
  readonly totalRecordsRead: number;
  readonly totalPreparedRows: number;
  readonly batchesProcessed: number;
  readonly mergeResults: readonly BulkMergeResult[];
}> {
  const databaseUrl = readDatabaseUrl(options.envFile);
  const inputPath = resolve(options.inputPath);
  const artifactUri = `file://${inputPath}`;

  const metaClient = await createKeepaliveClient(databaseUrl);
  let columnsByTable: ReadonlyMap<LogicalTableName, readonly BulkTableColumn[]>;
  try {
    columnsByTable = await readBulkTableColumns(
      createQueryClient(metaClient),
      PERMIT_TABLE_ORDER,
    );
  } finally {
    await metaClient.end();
  }

  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let totalRecordsRead = 0;
  let totalPreparedRows = 0;
  let batchIndex = 0;
  let currentBatchRows: PreparedRow[] = [];
  const allMergeResults: BulkMergeResult[] = [];

  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const parsed = JSON.parse(trimmed) as JsonObject;
    if (
      parsed.request_identifier === undefined &&
      typeof parsed.raw === "object" &&
      parsed.raw !== null &&
      typeof (parsed.raw as JsonObject).upi === "string"
    ) {
      parsed.request_identifier = (parsed.raw as JsonObject).upi;
    }

    const sourceSystem =
      typeof parsed.source_system === "string"
        ? parsed.source_system
        : options.permitSourceSystem;

    const bundle = mapNormalizedCityPermit({
      record: parsed,
      artifactUri,
      sourceSystem,
    });

    currentBatchRows.push(...bundle.rows);
    totalPreparedRows += bundle.rows.length;
    totalRecordsRead += 1;

    if (currentBatchRows.length >= options.batchSize) {
      batchIndex += 1;
      if (!options.dryRun) {
        const batchResults = await stageAndMergeBatch({
          databaseUrl,
          batchIndex,
          rows: currentBatchRows,
          columnsByTable,
        });
        allMergeResults.push(...batchResults);
        console.log(
          JSON.stringify({
            event: "permit_batch_merged",
            batchIndex,
            recordsRead: totalRecordsRead,
            preparedRows: totalPreparedRows,
          }),
        );
      }
      currentBatchRows = [];
    }

    if (options.limit !== null && totalRecordsRead >= options.limit) break;
  }

  if (currentBatchRows.length > 0) {
    batchIndex += 1;
    if (!options.dryRun) {
      const batchResults = await stageAndMergeBatch({
        databaseUrl,
        batchIndex,
        rows: currentBatchRows,
        columnsByTable,
      });
      allMergeResults.push(...batchResults);
      console.log(
        JSON.stringify({
          event: "permit_batch_merged",
          batchIndex,
          recordsRead: totalRecordsRead,
          preparedRows: totalPreparedRows,
        }),
      );
    }
  }

  return {
    totalRecordsRead,
    totalPreparedRows,
    batchesProcessed: batchIndex,
    mergeResults: allMergeResults,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  console.log(JSON.stringify({ event: "hillsborough_permits_bulk_load_started", ...options }));

  const t0 = Date.now();
  const summary = await runHillsboroughPermitsBulkLoad(options);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    JSON.stringify({
      event: "hillsborough_permits_bulk_load_completed",
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
    console.error(JSON.stringify({ event: "hillsborough_permits_bulk_load_failed", error: message }));
    process.exit(1);
  });
}
