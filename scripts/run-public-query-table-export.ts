import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ParquetWriter } from "@dsnp/parquetjs";
import { Pool } from "pg";

import {
  buildQueryTableParquetSchema,
  type QueryTableRow,
} from "./run-query-table-export.js";
import {
  parseRockIslandSiteAddress,
  sourceSystemForCounty,
} from "./run-public-property-export.js";
import { isJsonObject } from "./public-geometry.js";

export type PublicQueryTableOptions = {
  readonly county: string;
  readonly outDir: string;
  readonly manifestPath: string;
};

export type PublicQueryTableSourceRow = {
  readonly property_id: string;
  readonly request_identifier: string;
  readonly parcel_identifier: string;
  readonly source_system: string;
  readonly county_name: string | null;
  readonly state_code: string | null;
  readonly address_street: string | null;
  readonly address_city: string | null;
  readonly address_zip: string | null;
  readonly address_unnormalized: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly geometry_source_payload: unknown;
  readonly lot_size_acre: string | null;
  readonly lot_area_sqft: string | null;
  readonly exterior_wall_material: string | null;
  readonly roof_covering_material: string | null;
  readonly property_type: string | null;
  readonly property_usage_type: string | null;
  readonly built_year: number | null;
  readonly livable_floor_area: string | null;
  readonly total_area: string | null;
  readonly assessed_value: string | null;
  readonly market_value: string | null;
  readonly land_value: string | null;
  readonly avm_value: string | null;
  readonly last_sale_date: string | null;
  readonly last_sale_price: string | null;
  readonly subdivision: string | null;
};

type Manifest = {
  readonly entries?: ReadonlyArray<{
    readonly propertyId?: string;
    readonly cid?: string | null;
  }>;
};

/**
 * Parse the public query-table command line.
 *
 * @param argv - Arguments after the script name.
 * @returns County, output directory, and required consolidation manifest.
 */
export function parsePublicQueryTableOptions(
  argv: readonly string[],
): PublicQueryTableOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const county = values.get("county") ?? "rock-island";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(county)) {
    throw new Error("county must be a lowercase hyphenated slug");
  }
  const manifestPath = values.get("manifest");
  if (manifestPath === undefined) {
    throw new Error("--manifest is required for a public query-table export");
  }
  return {
    county,
    outDir: values.get("out-dir") ?? ".public-query-table-export",
    manifestPath,
  };
}

/**
 * Convert PostgreSQL numeric text to a finite number.
 *
 * @param value - Nullable numeric text.
 * @returns A finite number or null.
 */
function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read a verified representative point retained in the nested raw geometry
 * source payload.
 *
 * @param payload - Enriched geometry source payload.
 * @returns Longitude and latitude from the original appraiser capture.
 */
export function readVerifiedGeometryCoordinate(
  payload: unknown,
): { readonly longitude: number | null; readonly latitude: number | null } {
  if (!isJsonObject(payload) || !isJsonObject(payload.source_payload)) {
    return { longitude: null, latitude: null };
  }
  const raw = payload.source_payload;
  const longitude = numberOrNull(
    typeof raw.longitude === "string"
      ? raw.longitude
      : typeof raw.X_longitude === "string"
        ? raw.X_longitude
        : null,
  );
  const latitude = numberOrNull(
    typeof raw.latitude === "string"
      ? raw.latitude
      : typeof raw.Y_latitude === "string"
        ? raw.Y_latitude
        : null,
  );
  return {
    longitude:
      longitude !== null && longitude >= -180 && longitude <= 180
        ? longitude
        : null,
    latitude:
      latitude !== null && latitude >= -90 && latitude <= 90
        ? latitude
        : null,
  };
}

/**
 * Load parcel-rooted CIDs from the public consolidation manifest.
 *
 * @param manifestPath - Local consolidation manifest path.
 * @returns CID lookup keyed by exported parcel UUID.
 */
async function loadCidMap(manifestPath: string): Promise<Map<string, string>> {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const map = new Map<string, string>();
  for (const entry of parsed.entries ?? []) {
    if (
      entry.propertyId !== undefined &&
      entry.cid !== undefined &&
      entry.cid !== null
    ) {
      map.set(entry.propertyId, entry.cid);
    }
  }
  return map;
}

/**
 * Fetch one public scalar row per parcel folio, with all PII/enrichment tracks
 * structurally absent from the SQL.
 *
 * @param pool - Connected PostgreSQL pool.
 * @param sourceSystem - County appraiser source-system key.
 * @returns Exactly one row per source parcel.
 */
async function fetchRows(
  pool: Pool,
  sourceSystem: string,
): Promise<PublicQueryTableSourceRow[]> {
  const result = await pool.query<PublicQueryTableSourceRow>(
    `
      WITH first_property AS (
        SELECT DISTINCT ON (request_identifier) *
        FROM properties
        WHERE source_system = $1
        ORDER BY request_identifier, property_id
      ),
      first_address AS (
        SELECT DISTINCT ON (request_identifier) *
        FROM addresses
        WHERE source_system = $1
        ORDER BY request_identifier, address_id
      ),
      first_geometry AS (
        SELECT DISTINCT ON (request_identifier)
          request_identifier,
          latitude,
          longitude,
          source_payload
        FROM geometries
        WHERE source_system = $1
        ORDER BY request_identifier, geometry_id
      ),
      first_lot AS (
        SELECT DISTINCT ON (request_identifier)
          request_identifier,
          lot_size_acre,
          lot_area_sqft
        FROM lots
        WHERE source_system = $1
        ORDER BY request_identifier, lot_id
      ),
      first_structure AS (
        SELECT DISTINCT ON (request_identifier)
          request_identifier,
          exterior_wall_material_primary,
          roof_covering_material
        FROM structures
        WHERE source_system = $1
        ORDER BY request_identifier, structure_id
      ),
      layout_totals AS (
        SELECT
          request_identifier,
          sum(livable_area_sq_ft) AS livable_area_sq_ft,
          sum(area_under_air_sq_ft) AS area_under_air_sq_ft
        FROM layouts
        WHERE source_system = $1
        GROUP BY request_identifier
      ),
      latest_tax AS (
        SELECT DISTINCT ON (request_identifier) *
        FROM taxes
        WHERE source_system = $1
        ORDER BY request_identifier, tax_year DESC NULLS LAST, tax_id
      ),
      latest_valuation AS (
        SELECT DISTINCT ON (property.request_identifier)
          property.request_identifier,
          valuation.current_avm_value
        FROM property_valuations valuation
        JOIN properties property
          ON property.property_id = valuation.property_id
         AND property.source_system = valuation.source_system
        WHERE valuation.source_system = $1
          AND property.source_system = $1
        ORDER BY
          property.request_identifier,
          valuation.valuation_date DESC NULLS LAST,
          valuation.property_valuation_id
      ),
      latest_sale AS (
        SELECT DISTINCT ON (request_identifier) *
        FROM sales_histories
        WHERE source_system = $1
        ORDER BY request_identifier, ownership_transfer_date DESC NULLS LAST, sales_history_id
      )
      SELECT
        par.parcel_id AS property_id,
        par.request_identifier,
        par.parcel_identifier,
        par.source_system,
        par.county_name,
        par.state_code,
        COALESCE(
          NULLIF(trim(concat_ws(' ', address.street_number, address.street_name, address.street_suffix_type)), ''),
          address.unnormalized_address
        ) AS address_street,
        address.city_name AS address_city,
        address.postal_code AS address_zip,
        address.unnormalized_address AS address_unnormalized,
        geometry.latitude,
        geometry.longitude,
        geometry.source_payload AS geometry_source_payload,
        lot.lot_size_acre,
        lot.lot_area_sqft,
        structure.exterior_wall_material_primary AS exterior_wall_material,
        structure.roof_covering_material,
        property.property_type,
        property.property_usage_type,
        property.property_structure_built_year AS built_year,
        COALESCE(
          property.livable_floor_area::text,
          layout.livable_area_sq_ft::text,
          layout.area_under_air_sq_ft::text
        ) AS livable_floor_area,
        property.total_area,
        tax.property_assessed_value_amount AS assessed_value,
        tax.property_market_value_amount AS market_value,
        tax.property_land_amount AS land_value,
        valuation.current_avm_value AS avm_value,
        sale.ownership_transfer_date::text AS last_sale_date,
        sale.purchase_price_amount AS last_sale_price,
        property.subdivision
      FROM parcels par
      LEFT JOIN first_property property
        ON property.request_identifier = par.request_identifier
      LEFT JOIN first_address address
        ON address.request_identifier = par.request_identifier
      LEFT JOIN first_geometry geometry
        ON geometry.request_identifier = par.request_identifier
      LEFT JOIN first_lot lot
        ON lot.request_identifier = par.request_identifier
      LEFT JOIN first_structure structure
        ON structure.request_identifier = par.request_identifier
      LEFT JOIN layout_totals layout
        ON layout.request_identifier = par.request_identifier
      LEFT JOIN latest_tax tax
        ON tax.request_identifier = par.request_identifier
      LEFT JOIN latest_valuation valuation
        ON valuation.request_identifier = par.request_identifier
      LEFT JOIN latest_sale sale
        ON sale.request_identifier = par.request_identifier
      WHERE par.source_system = $1
        AND par.request_identifier IS NOT NULL
        AND par.request_identifier <> ''
      ORDER BY par.request_identifier, par.parcel_id
    `,
    [sourceSystem],
  );
  return result.rows;
}

/**
 * Map a database row to the stable query-table schema with denied datasets
 * explicitly null/false.
 *
 * @param row - Parcel-rooted public database row.
 * @param cid - Consolidated property CID for the same parcel UUID.
 * @returns One scalar-only public query-table row.
 */
export function buildPublicQueryTableRow(
  row: PublicQueryTableSourceRow,
  cid: string,
): QueryTableRow {
  const lotAreaSqft = numberOrNull(row.lot_area_sqft);
  const parsedSiteAddress = parseRockIslandSiteAddress(
    row.address_unnormalized,
  );
  const verifiedCoordinate = readVerifiedGeometryCoordinate(
    row.geometry_source_payload,
  );
  return {
    property_id: row.property_id,
    property_cid: cid,
    request_identifier: row.request_identifier,
    parcel_identifier: row.parcel_identifier,
    source_system: row.source_system,
    county_name: row.county_name,
    state_code: row.state_code,
    address_street: row.address_street ?? parsedSiteAddress.street,
    address_city: row.address_city ?? parsedSiteAddress.city,
    address_zip: row.address_zip ?? parsedSiteAddress.postalCode,
    latitude: verifiedCoordinate.latitude ?? numberOrNull(row.latitude),
    longitude: verifiedCoordinate.longitude ?? numberOrNull(row.longitude),
    lot_size_acre:
      numberOrNull(row.lot_size_acre) ??
      (lotAreaSqft === null ? null : lotAreaSqft / 43_560),
    lot_area_sqft: lotAreaSqft,
    exterior_wall_material: row.exterior_wall_material,
    roof_covering_material: row.roof_covering_material,
    property_type: row.property_type,
    property_usage_type: row.property_usage_type,
    built_year: row.built_year,
    livable_floor_area: numberOrNull(row.livable_floor_area),
    total_area: numberOrNull(row.total_area),
    assessed_value: numberOrNull(row.assessed_value),
    market_value: numberOrNull(row.market_value),
    land_value: numberOrNull(row.land_value),
    avm_value: numberOrNull(row.avm_value),
    owner_name: null,
    owners_text: null,
    owner_count: null,
    owner_occupied: null,
    last_sale_date: row.last_sale_date,
    last_sale_price: numberOrNull(row.last_sale_price),
    subdivision: row.subdivision,
    has_permits: false,
    permit_count: 0,
    has_sunbiz_tenant: false,
    has_bbb_contractor: false,
    has_pa_corp_tenant: false,
    hoa_flag: null,
  };
}

/**
 * Remove null optional values before passing a row to parquetjs.
 *
 * @param row - Typed query-table row.
 * @returns Parquet-compatible scalar record.
 */
function toParquetRecord(row: QueryTableRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  );
}

/**
 * Export the full parcel-rooted public query table.
 *
 * @param options - County, output, and consolidation manifest paths.
 * @returns Row count and local parquet path.
 */
export async function runPublicQueryTableExport(
  options: PublicQueryTableOptions,
): Promise<{ readonly rowCount: number; readonly parquetPath: string }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const cidMap = await loadCidMap(options.manifestPath);
  const pool = new Pool({
    application_name: "elephant-public-query-table-export",
    connectionString: databaseUrl,
    max: 3,
  });
  try {
    const rows = await fetchRows(pool, sourceSystemForCounty(options.county));
    if (rows.length !== new Set(rows.map((row) => row.request_identifier)).size) {
      throw new Error("Public query-table source contains duplicate folios");
    }
    if (cidMap.size !== rows.length) {
      throw new Error(
        `Consolidation CID count ${cidMap.size} does not equal query-table rows ${rows.length}`,
      );
    }
    const countyDirectory = join(options.outDir, options.county);
    await mkdir(countyDirectory, { recursive: true });
    const parquetPath = join(countyDirectory, "query-table.parquet");
    const writer = await ParquetWriter.openFile(
      buildQueryTableParquetSchema(),
      parquetPath,
    );
    try {
      for (const row of rows) {
        const cid = cidMap.get(row.property_id);
        if (cid === undefined) {
          throw new Error(`Missing consolidation CID for ${row.property_id}`);
        }
        await writer.appendRow(
          toParquetRecord(buildPublicQueryTableRow(row, cid)),
        );
      }
    } finally {
      await writer.close();
    }
    console.log(
      JSON.stringify({
        event: "public_query_table_export_complete",
        rowCount: rows.length,
        parquetPath,
      }),
    );
    return { rowCount: rows.length, parquetPath };
  } finally {
    await pool.end();
  }
}

/**
 * Execute the public query-table exporter when invoked directly.
 *
 * @returns A promise that resolves after the local parquet is closed.
 */
async function main(): Promise<void> {
  await runPublicQueryTableExport(
    parsePublicQueryTableOptions(process.argv.slice(2)),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({
        event: "public_query_table_export_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
