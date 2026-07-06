import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Pool } from "pg";
import { ParquetReader } from "@dsnp/parquetjs";

import { permitSourcePrefixForCounty } from "./run-permit-table-export.js";

/**
 * Validation gate for the permit-table Parquet export.
 *
 * Proves the one-row-per-permit contract by checking, against the produced
 * parquet:
 *   1. rowCount > 0, 0 null/empty `property_improvement_id`, and distinct
 *      property_improvement_id == rowCount (each row a unique permit) — always
 *      checked, no DB needed;
 *   2. rowCount == Neon `count(*) FROM property_improvements WHERE
 *      source_system ~ '^<prefix>_'` (the same anchored county-prefix filter the
 *      export uses) — checked when DATABASE_URL is available, or skipped (with a
 *      loud warning) when --parquet-only is passed.
 *
 * Fails loud (exit 1) on any mismatch or duplicate permit id.
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
    parquetPath:
      values.get("parquet") ?? join(".permit-table-export", county, "permit-table.parquet"),
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
  readonly distinctPermitIds: number;
  readonly nullPermitIds: number;
};

/** Read the parquet and tally row count + distinct/null property_improvement_id. */
async function readParquetStats(parquetPath: string): Promise<ParquetStats> {
  const reader = await ParquetReader.openFile(parquetPath);
  const seen = new Set<string>();
  let rowCount = 0;
  let nulls = 0;
  try {
    const cursor = reader.getCursor([["property_improvement_id"]]);
    let record = (await cursor.next()) as { property_improvement_id?: unknown } | null;
    while (record !== null) {
      rowCount += 1;
      const value = record.property_improvement_id;
      if (value === null || value === undefined || value === "") {
        nulls += 1;
      } else {
        seen.add(String(value));
      }
      record = (await cursor.next()) as { property_improvement_id?: unknown } | null;
    }
  } finally {
    await reader.close();
  }
  return { rowCount, distinctPermitIds: seen.size, nullPermitIds: nulls };
}

/** Permit row count in Neon, using the SAME anchored county-prefix filter the export uses. */
async function countPermitsInNeon(pool: Pool, prefix: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM property_improvements
    WHERE source_system ~ ('^' || $1 || '_')
  `,
    [prefix],
  );
  const raw = result.rows[0]?.count ?? "0";
  return Number.parseInt(raw, 10);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  console.log(
    JSON.stringify({
      event: "permit_table_validation_started",
      parquetPath: options.parquetPath,
      county: options.county,
      parquetOnly: options.parquetOnly,
    }),
  );

  const failures: string[] = [];

  const stats = await readParquetStats(options.parquetPath);
  console.log(JSON.stringify({ event: "parquet_stats", ...stats }));

  // Check 1: permit uniqueness — rows exist, each has a non-null unique PK.
  if (stats.rowCount === 0) {
    failures.push("parquet has 0 rows");
  }
  if (stats.nullPermitIds > 0) {
    failures.push(`${stats.nullPermitIds} rows have a NULL/empty property_improvement_id`);
  }
  if (stats.distinctPermitIds !== stats.rowCount - stats.nullPermitIds) {
    failures.push(
      `duplicate permit ids: rowCount=${stats.rowCount} but distinct+null=${
        stats.distinctPermitIds + stats.nullPermitIds
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
        note: "row-count vs Neon property_improvements count was NOT verified",
      }),
    );
  } else {
    const prefix = permitSourcePrefixForCounty(options.county);
    const pg = new Pool({
      application_name: "elephant-permit-table-validate",
      connectionString: databaseUrl,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 10_000,
      max: 2,
    });
    try {
      const expected = await countPermitsInNeon(pg, prefix);
      console.log(JSON.stringify({ event: "neon_permit_count", sourcePrefix: prefix, expected }));
      if (expected !== stats.rowCount) {
        failures.push(`row count ${stats.rowCount} != Neon permit count ${expected}`);
      }
    } finally {
      await pg.end();
    }
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ event: "permit_table_validation_failed", failures }));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      event: "permit_table_validation_passed",
      rowCount: stats.rowCount,
      distinctPermitIds: stats.distinctPermitIds,
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
    console.error(JSON.stringify({ event: "permit_table_validation_error", error: message }));
    process.exit(1);
  });
}
