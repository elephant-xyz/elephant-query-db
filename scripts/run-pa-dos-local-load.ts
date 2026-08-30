import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { mapPaDosEntity, type PaDosEntityInput } from "../src/loader/paDos.js";
import { upsertPreparedRows } from "../src/loader/sql.js";
import type { LogicalTableName, PreparedRow } from "../src/loader/types.js";

/**
 * Load Chester-scoped PA DOS entities from a local JSONL export into Neon.
 */

const TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "companies",
  "business_registrations",
  "business_registration_addresses",
];

export type PaDosLocalLoadOptions = {
  readonly envFile: string;
  readonly inputPath: string;
  readonly limit: number | null;
  readonly dryRun: boolean;
};

/**
 * @param argv - CLI args after script name.
 * @returns Parsed load options.
 */
export function parseOptions(argv: readonly string[]): PaDosLocalLoadOptions {
  /** @type {Map<string, string>} */
  const values = new Map();
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
    inputPath: values.get("input") ?? ".pa-dos-export/chester/entities.jsonl",
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
 * @param raw - Parsed JSONL object.
 * @returns Normalized PA DOS entity input.
 */
export function normalizeEntityLine(raw: Record<string, unknown>): PaDosEntityInput {
  return {
    filingNumber: String(raw.filingNumber ?? raw.filing_number ?? ""),
    businessName: String(raw.businessName ?? raw.business_name ?? ""),
    addressLine1: String(raw.addressLine1 ?? raw.address_line1 ?? ""),
    city: String(raw.city ?? ""),
    state: String(raw.state ?? "PA"),
    zip: String(raw.zip ?? ""),
    entityType:
      typeof raw.entityType === "string"
        ? raw.entityType
        : typeof raw.typeofbusinessregistration === "string"
          ? raw.typeofbusinessregistration
          : null,
    partyType:
      typeof raw.partyType === "string"
        ? raw.partyType
        : typeof raw.party_type === "string"
          ? raw.party_type
          : null,
    creationDate:
      typeof raw.creationDate === "string"
        ? raw.creationDate
        : typeof raw.creationdate === "string"
          ? raw.creationdate
          : null,
    countyName:
      typeof raw.countyName === "string"
        ? raw.countyName
        : typeof raw.shortcountyname === "string"
          ? raw.shortcountyname
          : null,
  };
}

/**
 * @param options - Load options.
 * @returns Summary counters.
 */
export async function runPaDosLocalLoad(options: PaDosLocalLoadOptions): Promise<{
  readonly entitiesRead: number;
  readonly preparedRows: number;
  readonly changedRows: number;
  readonly unchangedRows: number;
}> {
  const databaseUrl = readDatabaseUrl(options.envFile);
  const pool = new Pool({ connectionString: databaseUrl });
  /** @type {PreparedRow[]} */
  const allRows: PreparedRow[] = [];
  let entitiesRead = 0;

  const inputPath = resolve(options.inputPath);
  const artifactUri = `file://${inputPath}`;
  const reader = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const entity = normalizeEntityLine(parsed);
    const bundle = mapPaDosEntity({ entity, artifactUri });
    allRows.push(...bundle.rows);
    entitiesRead += 1;
    if (options.limit !== null && entitiesRead >= options.limit) break;
  }

  if (options.dryRun) {
    await pool.end();
    return {
      entitiesRead,
      preparedRows: allRows.length,
      changedRows: 0,
      unchangedRows: 0,
    };
  }

  let changedRows = 0;
  let unchangedRows = 0;
  try {
    const orderedRows = TABLE_ORDER.flatMap((tableName) =>
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
    entitiesRead,
    preparedRows: allRows.length,
    changedRows,
    unchangedRows,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const summary = await runPaDosLocalLoad(options);
  console.log(JSON.stringify({ event: "pa_dos_local_load_finished", ...summary }));
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
    console.error(JSON.stringify({ event: "pa_dos_local_load_failed", error: message }));
    process.exit(1);
  });
}
