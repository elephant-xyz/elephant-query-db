import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Pool } from "pg";

/**
 * Story 3 — derived geo/value index export.
 *
 * A SLIM, single SQL pass that emits one flat row per property carrying the two
 * validation keys (folio + request_identifier), the centroid
 * (latitude, longitude), the current_avm_value, and the property type. It does
 * NOT read the heavy consolidated property files — no permits/taxes/valuations
 * arrays are involved, so this can never become a full property re-fetch.
 *
 * The output is a small standalone index file. This script does NOT publish or
 * upload anything; resolution/serving is handled by the separate
 * ORACLE_GEO_INDEX_* configuration consumed by the MCP.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeoIndexSourceRow = {
  readonly parcel_identifier: string;
  readonly request_identifier: string;
  readonly folio: string;
  readonly latitude: string | number | null;
  readonly longitude: string | number | null;
  readonly current_avm_value: string | number | null;
  readonly property_type: string | null;
};

export type GeoIndexEntry = {
  readonly parcelIdentifier: string;
  readonly requestIdentifier: string;
  readonly folio: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly currentAvmValue: number | null;
  readonly propertyType: string | null;
};

export type GeoIndex = {
  readonly schemaVersion: "1";
  readonly county?: string;
  readonly exportedAt?: string;
  readonly count: number;
  readonly entries: readonly GeoIndexEntry[];
};

/**
 * Options that shape the built index. `county` is stamped on the output so the
 * MCP consumer's GeoIndexSchema (which requires `county`) can parse a real
 * exported file; `exportedAt` is overridable mostly for deterministic tests.
 */
export type BuildGeoIndexOptions = {
  readonly county?: string;
  readonly exportedAt?: string;
};

export type GeoIndexExportOptions = {
  readonly limit: number | null;
  readonly outDir: string;
  readonly county: string;
  readonly envFile: string;
};

// ---------------------------------------------------------------------------
// Pure builders (the tested contract)
// ---------------------------------------------------------------------------

/**
 * Coerce a numeric scalar (string from Postgres numeric, or number) to a finite
 * number. Returns null when the value is null/undefined or not finite.
 */
function coerceNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build a single geo index entry from a flat source row. PURE — depends only on
 * scalar fields, never on nested consolidated property data.
 */
export function buildGeoIndexRow(row: GeoIndexSourceRow): GeoIndexEntry {
  return {
    parcelIdentifier: row.parcel_identifier,
    requestIdentifier: row.request_identifier,
    folio: row.folio,
    latitude: coerceNullableNumber(row.latitude) ?? Number.NaN,
    longitude: coerceNullableNumber(row.longitude) ?? Number.NaN,
    currentAvmValue: coerceNullableNumber(row.current_avm_value),
    propertyType: row.property_type,
  };
}

/**
 * Cardinality key for a property. The export contract is exactly one entry per
 * property, identified by its TRUE folio `request_identifier`. We deliberately
 * do NOT key on `parcel_identifier`: in Lee it is digits-only normalized and
 * NOT unique, so distinct STRAPs/condo units share it — keying on it collapsed
 * ~30,851 parcels (~$11.75B). We fall back to the parcel id only when a
 * request_identifier is absent, so a degenerate row never silently merges with
 * an unrelated property.
 */
function dedupKey(row: GeoIndexSourceRow): string {
  if (
    row.request_identifier !== null &&
    row.request_identifier !== undefined &&
    row.request_identifier !== ""
  ) {
    return `req:${row.request_identifier}`;
  }
  return `parcel:${row.parcel_identifier}`;
}

/** Deterministic AVM selection across duplicate rows: the maximum non-null value. */
function pickMaxAvm(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Build the full geo index from flat source rows. PURE function of the rows.
 *
 * Guarantees the reviewer-pinned contract:
 *  - one entry per folio — duplicate join rows (multiple geometries or multiple
 *    property_valuations) collapse into a single entry, taking the maximum
 *    non-null current_avm_value and the first valid centroid;
 *  - rows whose centroid cannot be coerced to a finite lat/lng are skipped, so
 *    the index never carries a NaN coordinate;
 *  - the output carries `county` (when supplied) and an `exportedAt` timestamp
 *    so the MCP consumer's GeoIndexSchema can parse a real exported file.
 */
export function buildGeoIndex(
  rows: readonly GeoIndexSourceRow[],
  options: BuildGeoIndexOptions = {},
): GeoIndex {
  const byKey = new Map<string, GeoIndexEntry>();

  for (const row of rows) {
    const latitude = coerceNullableNumber(row.latitude);
    const longitude = coerceNullableNumber(row.longitude);
    // Blocker 4: a property with no finite centroid cannot be placed on a map.
    if (latitude === null || longitude === null) continue;

    const currentAvmValue = coerceNullableNumber(row.current_avm_value);
    const key = dedupKey(row);
    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, {
        parcelIdentifier: row.parcel_identifier,
        requestIdentifier: row.request_identifier,
        folio: row.folio,
        latitude,
        longitude,
        currentAvmValue,
        propertyType: row.property_type,
      });
      continue;
    }

    // Blocker 2: collapse the duplicate, keeping the deterministic max AVM.
    byKey.set(key, {
      ...existing,
      currentAvmValue: pickMaxAvm(existing.currentAvmValue, currentAvmValue),
    });
  }

  const entries = [...byKey.values()];
  return {
    schemaVersion: "1",
    ...(options.county !== undefined ? { county: options.county } : {}),
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    count: entries.length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

export function parseOptions(argv: readonly string[]): GeoIndexExportOptions {
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
    outDir: values.get("out-dir") ?? ".geo-index-export",
    county: values.get("county") ?? "lee",
    envFile: values.get("env-file") ?? ".env.local",
  };
}

// ---------------------------------------------------------------------------
// Env file loader
// ---------------------------------------------------------------------------

/**
 * Strip a single matching pair of surrounding double or single quotes from an
 * env value. Without this, a `.env.local` line like `DATABASE_URL="postgres://…"`
 * is read WITH the literal quotes, so `pg` tries to connect to a host named `"`
 * and fails with `getaddrinfo ENOTFOUND base`.
 */
export function unquoteEnvValue(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
      const value = unquoteEnvValue(trimmed.slice(equalsIndex + 1));
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

// Map the --county option to the appraisal source_system stored in the DB.
// Defaults to `<county>_appraiser` with non-alphanumerics collapsed to underscores,
// so new counties work without code changes (e.g. "palm-beach" -> "palm_beach_appraiser").
// Mirrors appraisalSourceForCounty in run-property-consolidation-export.ts.
export function appraisalSourceForCounty(county: string): string {
  const slug = county.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.endsWith("_appraiser") ? slug : `${slug}_appraiser`;
}

/**
 * The one and only query. Joins properties → geometries → property_valuations,
 * selecting just the slim scalar columns the geo index needs. Properties with
 * no centroid are excluded (they cannot be placed on a map). Scoped to a single
 * county via its source_system (bound as $1), so the export is county-generic.
 */
async function fetchGeoRows(
  pool: Pool,
  sourceSystem: string,
  limit: number | null,
): Promise<GeoIndexSourceRow[]> {
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  // Pre-dedupe in SQL to keep this a single slim pass with exactly one row per
  // property: collapse the many-to-one property_valuations join to the maximum
  // current_avm_value in a CTE, then DISTINCT ON the property to fold any
  // multi-geometry join down to a single deterministic centroid. The pure
  // builder still dedupes by folio as a defensive backstop.
  const result = await pool.query<GeoIndexSourceRow>(`
    WITH avm AS (
      SELECT
        property_id,
        MAX(current_avm_value) AS current_avm_value
      FROM property_valuations
      GROUP BY property_id
    )
    SELECT DISTINCT ON (p.property_id)
      p.parcel_identifier AS parcel_identifier,
      p.request_identifier AS request_identifier,
      p.request_identifier AS folio,
      g.latitude AS latitude,
      g.longitude AS longitude,
      a.current_avm_value AS current_avm_value,
      p.property_type AS property_type
    FROM properties p
    JOIN geometries g ON g.property_id = p.property_id
    LEFT JOIN avm a ON a.property_id = p.property_id
    WHERE p.source_system = $1
      AND g.latitude IS NOT NULL
      AND g.longitude IS NOT NULL
    ORDER BY p.property_id, g.latitude, g.longitude
    ${limitClause}
  `, [sourceSystem]);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Main export flow (slim; no property JSON reads, no uploads)
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

  const sourceSystem = appraisalSourceForCounty(options.county);
  const startedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: "geo_index_export_started",
      county: options.county,
      sourceSystem,
      limit: options.limit,
      outDir: options.outDir,
      startedAt,
    }),
  );

  const pg = new Pool({
    application_name: "elephant-geo-index-export",
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
    await mkdir(options.outDir, { recursive: true });

    const rows = await fetchGeoRows(pg, sourceSystem, options.limit);
    const index = buildGeoIndex(rows, { county: options.county });

    const json = `${JSON.stringify(index, null, 2)}\n`;
    await writeFile(join(options.outDir, "geo-index.json"), Buffer.from(json, "utf8"));

    console.log(
      JSON.stringify({
        event: "geo_index_export_finished",
        count: index.count,
        outDir: options.outDir,
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
    console.error(JSON.stringify({ event: "geo_index_export_failed", error: message }));
    process.exit(1);
  });
}
