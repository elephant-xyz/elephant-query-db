import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Pool } from "pg";
import { ParquetReader } from "@dsnp/parquetjs";

import { appraisalSourceForCounty } from "./run-property-consolidation-export.js";

/**
 * Validation gate for the query-table Parquet export.
 *
 * Proves the folio-cardinality contract by checking, against the produced
 * parquet:
 *   1. row count == distinct request_identifier IN the parquet (folio unique,
 *      zero dupes) — always checked, no DB needed;
 *   2. row count == distinct request_identifier in Neon (the same COALESCE
 *      expression the export keys on; ~511,695 for lee_appraiser) — checked when
 *      DATABASE_URL is available, or skipped (with a loud warning) when
 *      --parquet-only is passed.
 *
 * Fails loud (exit 1) on any mismatch or duplicate folio.
 *
 * Acceptance DuckDB queries the parquet must be able to answer (documented, not
 * run here):
 *   Q1: WHERE lot_size_acre > 2 AND address_city ILIKE 'jupiter'
 *   Q2: WHERE owners_text ILIKE '%SMITH, JOHN%'
 *   Q3: WHERE address_zip = '33410' AND exterior_wall_material ILIKE '%concrete%'
 *   Q4: HOA — BLOCKED, hoa_flag is placeholder NULL (needs upstream HOA ingestion).
 */

export type ValidateOptions = {
  readonly parquetPath: string;
  readonly county: string;
  readonly envFile: string;
  readonly parquetOnly: boolean;
};

export function parseOptions(argv: readonly string[]): ValidateOptions {
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

  const county = values.get("county") ?? "lee";
  return {
    parquetPath: values.get("parquet") ?? join(".query-table-export", county, "query-table.parquet"),
    county,
    envFile: values.get("env-file") ?? ".env.local",
    parquetOnly: values.get("parquet-only") === "true",
  };
}

function loadEnvFile(envFile: string): void {
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex);
      let value = trimmed.slice(equalsIndex + 1);
      // Strip a single pair of surrounding quotes; a quoted DATABASE_URL otherwise
      // parses with host "base" → getaddrinfo ENOTFOUND base.
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (caught) {
    if (
      caught instanceof Error &&
      "code" in caught &&
      (caught as NodeJS.ErrnoException).code === "ENOENT"
    )
      return;
    throw caught;
  }
}

export type ParquetStats = {
  readonly rowCount: number;
  readonly distinctRequestIdentifiers: number;
  readonly nullRequestIdentifiers: number;
};

/** Read the parquet and tally row count + distinct/null request_identifier. */
async function readParquetStats(parquetPath: string): Promise<ParquetStats> {
  const reader = await ParquetReader.openFile(parquetPath);
  const seen = new Set<string>();
  let rowCount = 0;
  let nulls = 0;
  try {
    const cursor = reader.getCursor([["request_identifier"]]);
    let record = (await cursor.next()) as { request_identifier?: unknown } | null;
    while (record !== null) {
      rowCount += 1;
      const value = record.request_identifier;
      if (value === null || value === undefined || value === "") {
        nulls += 1;
      } else {
        seen.add(String(value));
      }
      record = (await cursor.next()) as { request_identifier?: unknown } | null;
    }
  } finally {
    await reader.close();
  }
  return { rowCount, distinctRequestIdentifiers: seen.size, nullRequestIdentifiers: nulls };
}

/** Distinct folio count in Neon, using the SAME COALESCE key the export dedups on. */
async function countDistinctFolioInNeon(pool: Pool, sourceSystem: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
    SELECT COUNT(DISTINCT COALESCE(NULLIF(p.request_identifier, ''), NULLIF(par.request_identifier, ''), p.parcel_identifier)) AS count
    FROM properties p
    LEFT JOIN parcels par ON par.parcel_id = p.parcel_id
    WHERE p.source_system = $1
  `,
    [sourceSystem],
  );
  const raw = result.rows[0]?.count ?? "0";
  return Number.parseInt(raw, 10);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  console.log(
    JSON.stringify({
      event: "query_table_validation_started",
      parquetPath: options.parquetPath,
      county: options.county,
      parquetOnly: options.parquetOnly,
    }),
  );

  const failures: string[] = [];

  const stats = await readParquetStats(options.parquetPath);
  console.log(JSON.stringify({ event: "parquet_stats", ...stats }));

  // Check 1: folio uniqueness — every row is a distinct request_identifier.
  if (stats.nullRequestIdentifiers > 0) {
    failures.push(`${stats.nullRequestIdentifiers} rows have a NULL/empty request_identifier`);
  }
  if (stats.rowCount !== stats.distinctRequestIdentifiers + stats.nullRequestIdentifiers) {
    failures.push(
      `duplicate folios: rowCount=${stats.rowCount} but distinct+null=${
        stats.distinctRequestIdentifiers + stats.nullRequestIdentifiers
      }`,
    );
  }

  // Check 2: reconcile against Neon (skippable without DB access).
  const databaseUrl = process.env["DATABASE_URL"];
  if (options.parquetOnly || databaseUrl === undefined || databaseUrl.trim().length === 0) {
    console.warn(
      JSON.stringify({
        event: "neon_reconciliation_skipped",
        reason: options.parquetOnly ? "--parquet-only" : "DATABASE_URL not set",
        note: "row-count vs Neon distinct request_identifier (~511,695 for Lee) was NOT verified",
      }),
    );
  } else {
    const sourceSystem = appraisalSourceForCounty(options.county);
    const pg = new Pool({
      application_name: "elephant-query-table-validate",
      connectionString: databaseUrl,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 10_000,
      max: 2,
    });
    try {
      const expected = await countDistinctFolioInNeon(pg, sourceSystem);
      console.log(JSON.stringify({ event: "neon_distinct_folio", sourceSystem, expected }));
      if (expected !== stats.rowCount) {
        failures.push(
          `row count ${stats.rowCount} != Neon distinct request_identifier ${expected}`,
        );
      }
    } finally {
      await pg.end();
    }
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ event: "query_table_validation_failed", failures }));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      event: "query_table_validation_passed",
      rowCount: stats.rowCount,
      distinctRequestIdentifiers: stats.distinctRequestIdentifiers,
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
    console.error(JSON.stringify({ event: "query_table_validation_error", error: message }));
    process.exit(1);
  });
}
