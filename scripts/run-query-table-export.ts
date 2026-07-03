import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Pool } from "pg";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import {
  appraisalSourceForCounty,
  parseUnnormalizedAddress,
} from "./run-property-consolidation-export.js";

/**
 * County-generic "query table" Parquet export.
 *
 * Emits ONE flat row per property (keyed on the TRUE folio `request_identifier`)
 * with only scalar columns, so an embedded DuckDB (in the MCP) can answer
 * arbitrary SQL questions over `<out-dir>/<county>/query-table.parquet`.
 *
 * Design mirrors run-geo-index-export.ts: a single flat SQL pass with pre-dedup
 * CTEs collapsing every many-to-one join to one row per property, then a final
 * DISTINCT ON (folio). It never reads the heavy consolidated property JSON, so
 * it can never become a full property re-fetch.
 *
 * The property CID is NOT stored in Neon — it is computed at consolidation-export
 * time and recorded in that run's manifest.json. Pass --manifest to left-join it
 * on property_id; without it, `property_cid` is NULL (run this AFTER the
 * consolidation export to populate CIDs).
 *
 * Acceptance DuckDB queries (run against the produced parquet):
 *   Q1: SELECT count(*) FROM 'query-table.parquet'
 *         WHERE lot_size_acre > 2 AND address_city ILIKE 'jupiter';
 *   Q2: SELECT count(*) FROM 'query-table.parquet'
 *         WHERE owners_text ILIKE '%SMITH, JOHN%';
 *   Q3: SELECT count(*) FROM 'query-table.parquet'
 *         WHERE address_zip = '33410' AND exterior_wall_material ILIKE '%concrete%';
 *   Q4 (HOA): BLOCKED — `hoa_flag` is a placeholder NULL. Answering "is this
 *         property in an HOA?" needs upstream HOA ingestion that does not exist
 *         in Neon yet; the column is reserved so the schema is stable once it does.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw Postgres result shape for one property. Numeric columns come back as
 * strings from `pg`; text-typed measurement columns are cast to numeric in SQL
 * and therefore also arrive as strings. All coercion happens in buildQueryTableRow.
 */
export type QueryTableSourceRow = {
  readonly property_id: string;
  readonly folio: string | null;
  readonly request_identifier: string | null;
  readonly parcel_identifier: string | null;
  readonly source_system: string | null;
  readonly county_name: string | null;
  readonly state_code: string | null;
  readonly street_number: string | null;
  readonly street_name: string | null;
  readonly street_suffix_type: string | null;
  readonly city_name: string | null;
  readonly postal_code: string | null;
  readonly unnormalized_address: string | null;
  readonly situs_full_address: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly lot_size_acre: string | null;
  readonly lot_area_sqft: string | null;
  readonly exterior_wall_material: string | null;
  readonly roof_covering_material: string | null;
  readonly property_type: string | null;
  readonly property_usage_type: string | null;
  readonly built_year: number | null;
  readonly livable_floor_area: string | null;
  readonly total_area: string | null;
  // Building living-area is not carried on `properties` (that column is unused,
  // 0 non-null for every county); it lives on the `layouts` detail rows and is
  // aggregated per property in SQL. `livable_area_sq_ft` is Lee's living area;
  // `area_under_air_sq_ft` (conditioned area) is Palm Beach's, which has no
  // `livable_area_sq_ft`. See buildQueryTableRow for the resolution order.
  readonly layout_livable_area_sq_ft: string | null;
  readonly layout_area_under_air_sq_ft: string | null;
  readonly assessed_value: string | null;
  readonly market_value: string | null;
  readonly land_value: string | null;
  readonly avm_value: string | null;
  readonly owner_name: string | null;
  readonly owners_text: string | null;
  readonly owner_count: string | null;
  readonly owner_occupied: boolean | null;
  readonly last_sale_date: string | null;
  readonly last_sale_price: string | null;
  readonly subdivision: string | null;
  readonly has_permits: boolean | null;
  readonly permit_count: string | null;
  readonly has_sunbiz_tenant: boolean | null;
  readonly has_bbb_contractor: boolean | null;
};

/** Flat, scalar-only output row — exactly the parquet schema, one per property. */
export type QueryTableRow = {
  readonly property_id: string;
  readonly property_cid: string | null;
  readonly request_identifier: string | null;
  readonly parcel_identifier: string | null;
  readonly source_system: string | null;
  readonly county_name: string | null;
  readonly state_code: string | null;
  readonly address_street: string | null;
  readonly address_city: string | null;
  readonly address_zip: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly lot_size_acre: number | null;
  readonly lot_area_sqft: number | null;
  readonly exterior_wall_material: string | null;
  readonly roof_covering_material: string | null;
  readonly property_type: string | null;
  readonly property_usage_type: string | null;
  readonly built_year: number | null;
  readonly livable_floor_area: number | null;
  readonly total_area: number | null;
  readonly assessed_value: number | null;
  readonly market_value: number | null;
  readonly land_value: number | null;
  readonly avm_value: number | null;
  readonly owner_name: string | null;
  readonly owners_text: string | null;
  readonly owner_count: number | null;
  readonly owner_occupied: boolean | null;
  readonly last_sale_date: string | null;
  readonly last_sale_price: number | null;
  readonly subdivision: string | null;
  readonly has_permits: boolean | null;
  readonly permit_count: number | null;
  readonly has_sunbiz_tenant: boolean | null;
  readonly has_bbb_contractor: boolean | null;
  readonly hoa_flag: boolean | null;
};

export type QueryTableExportOptions = {
  readonly limit: number | null;
  readonly outDir: string;
  readonly county: string;
  readonly envFile: string;
  readonly manifestPath: string | null;
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

/** Coerce a Postgres bigint/integer/string scalar to a safe integer, else null. */
function toInteger(value: string | number | null | undefined): number | null {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return Math.trunc(parsed);
}

/** Normalize an empty string to null; otherwise pass the string through. */
function toText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Pure builder (the tested contract)
// ---------------------------------------------------------------------------

/** Resolved situs (property-location) address, split into discrete fields. */
type ResolvedAddress = {
  readonly street: string | null;
  readonly city: string | null;
  readonly zip: string | null;
};

/**
 * Resolve the SITUS (property-location) address for a row.
 *
 * The authoritative situs source is the free-text
 * `unnormalized_addresses.full_address` (joined on request_identifier), parsed
 * apart. It is 100% populated for both Lee and Palm Beach. The structured
 * street_* / city / postal columns on `addresses` are the OWNER-MAILING address
 * (e.g. Palm Beach owners whose mailing ZIP is a New York City ZIP, not the
 * property's), so a WHERE address_zip=... query must NOT read them first.
 *
 * Resolution is county-generic and per-field: parse the situs first, then fall
 * back to the structured columns, then to the `addresses.unnormalized_address`
 * column as a last resort. A situs that carries no real street/city/ZIP content
 * (e.g. the placeholder ", , FL") is treated as absent so it never injects a
 * bare state token as the street.
 */
function resolveSitusAddress(row: QueryTableSourceRow): ResolvedAddress {
  const situs = parseUnnormalizedAddress(row.situs_full_address);
  const situsHasContent =
    situs.city !== null ||
    situs.postalCode !== null ||
    (situs.street !== null && /\d/.test(situs.street));

  const structuredStreet =
    [row.street_number, row.street_name, row.street_suffix_type]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(" ") || null;
  const columnParsed = parseUnnormalizedAddress(row.unnormalized_address);

  return {
    street: (situsHasContent ? situs.street : null) ?? structuredStreet ?? columnParsed.street,
    city: (situsHasContent ? situs.city : null) ?? toText(row.city_name) ?? columnParsed.city,
    zip: (situsHasContent ? situs.postalCode : null) ?? toText(row.postal_code) ?? columnParsed.postalCode,
  };
}

/**
 * Build one flat query-table row from a raw source row plus its resolved CID.
 * PURE — depends only on scalar fields (and the shared address parser), never on
 * nested consolidated property data.
 *
 * See resolveSitusAddress for how the property-location address is derived. Lot
 * acreage prefers the direct `lot_size_acre`, deriving it from `lot_area_sqft`
 * (÷ 43,560) when the direct value is absent — for palm_beach_appraiser
 * lot_size_acre is ~0% populated while lot_area_sqft is ~92%.
 *
 * Building living area (the Sq Ft NEO displays) is resolved from the layout
 * aggregate, not `properties.livable_floor_area` (unused, 0 non-null every
 * county): prefer the property column if it is ever populated, then Lee's
 * `livable_area_sq_ft`, then Palm Beach's `area_under_air_sq_ft` (conditioned
 * living area). `total_area_sq_ft` is intentionally NOT used — it is
 * land-inflated for Lee (median 13,266 vs 3,424 living) and unreliable as a
 * building measure.
 */
export function buildQueryTableRow(row: QueryTableSourceRow, cid: string | null): QueryTableRow {
  const address = resolveSitusAddress(row);

  const lotAreaSqft = toNumber(row.lot_area_sqft);
  const lotSizeAcre =
    toNumber(row.lot_size_acre) ?? (lotAreaSqft !== null ? lotAreaSqft / 43_560 : null);

  return {
    property_id: row.property_id,
    property_cid: cid,
    request_identifier: toText(row.folio),
    parcel_identifier: toText(row.parcel_identifier),
    source_system: toText(row.source_system),
    county_name: toText(row.county_name),
    state_code: toText(row.state_code),
    address_street: address.street,
    address_city: address.city,
    address_zip: address.zip,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    lot_size_acre: lotSizeAcre,
    lot_area_sqft: lotAreaSqft,
    exterior_wall_material: toText(row.exterior_wall_material),
    roof_covering_material: toText(row.roof_covering_material),
    property_type: toText(row.property_type),
    property_usage_type: toText(row.property_usage_type),
    built_year: toInteger(row.built_year),
    livable_floor_area:
      toNumber(row.livable_floor_area) ??
      toNumber(row.layout_livable_area_sq_ft) ??
      toNumber(row.layout_area_under_air_sq_ft),
    total_area: toNumber(row.total_area),
    assessed_value: toNumber(row.assessed_value),
    market_value: toNumber(row.market_value),
    land_value: toNumber(row.land_value),
    avm_value: toNumber(row.avm_value),
    owner_name: toText(row.owner_name),
    owners_text: toText(row.owners_text),
    owner_count: toInteger(row.owner_count),
    owner_occupied: row.owner_occupied,
    last_sale_date: toText(row.last_sale_date),
    last_sale_price: toNumber(row.last_sale_price),
    subdivision: toText(row.subdivision),
    has_permits: row.has_permits ?? false,
    permit_count: toInteger(row.permit_count) ?? 0,
    has_sunbiz_tenant: row.has_sunbiz_tenant ?? false,
    has_bbb_contractor: row.has_bbb_contractor ?? false,
    // HOA gap: no HOA data is ingested into Neon yet. Reserved placeholder so the
    // parquet schema is stable once upstream HOA ingestion lands.
    hoa_flag: null,
  };
}

// ---------------------------------------------------------------------------
// Parquet schema
// ---------------------------------------------------------------------------

/**
 * Flat parquet schema for the query table. Every column is a scalar; every
 * column except the primary key is nullable. DuckDB reads this directly.
 */
export function buildQueryTableParquetSchema(): ParquetSchema {
  return new ParquetSchema({
    property_id: { type: "UTF8" },
    property_cid: { type: "UTF8", optional: true },
    request_identifier: { type: "UTF8", optional: true },
    parcel_identifier: { type: "UTF8", optional: true },
    source_system: { type: "UTF8", optional: true },
    county_name: { type: "UTF8", optional: true },
    state_code: { type: "UTF8", optional: true },
    address_street: { type: "UTF8", optional: true },
    address_city: { type: "UTF8", optional: true },
    address_zip: { type: "UTF8", optional: true },
    latitude: { type: "DOUBLE", optional: true },
    longitude: { type: "DOUBLE", optional: true },
    lot_size_acre: { type: "DOUBLE", optional: true },
    lot_area_sqft: { type: "DOUBLE", optional: true },
    exterior_wall_material: { type: "UTF8", optional: true },
    roof_covering_material: { type: "UTF8", optional: true },
    property_type: { type: "UTF8", optional: true },
    property_usage_type: { type: "UTF8", optional: true },
    built_year: { type: "INT64", optional: true },
    livable_floor_area: { type: "DOUBLE", optional: true },
    total_area: { type: "DOUBLE", optional: true },
    assessed_value: { type: "DOUBLE", optional: true },
    market_value: { type: "DOUBLE", optional: true },
    land_value: { type: "DOUBLE", optional: true },
    avm_value: { type: "DOUBLE", optional: true },
    owner_name: { type: "UTF8", optional: true },
    owners_text: { type: "UTF8", optional: true },
    owner_count: { type: "INT64", optional: true },
    owner_occupied: { type: "BOOLEAN", optional: true },
    last_sale_date: { type: "UTF8", optional: true },
    last_sale_price: { type: "DOUBLE", optional: true },
    subdivision: { type: "UTF8", optional: true },
    has_permits: { type: "BOOLEAN", optional: true },
    permit_count: { type: "INT64", optional: true },
    has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
    has_bbb_contractor: { type: "BOOLEAN", optional: true },
    hoa_flag: { type: "BOOLEAN", optional: true },
  });
}

/**
 * parquetjs treats `null` and `undefined` differently for optional fields —
 * `null` can trip the shredder, so drop null keys entirely (an absent optional
 * field is written as NULL, which is what we want).
 */
function toParquetRecord(row: QueryTableRow): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  return record;
}

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

export function parseOptions(argv: readonly string[]): QueryTableExportOptions {
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
  const manifest = values.get("manifest");

  return {
    limit: limit !== null && !Number.isNaN(limit) ? limit : null,
    outDir: values.get("out-dir") ?? ".query-table-export",
    county: values.get("county") ?? "lee",
    envFile: values.get("env-file") ?? ".env.local",
    manifestPath: manifest !== undefined && manifest !== "true" ? manifest : null,
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
// Manifest CID lookup
// ---------------------------------------------------------------------------

type ManifestShape = {
  readonly entries?: ReadonlyArray<{ readonly propertyId?: string; readonly cid?: string | null }>;
};

/**
 * Load the consolidation manifest and index CIDs by propertyId. Returns an empty
 * map (with a warning) when the manifest is absent — property_cid is then NULL.
 */
function loadCidMap(manifestPath: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (manifestPath === null) {
    console.warn(
      JSON.stringify({
        event: "manifest_not_provided",
        note: "property_cid will be NULL; pass --manifest <consolidation manifest.json> after running the consolidation export to populate CIDs",
      }),
    );
    return map;
  }

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestShape;
  for (const entry of parsed.entries ?? []) {
    if (entry.propertyId !== undefined && entry.cid !== undefined && entry.cid !== null) {
      map.set(entry.propertyId, entry.cid);
    }
  }
  console.log(JSON.stringify({ event: "manifest_loaded", manifestPath, cidCount: map.size }));
  return map;
}

// ---------------------------------------------------------------------------
// Single SQL pass
// ---------------------------------------------------------------------------

// Guarded numeric cast: text measurement columns hold free-form values, so parse
// only clean numerics and yield NULL otherwise (never throw on a bad cast).
function safeNumeric(expr: string): string {
  return `CASE WHEN (${expr})::text ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${expr})::text::numeric ELSE NULL END`;
}

// Digits-only normalization of a parcel identifier, matching normalizeParcelIdentifier
// in run-property-consolidation-export.ts. property_improvements store the already
// normalized key, so we normalize the appraisal parcel the same way to join.
const NORMALIZED_PARCEL = `regexp_replace(p.parcel_identifier, '[^0-9]', '', 'g')`;

/**
 * The one and only query. Pre-dedups every many-to-one relation into a CTE with
 * exactly one row per property, then folds to one row per folio via
 * DISTINCT ON (folio). The folio is the TRUE cardinality key — see the
 * parcel_identifier collapse lesson in run-geo-index-export.ts.
 */
async function fetchQueryTableRows(
  pool: Pool,
  sourceSystem: string,
  limit: number | null,
): Promise<QueryTableSourceRow[]> {
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  const result = await pool.query<QueryTableSourceRow>(
    `
    WITH tax_latest AS (
      SELECT DISTINCT ON (property_id)
        property_id,
        property_assessed_value_amount AS assessed_value,
        property_market_value_amount AS market_value,
        property_land_amount AS land_value
      FROM taxes
      ORDER BY property_id, tax_year DESC NULLS LAST
    ),
    avm AS (
      SELECT property_id, MAX(current_avm_value) AS avm_value
      FROM property_valuations
      GROUP BY property_id
    ),
    structure_pick AS (
      SELECT DISTINCT ON (property_id)
        property_id, exterior_wall_material_primary, roof_covering_material
      FROM structures
      ORDER BY property_id
    ),
    lot_pick AS (
      SELECT DISTINCT ON (property_id)
        property_id, lot_size_acre, lot_area_sqft
      FROM lots
      ORDER BY property_id
    ),
    layout_area AS (
      -- Building living area lives on the layout rows, one or more per property.
      -- Only the space_type='Building' rows carry these columns (room rows carry
      -- size_square_feet instead), so SUM ignores the NULL room rows and folds a
      -- multi-building parcel to its total living area — one row per property.
      SELECT property_id,
        SUM(livable_area_sq_ft) AS livable_area_sq_ft,
        SUM(area_under_air_sq_ft) AS area_under_air_sq_ft
      FROM layouts
      GROUP BY property_id
    ),
    geom_pick AS (
      SELECT DISTINCT ON (property_id)
        property_id, latitude, longitude
      FROM geometries
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY property_id
    ),
    owners_agg AS (
      SELECT
        property_id,
        string_agg(DISTINCT owned_by, ' | ') AS owners_text,
        count(DISTINCT owned_by) AS owner_count,
        bool_or(owner_occupied_indicator) AS owner_occupied
      FROM ownerships
      WHERE owned_by IS NOT NULL AND owned_by <> ''
      GROUP BY property_id
    ),
    owner_primary AS (
      SELECT DISTINCT ON (property_id)
        property_id, owned_by AS owner_name
      FROM ownerships
      WHERE owned_by IS NOT NULL AND owned_by <> ''
      ORDER BY property_id, ownership_percentage DESC NULLS LAST
    ),
    sale_latest AS (
      SELECT DISTINCT ON (property_id)
        property_id,
        ownership_transfer_date AS last_sale_date,
        purchase_price_amount AS last_sale_price
      FROM sales_histories
      ORDER BY property_id, ownership_transfer_date DESC NULLS LAST
    ),
    permit_counts AS (
      SELECT parcel_identifier, count(*) AS permit_count
      FROM property_improvements
      WHERE parcel_identifier IS NOT NULL AND parcel_identifier <> ''
      GROUP BY parcel_identifier
    ),
    sunbiz_keys AS (
      SELECT DISTINCT a_sun.normalized_address_key AS k
      FROM business_registration_addresses bra
      JOIN addresses a_sun ON a_sun.address_id = bra.address_id
      WHERE bra.address_role = 'PRINCIPAL'
        AND a_sun.normalized_address_key IS NOT NULL
    ),
    bbb_norm AS (
      SELECT DISTINCT
        regexp_replace(lower(coalesce(normalized_name, name, legal_name)), '[^a-z0-9]', '', 'g') AS nname
      FROM business_reputation_profiles
      WHERE provider ILIKE '%bbb%'
        AND coalesce(normalized_name, name, legal_name) IS NOT NULL
    ),
    permit_bbb AS (
      SELECT DISTINCT pi.parcel_identifier AS parcel_identifier
      FROM property_improvements pi
      JOIN companies c ON c.company_id = pi.contractor_company_id
      JOIN bbb_norm b ON b.nname = regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g')
      WHERE c.name IS NOT NULL AND c.name <> ''
    ),
    situs AS (
      SELECT DISTINCT ON (request_identifier)
        request_identifier, full_address
      FROM unnormalized_addresses
      WHERE source_system = $1
        AND request_identifier IS NOT NULL AND request_identifier <> ''
      ORDER BY request_identifier
    )
    SELECT DISTINCT ON (folio)
      p.property_id AS property_id,
      COALESCE(NULLIF(p.request_identifier, ''), NULLIF(par.request_identifier, ''), p.parcel_identifier) AS folio,
      COALESCE(NULLIF(p.request_identifier, ''), NULLIF(par.request_identifier, ''), p.parcel_identifier) AS request_identifier,
      p.parcel_identifier AS parcel_identifier,
      p.source_system AS source_system,
      par.county_name AS county_name,
      par.state_code AS state_code,
      a.street_number AS street_number,
      a.street_name AS street_name,
      a.street_suffix_type AS street_suffix_type,
      a.city_name AS city_name,
      a.postal_code AS postal_code,
      a.unnormalized_address AS unnormalized_address,
      su.full_address AS situs_full_address,
      gp.latitude AS latitude,
      gp.longitude AS longitude,
      ${safeNumeric("lp.lot_size_acre")} AS lot_size_acre,
      ${safeNumeric("lp.lot_area_sqft")} AS lot_area_sqft,
      sp.exterior_wall_material_primary AS exterior_wall_material,
      sp.roof_covering_material AS roof_covering_material,
      p.property_type AS property_type,
      p.property_usage_type AS property_usage_type,
      p.property_structure_built_year AS built_year,
      ${safeNumeric("p.livable_floor_area")} AS livable_floor_area,
      ${safeNumeric("p.total_area")} AS total_area,
      la.livable_area_sq_ft AS layout_livable_area_sq_ft,
      la.area_under_air_sq_ft AS layout_area_under_air_sq_ft,
      tl.assessed_value AS assessed_value,
      tl.market_value AS market_value,
      tl.land_value AS land_value,
      av.avm_value AS avm_value,
      op.owner_name AS owner_name,
      oa.owners_text AS owners_text,
      oa.owner_count AS owner_count,
      oa.owner_occupied AS owner_occupied,
      sl.last_sale_date AS last_sale_date,
      sl.last_sale_price AS last_sale_price,
      p.subdivision AS subdivision,
      (pc.permit_count IS NOT NULL) AS has_permits,
      COALESCE(pc.permit_count, 0) AS permit_count,
      (sk.k IS NOT NULL) AS has_sunbiz_tenant,
      (pb.parcel_identifier IS NOT NULL) AS has_bbb_contractor
    FROM properties p
    LEFT JOIN parcels par ON par.parcel_id = p.parcel_id
    LEFT JOIN addresses a ON a.address_id = p.address_id
    LEFT JOIN geom_pick gp ON gp.property_id = p.property_id
    LEFT JOIN lot_pick lp ON lp.property_id = p.property_id
    LEFT JOIN layout_area la ON la.property_id = p.property_id
    LEFT JOIN structure_pick sp ON sp.property_id = p.property_id
    LEFT JOIN tax_latest tl ON tl.property_id = p.property_id
    LEFT JOIN avm av ON av.property_id = p.property_id
    LEFT JOIN owner_primary op ON op.property_id = p.property_id
    LEFT JOIN owners_agg oa ON oa.property_id = p.property_id
    LEFT JOIN sale_latest sl ON sl.property_id = p.property_id
    LEFT JOIN permit_counts pc ON pc.parcel_identifier = ${NORMALIZED_PARCEL}
    LEFT JOIN sunbiz_keys sk ON sk.k = a.normalized_address_key
    LEFT JOIN permit_bbb pb ON pb.parcel_identifier = ${NORMALIZED_PARCEL}
    LEFT JOIN situs su ON su.request_identifier = p.request_identifier
    WHERE p.source_system = $1
    ORDER BY folio, p.property_id
    ${limitClause}
  `,
    [sourceSystem],
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

  const sourceSystem = appraisalSourceForCounty(options.county);
  const startedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: "query_table_export_started",
      county: options.county,
      sourceSystem,
      limit: options.limit,
      outDir: options.outDir,
      startedAt,
    }),
  );

  const cidMap = loadCidMap(options.manifestPath);

  const pg = new Pool({
    application_name: "elephant-query-table-export",
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
    const parquetPath = join(countyDir, "query-table.parquet");

    const rows = await fetchQueryTableRows(pg, sourceSystem, options.limit);

    const schema = buildQueryTableParquetSchema();
    const writer = await ParquetWriter.openFile(schema, parquetPath);

    let written = 0;
    let withCid = 0;
    try {
      for (const raw of rows) {
        const cid = cidMap.get(raw.property_id) ?? null;
        if (cid !== null) withCid += 1;
        await writer.appendRow(toParquetRecord(buildQueryTableRow(raw, cid)));
        written += 1;
      }
    } finally {
      await writer.close();
    }

    console.log(
      JSON.stringify({
        event: "query_table_export_finished",
        county: options.county,
        rowCount: written,
        rowsWithCid: withCid,
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
    console.error(JSON.stringify({ event: "query_table_export_failed", error: message }));
    process.exit(1);
  });
}
