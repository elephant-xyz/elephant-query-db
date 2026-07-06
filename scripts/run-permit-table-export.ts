import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Pool } from "pg";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { appraisalSourceForCounty } from "./run-property-consolidation-export.js";

/**
 * County-generic "permit table" Parquet export.
 *
 * Emits ONE flat row per building permit (keyed on the `property_improvement_id`
 * PK) with only scalar columns, so an embedded DuckDB (in the MCP) can answer
 * arbitrary aggregate permit questions (e.g. "% of roofs older than 15 years")
 * over `<out-dir>/<county>/permit-table.parquet`.
 *
 * It mirrors run-query-table-export.ts, but the cardinality key is the permit
 * PK (each `property_improvements` row is already one permit — no many-to-one
 * collapse is needed), and there is no property CID (permits carry none), so
 * there is no --manifest.
 *
 * County → permit source_systems: unlike properties (which live under the exact
 * `<county>_appraiser` source), permits for a county span MULTIPLE source
 * systems (e.g. `lee_appraiser` AND `lee_accela`, plus future vendors). We derive
 * the county prefix as `appraisalSourceForCounty(county).replace(/_appraiser$/, "")`
 * (e.g. "lee", "palm_beach") and filter every permit whose source_system starts
 * with that prefix followed by an underscore. The match is ANCHORED and requires
 * the underscore right after the prefix, so "lee" never matches "leesburg".
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw Postgres result shape for one permit. Date columns are cast to text
 * (`::text`) in SQL so they arrive as ISO 'YYYY-MM-DD' strings; numeric columns
 * come back as strings from `pg`. All coercion happens in buildPermitTableRow.
 */
export type PermitTableSourceRow = {
  readonly property_improvement_id: string;
  readonly property_id: string | null;
  readonly parcel_identifier: string | null;
  readonly permit_number: string | null;
  readonly improvement_type: string | null;
  readonly improvement_status: string | null;
  readonly improvement_action: string | null;
  readonly permit_issue_date: string | null;
  readonly application_received_date: string | null;
  readonly final_inspection_date: string | null;
  readonly permit_close_date: string | null;
  readonly completion_date: string | null;
  readonly expiration_date: string | null;
  readonly opened_date: string | null;
  readonly source_system: string | null;
  readonly county_name: string | null;
  readonly project_description: string | null;
  readonly description: string | null;
  readonly estimated_job_value: string | null;
  readonly fee: string | null;
};

/** Flat, scalar-only output row — exactly the parquet schema, one per permit. */
export type PermitTableRow = {
  readonly property_improvement_id: string;
  readonly property_id: string | null;
  readonly parcel_identifier: string | null;
  readonly permit_number: string | null;
  readonly improvement_type: string | null;
  readonly improvement_status: string | null;
  readonly improvement_action: string | null;
  readonly permit_issue_date: string | null;
  readonly application_received_date: string | null;
  readonly final_inspection_date: string | null;
  readonly permit_close_date: string | null;
  readonly completion_date: string | null;
  readonly expiration_date: string | null;
  readonly opened_date: string | null;
  readonly source_system: string | null;
  readonly county_name: string | null;
  readonly project_description: string | null;
  readonly description: string | null;
  readonly estimated_job_value: number | null;
  readonly fee: number | null;
};

export type PermitTableExportOptions = {
  readonly limit: number | null;
  readonly outDir: string;
  readonly county: string;
  readonly envFile: string;
};

// ---------------------------------------------------------------------------
// Pure coercion helpers
// ---------------------------------------------------------------------------

/** Coerce a Postgres numeric/string scalar to a finite number, else null. */
function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize an empty string to null; otherwise pass the trimmed string through. */
function toText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// County → permit source-system prefix
// ---------------------------------------------------------------------------

/**
 * Derive the county prefix used to match every permit source_system for a
 * county. Properties live under the exact `<county>_appraiser` source, but
 * permits span multiple sources (`lee_appraiser`, `lee_accela`, …), so we strip
 * the trailing `_appraiser` and match `^<prefix>_`. The prefix is normalized to
 * alnum+underscore by {@link appraisalSourceForCounty}, so it is safe to
 * interpolate into an anchored regex.
 */
export function permitSourcePrefixForCounty(county: string): string {
  return appraisalSourceForCounty(county).replace(/_appraiser$/, "");
}

// ---------------------------------------------------------------------------
// Pure builder (the tested contract)
// ---------------------------------------------------------------------------

/**
 * Build one flat permit-table row from a raw source row. PURE — depends only on
 * scalar fields. Dates pass through as ISO text (already cast in SQL); the two
 * money columns are coerced to finite numbers (or null).
 */
export function buildPermitTableRow(row: PermitTableSourceRow): PermitTableRow {
  return {
    property_improvement_id: row.property_improvement_id,
    property_id: toText(row.property_id),
    parcel_identifier: toText(row.parcel_identifier),
    permit_number: toText(row.permit_number),
    improvement_type: toText(row.improvement_type),
    improvement_status: toText(row.improvement_status),
    improvement_action: toText(row.improvement_action),
    permit_issue_date: toText(row.permit_issue_date),
    application_received_date: toText(row.application_received_date),
    final_inspection_date: toText(row.final_inspection_date),
    permit_close_date: toText(row.permit_close_date),
    completion_date: toText(row.completion_date),
    expiration_date: toText(row.expiration_date),
    opened_date: toText(row.opened_date),
    source_system: toText(row.source_system),
    county_name: toText(row.county_name),
    project_description: toText(row.project_description),
    description: toText(row.description),
    estimated_job_value: toNumber(row.estimated_job_value),
    fee: toNumber(row.fee),
  };
}

// ---------------------------------------------------------------------------
// Parquet schema
// ---------------------------------------------------------------------------

/**
 * Flat parquet schema for the permit table. Every column is a scalar; every
 * column except the primary key is nullable. Dates are UTF8 (ISO text) for
 * DuckDB-friendliness, mirroring how the property query table stores
 * last_sale_date. DuckDB reads this directly.
 */
export function buildPermitTableParquetSchema(): ParquetSchema {
  return new ParquetSchema({
    property_improvement_id: { type: "UTF8" },
    property_id: { type: "UTF8", optional: true },
    parcel_identifier: { type: "UTF8", optional: true },
    permit_number: { type: "UTF8", optional: true },
    improvement_type: { type: "UTF8", optional: true },
    improvement_status: { type: "UTF8", optional: true },
    improvement_action: { type: "UTF8", optional: true },
    permit_issue_date: { type: "UTF8", optional: true },
    application_received_date: { type: "UTF8", optional: true },
    final_inspection_date: { type: "UTF8", optional: true },
    permit_close_date: { type: "UTF8", optional: true },
    completion_date: { type: "UTF8", optional: true },
    expiration_date: { type: "UTF8", optional: true },
    opened_date: { type: "UTF8", optional: true },
    source_system: { type: "UTF8", optional: true },
    county_name: { type: "UTF8", optional: true },
    project_description: { type: "UTF8", optional: true },
    description: { type: "UTF8", optional: true },
    estimated_job_value: { type: "DOUBLE", optional: true },
    fee: { type: "DOUBLE", optional: true },
  });
}

/**
 * parquetjs treats `null` and `undefined` differently for optional fields —
 * `null` can trip the shredder, so drop null keys entirely (an absent optional
 * field is written as NULL, which is what we want).
 */
function toParquetRecord(row: PermitTableRow): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  return record;
}

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

export function parseOptions(argv: readonly string[]): PermitTableExportOptions {
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
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : null;

  return {
    limit: limit !== null && !Number.isNaN(limit) ? limit : null,
    outDir: values.get("out-dir") ?? ".permit-table-export",
    county: values.get("county") ?? "lee",
    envFile: values.get("env-file") ?? ".env.local",
  };
}

// ---------------------------------------------------------------------------
// Env file loader
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Single SQL pass
// ---------------------------------------------------------------------------

/**
 * The one and only query. Every `property_improvements` row is already exactly
 * one permit, so there is no many-to-one collapse — a straight scan filtered to
 * the county's permit source systems, ordered by the PK. `county_name` is an
 * optional convenience joined from `parcels` via `parcel_id` (often NULL for
 * permits that never matched an appraisal parcel).
 *
 * The county prefix is bound as $1 and matched with an ANCHORED regex requiring
 * an underscore right after the prefix, so "lee" matches `lee_appraiser` and
 * `lee_accela` but never `leesburg_*`.
 */
async function fetchPermitTableRows(
  pool: Pool,
  prefix: string,
  limit: number | null,
): Promise<PermitTableSourceRow[]> {
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  const result = await pool.query<PermitTableSourceRow>(
    `
    SELECT
      pi.property_improvement_id::text AS property_improvement_id,
      pi.property_id::text AS property_id,
      pi.parcel_identifier AS parcel_identifier,
      pi.permit_number AS permit_number,
      pi.improvement_type AS improvement_type,
      pi.improvement_status AS improvement_status,
      pi.improvement_action AS improvement_action,
      pi.permit_issue_date::text AS permit_issue_date,
      pi.application_received_date::text AS application_received_date,
      pi.final_inspection_date::text AS final_inspection_date,
      pi.permit_close_date::text AS permit_close_date,
      pi.completion_date::text AS completion_date,
      pi.expiration_date::text AS expiration_date,
      pi.opened_date::text AS opened_date,
      pi.source_system AS source_system,
      par.county_name AS county_name,
      pi.project_description AS project_description,
      pi.description AS description,
      pi.estimated_job_value::text AS estimated_job_value,
      pi.fee::text AS fee
    FROM property_improvements pi
    LEFT JOIN parcels par ON par.parcel_id = pi.parcel_id
    WHERE pi.source_system ~ ('^' || $1 || '_')
    ORDER BY pi.property_improvement_id
    ${limitClause}
  `,
    [prefix],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(
      `DATABASE_URL is required; expected it in ${options.envFile} or the environment`,
    );
  }

  const prefix = permitSourcePrefixForCounty(options.county);
  const startedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: "permit_table_export_started",
      county: options.county,
      sourcePrefix: prefix,
      limit: options.limit,
      outDir: options.outDir,
      startedAt,
    }),
  );

  const pg = new Pool({
    application_name: "elephant-permit-table-export",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 5,
  });

  pg.on("error", (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "database_pool_error", error: message }));
  });

  try {
    const countyDir = join(options.outDir, options.county);
    await mkdir(countyDir, { recursive: true });
    const parquetPath = join(countyDir, "permit-table.parquet");

    const rows = await fetchPermitTableRows(pg, prefix, options.limit);

    const schema = buildPermitTableParquetSchema();
    const writer = await ParquetWriter.openFile(schema, parquetPath);

    let written = 0;
    try {
      for (const raw of rows) {
        await writer.appendRow(toParquetRecord(buildPermitTableRow(raw)));
        written += 1;
      }
    } finally {
      await writer.close();
    }

    console.log(
      JSON.stringify({
        event: "permit_table_export_finished",
        county: options.county,
        sourcePrefix: prefix,
        rowCount: written,
        parquetPath,
      }),
    );
  } finally {
    await pg.end();
  }
}

// Only run the DB-touching flow when invoked directly (e.g. via tsx). Importing
// this module for its pure builders must NOT open a database connection.
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
    console.error(JSON.stringify({ event: "permit_table_export_failed", error: message }));
    process.exit(1);
  });
}
