import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { mapNormalizedCityPermit } from "../src/loader/permits.js";
import { upsertPreparedRows } from "../src/loader/sql.js";
import type { JsonObject, LogicalTableName, PreparedRow } from "../src/loader/types.js";

/**
 * Load normalized city-permit JSONL rows into Neon via `mapNormalizedCityPermit`.
 */

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

export type PermitsLocalLoadOptions = {
  readonly envFile: string;
  readonly inputPath: string;
  readonly permitSourceSystem: string;
  readonly limit: number | null;
  readonly dryRun: boolean;
};

/**
 * @param argv - CLI args after script name.
 * @returns Parsed load options.
 */
export function parseOptions(argv: readonly string[]): PermitsLocalLoadOptions {
  /** @type {Map<string, string>} */
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
  const limit =
    limitRaw === undefined ? null : Number(limitRaw);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }
  return {
    envFile: values.get("env-file") ?? ".env.local",
    inputPath: values.get("input") ?? ".permits-export/normalized-permits.jsonl",
    permitSourceSystem: values.get("permit-source-system") ?? "chester_permits",
    limit,
    dryRun: values.get("dry-run") === "true",
  };
}

/**
 * @param envFile - Path to env file containing DATABASE_URL.
 * @returns Postgres connection string.
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
 * @param options - Load options.
 * @returns Summary counters.
 */
export async function runPermitsLocalLoad(options: PermitsLocalLoadOptions): Promise<{
  readonly recordsRead: number;
  readonly preparedRows: number;
  readonly changedRows: number;
  readonly unchangedRows: number;
  readonly skippedRecords: number;
}> {
  const databaseUrl = readDatabaseUrl(options.envFile);
  const pool = new Pool({ connectionString: databaseUrl });
  /** @type {PreparedRow[]} */
  const allRows: PreparedRow[] = [];
  let recordsRead = 0;
  let skippedRecords = 0;

  const inputPath = resolve(options.inputPath);
  const artifactUri = `file://${inputPath}`;
  const reader = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });

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
    const bundle = mapNormalizedCityPermit({
      record: parsed,
      artifactUri,
      sourceSystem: options.permitSourceSystem,
    });
    allRows.push(...bundle.rows);
    skippedRecords += bundle.skippedRecords.length;
    recordsRead += 1;
    if (options.limit !== null && recordsRead >= options.limit) break;
  }

  if (options.dryRun) {
    await pool.end();
    return {
      recordsRead,
      preparedRows: allRows.length,
      changedRows: 0,
      unchangedRows: 0,
      skippedRecords,
    };
  }

  let changedRows = 0;
  let unchangedRows = 0;
  try {
    const orderedRows = PERMIT_TABLE_ORDER.flatMap((tableName) =>
      allRows.filter((row) => row.tableName === tableName),
    );
    const result = await upsertPreparedRows(pool, orderedRows, {
      missingReferenceBehavior: "omit",
    });
    changedRows = result.changedRows;
    unchangedRows = result.unchangedRows;
  } finally {
    await pool.end();
  }

  return {
    recordsRead,
    preparedRows: allRows.length,
    changedRows,
    unchangedRows,
    skippedRecords,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const summary = await runPermitsLocalLoad(options);
  console.log(JSON.stringify({ event: "permits_local_load_finished", ...summary }));
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
    console.error(JSON.stringify({ event: "permits_local_load_failed", error: message }));
    process.exit(1);
  });
}
