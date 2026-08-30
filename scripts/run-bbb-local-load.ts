/**
 * Load local BBB profile JSONL into Neon via mapBbbBusinessProfile.
 */

import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  expandBbbBusinessProfileRecords,
  mapBbbBusinessProfile,
} from "../src/loader/bbb.js";
import { upsertPreparedRows } from "../src/loader/sql.js";
import type { LogicalTableName, PreparedRow } from "../src/loader/types.js";

const BBB_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "companies",
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

export type BbbLocalLoadOptions = {
  readonly envFile: string;
  readonly inputPath: string;
  readonly limit: number | null;
  readonly dryRun: boolean;
};

/**
 * @param argv - CLI args after script name.
 * @returns Parsed options.
 */
export function parseBbbLocalLoadOptions(argv: readonly string[]): BbbLocalLoadOptions {
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
  return {
    envFile: values.get("env-file") ?? ".env.local",
    inputPath:
      values.get("input") ??
      "../oracle-node-hillsborough/downloads/hillsborough/bbb-probe/profiles/profiles-part-0001.jsonl",
    limit,
    dryRun: values.get("dry-run") === "true",
  };
}

/**
 * @param envFile - Env file with DATABASE_URL.
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
 * @param options - Load options.
 */
export async function runBbbLocalLoad(options: BbbLocalLoadOptions): Promise<{
  readonly recordsRead: number;
  readonly preparedRows: number;
  readonly changedRows: number;
  readonly unchangedRows: number;
  readonly skippedRecords: number;
}> {
  const databaseUrl = readDatabaseUrl(options.envFile);
  const pool = new Pool({ connectionString: databaseUrl });
  const inputPath = resolve(options.inputPath);
  const artifactUri = `file://${inputPath}`;
  const allRows: PreparedRow[] = [];
  let recordsRead = 0;
  let skippedRecords = 0;

  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    const profiles = expandBbbBusinessProfileRecords(parsed);
    for (const profile of profiles) {
      const bundle = mapBbbBusinessProfile({ record: profile, artifactUri });
      allRows.push(...bundle.rows);
      skippedRecords += bundle.skippedRecords.length;
      recordsRead += 1;
      if (options.limit !== null && recordsRead >= options.limit) break;
    }
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
    const orderedRows = BBB_TABLE_ORDER.flatMap((tableName) =>
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
  const options = parseBbbLocalLoadOptions(process.argv.slice(2));
  const summary = await runBbbLocalLoad(options);
  console.log(JSON.stringify({ event: "bbb_local_load_finished", ...summary }));
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
    console.error(JSON.stringify({ event: "bbb_local_load_failed", error: message }));
    process.exit(1);
  });
}
