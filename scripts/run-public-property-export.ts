import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  buildManifestEntry,
  buildManifestSummary,
  computeIpfsCid,
  writeShardedIndex,
  type ManifestEntry,
} from "./run-property-consolidation-export.js";
import { buildExactMultiPolygon } from "./public-geometry.js";

export type PublicPropertyExportOptions = {
  readonly county: string;
  readonly outDir: string;
  readonly batchSize: number;
  readonly shardSize: number;
};

type JsonRecord = Record<string, unknown>;

type ParentRow = {
  readonly parcel_id: string;
  readonly request_identifier: string;
  readonly parcel_identifier: string;
  readonly county_name: string | null;
  readonly state_code: string | null;
  readonly jurisdiction_key: string | null;
  readonly source_system: string;
  readonly source_payload: unknown;
  readonly property_id: string | null;
  readonly address_id: string | null;
  readonly property_type: string | null;
  readonly property_usage_type: string | null;
  readonly structure_form: string | null;
  readonly build_status: string | null;
  readonly built_year: number | null;
  readonly effective_built_year: number | null;
  readonly livable_floor_area: string | null;
  readonly total_area: string | null;
  readonly area_under_air: string | null;
  readonly number_of_units: number | null;
  readonly subdivision: string | null;
  readonly zoning: string | null;
  readonly legal_description: string | null;
  readonly street_number: string | null;
  readonly street_name: string | null;
  readonly street_suffix_type: string | null;
  readonly city_name: string | null;
  readonly address_state_code: string | null;
  readonly postal_code: string | null;
  readonly unnormalized_address: string | null;
};

type ChildRow = {
  readonly request_identifier: string;
  readonly [column: string]: unknown;
};

type GeometryRow = ChildRow & {
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly source_payload: unknown;
};

const DENIED_PUBLIC_KEY =
  /^(?:owner|purchased_(?:email|phone)|contact_suppression|campaign_history|owner_responses|contact|campaign|phone|email|raw_?name|reviewer_?display_?name)/iu;

const ROCK_ISLAND_ARCGIS_PUBLIC_FIELDS = new Set([
  "OBJECTID",
  "RICO_PARCE",
  "PIN",
  "GIS_acres_num",
  "X_longitude",
  "Y_latitude",
  "TWP_RAN_SE",
  "parcel_number",
  "alternate_parcel_number",
  "site_address",
  "site_csz",
  "Site_City",
  "Site_State",
  "Site_Zip",
  "gross_acres",
  "class",
  "EMV",
  "EAV",
  "farm_land",
  "farm_building",
  "non_farm_land",
  "non_farm_building",
  "date_last_sale",
  "gross_sale_price",
  "net_sale_price",
  "legal",
  "date_of_sale",
  "county",
  "municipality",
  "Jurisdiction",
  "township",
  "tax_code",
  "taxbill_year",
  "Zoning",
  "assessed_last",
  "MODLNAME",
  "YRBuilt",
  "GarSQFT",
  "TOTSQFT",
  "Shape__Area",
  "Shape__Length",
]);

/**
 * Return true when a JSON value is a non-array object.
 *
 * @param value - Candidate JSON value.
 * @returns Whether the value is a mutable string-keyed record.
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fail closed when a public export contains a denied PII/contact/campaign key.
 *
 * The check recursively covers the complete emitted record, including the
 * retained appraiser `sourcePayload`. Values are intentionally not pattern
 * matched: legal descriptions and parcel identifiers can contain digit runs,
 * while the source contract prevents contact data by field name.
 *
 * @param value - Complete candidate public record.
 * @param location - Human-readable traversal location for diagnostics.
 * @returns Nothing when the record is public-safe.
 */
export function assertPublicNonPii(
  value: unknown,
  location = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPublicNonPii(entry, `${location}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, field] of Object.entries(value)) {
    const fieldLocation = `${location}.${key}`;
    const normalizedKey = key.toLowerCase();
    const deniedTaxbill =
      normalizedKey.startsWith("taxbill") && normalizedKey !== "taxbill_year";
    if (deniedTaxbill || DENIED_PUBLIC_KEY.test(key)) {
      throw new Error(`Denied public-data field at ${fieldLocation}`);
    }
    assertPublicNonPii(field, fieldLocation);
  }
}

/**
 * Fail closed if an ArcGIS request asks for a field outside the approved
 * Rock Island public capture allowlist.
 *
 * @param value - Complete source provenance payload.
 * @param location - Recursive diagnostic path.
 * @returns Nothing when every discovered outFields value is approved.
 */
export function assertRockIslandArcGisOutFields(
  value: unknown,
  location = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertRockIslandArcGisOutFields(entry, `${location}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, field] of Object.entries(value)) {
    const fieldLocation = `${location}.${key}`;
    if (key.toLowerCase() === "outfields") {
      const rawFields = Array.isArray(field)
        ? field.flatMap((entry) =>
            typeof entry === "string" ? entry.split(",") : [],
          )
        : typeof field === "string"
          ? field.split(",")
          : [];
      if (rawFields.length === 0) {
        throw new Error(`ArcGIS outFields is empty or invalid at ${fieldLocation}`);
      }
      for (const rawField of rawFields) {
        const candidate = rawField.trim();
        if (!ROCK_ISLAND_ARCGIS_PUBLIC_FIELDS.has(candidate)) {
          throw new Error(
            `Unexpected ArcGIS outField ${candidate || "<blank>"} at ${fieldLocation}`,
          );
        }
      }
    }
    assertRockIslandArcGisOutFields(field, fieldLocation);
  }
}

export type PublicSiteAddress = {
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
};

/**
 * Recover only Rock Island site-address facts from an unnormalized site address.
 * Owner-mailing fields are deliberately not accepted by this function.
 *
 * @param unnormalized - Site address such as "100 MAIN ST, MOLINE, IL 61265".
 * @returns Safely parsed site street/city/state/ZIP.
 */
export function parseRockIslandSiteAddress(
  unnormalized: string | null,
): PublicSiteAddress {
  if (unnormalized === null || unnormalized.trim().length === 0) {
    return { street: null, city: null, state: null, postalCode: null };
  }
  const parts = unnormalized
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 3) {
    return {
      street: unnormalized.trim(),
      city: null,
      state: null,
      postalCode: null,
    };
  }
  const statePostal = parts
    .at(-1)
    ?.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/u);
  if (statePostal === undefined || statePostal === null) {
    return {
      street: unnormalized.trim(),
      city: null,
      state: null,
      postalCode: null,
    };
  }
  return {
    street: parts.slice(0, -2).join(", "),
    city: parts.at(-2) ?? null,
    state: statePostal[1] ?? null,
    postalCode: statePostal[2] ?? null,
  };
}

/**
 * Convert a county slug to its appraiser source-system key.
 *
 * @param county - Lowercase hyphenated county slug.
 * @returns Query database source-system identifier.
 */
export function sourceSystemForCounty(county: string): string {
  const normalized = county
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `${normalized}_appraiser`;
}

/**
 * Parse public-export command-line options with bounded positive defaults.
 *
 * @param argv - CLI arguments after the script name.
 * @returns Validated county, output, batch, and shard options.
 */
export function parsePublicPropertyOptions(
  argv: readonly string[],
): PublicPropertyExportOptions {
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
  const batchSize = Number.parseInt(values.get("batch-size") ?? "500", 10);
  const shardSize = Number.parseInt(values.get("shard-size") ?? "10000", 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error("batch-size must be between 1 and 5000");
  }
  if (!Number.isInteger(shardSize) || shardSize < 1) {
    throw new Error("shard-size must be positive");
  }
  return {
    county,
    outDir: values.get("out-dir") ?? ".public-property-export",
    batchSize,
    shardSize,
  };
}

/**
 * Group child rows by true source folio.
 *
 * @param rows - Database child rows carrying request_identifier.
 * @returns Child rows keyed by request_identifier in database order.
 */
function groupByFolio<TRow extends ChildRow>(
  rows: readonly TRow[],
): Map<string, TRow[]> {
  const grouped = new Map<string, TRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.request_identifier);
    if (existing === undefined) grouped.set(row.request_identifier, [row]);
    else existing.push(row);
  }
  return grouped;
}

/**
 * Select parcel-rooted parent records so every source folio is exported even
 * when its transform produced no logical `properties` row.
 *
 * @param pool - Connected PostgreSQL pool.
 * @param sourceSystem - County appraiser source-system key.
 * @returns Exactly one deterministic parent row per source folio.
 */
async function fetchParents(
  pool: Pool,
  sourceSystem: string,
): Promise<ParentRow[]> {
  const result = await pool.query<ParentRow>(
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
      )
      SELECT
        par.parcel_id,
        par.request_identifier,
        par.parcel_identifier,
        par.county_name,
        par.state_code,
        par.jurisdiction_key,
        par.source_system,
        par.source_payload,
        prop.property_id,
        address.address_id,
        prop.property_type,
        prop.property_usage_type,
        prop.structure_form,
        prop.build_status,
        prop.property_structure_built_year AS built_year,
        prop.property_effective_built_year AS effective_built_year,
        prop.livable_floor_area,
        prop.total_area,
        prop.area_under_air,
        prop.number_of_units,
        prop.subdivision,
        prop.zoning,
        prop.property_legal_description_text AS legal_description,
        address.street_number,
        address.street_name,
        address.street_suffix_type,
        address.city_name,
        address.state_code AS address_state_code,
        address.postal_code,
        address.unnormalized_address
      FROM parcels par
      LEFT JOIN first_property prop
        ON prop.request_identifier = par.request_identifier
      LEFT JOIN first_address address
        ON address.request_identifier = par.request_identifier
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
 * Fetch every row for a public-safe appraisal child table and folio batch.
 *
 * Table and column lists are compile-time constants owned by this module; only
 * folios/source-system are supplied as SQL parameters.
 *
 * @param pool - Connected PostgreSQL pool.
 * @param table - Approved appraisal child table.
 * @param columns - Approved non-PII scalar columns.
 * @param sourceSystem - County appraiser source-system key.
 * @param folios - True request identifiers in the current batch.
 * @returns Database rows in stable source-record order.
 */
async function fetchChildren(
  pool: Pool,
  table: string,
  columns: string,
  sourceSystem: string,
  folios: readonly string[],
): Promise<ChildRow[]> {
  const result = await pool.query<ChildRow>(
    `SELECT request_identifier, ${columns}
       FROM ${table}
      WHERE source_system = $1
        AND request_identifier = ANY($2::text[])
      ORDER BY request_identifier, source_record_key`,
    [sourceSystem, folios],
  );
  return result.rows;
}

/**
 * Fetch valuation rows through their parent property because the valuation
 * table does not carry request_identifier directly.
 *
 * @param pool - Connected PostgreSQL pool.
 * @param sourceSystem - County appraiser source-system key.
 * @param folios - True request identifiers in the current batch.
 * @returns Valuation rows keyed by their parent property's folio.
 */
async function fetchValuations(
  pool: Pool,
  sourceSystem: string,
  folios: readonly string[],
): Promise<ChildRow[]> {
  const result = await pool.query<ChildRow>(
    `SELECT p.request_identifier,
            v.valuation_date,
            v.current_avm_value,
            v.high_value,
            v.low_value,
            v.confidence_score
       FROM property_valuations v
       JOIN properties p
         ON p.property_id = v.property_id
        AND p.source_system = v.source_system
      WHERE v.source_system = $1
        AND p.source_system = $1
        AND p.request_identifier = ANY($2::text[])
      ORDER BY p.request_identifier, v.source_record_key`,
    [sourceSystem, folios],
  );
  return result.rows;
}

/**
 * Build and write the complete public non-PII county export.
 *
 * @param options - County/output/batching configuration.
 * @returns Final manifest/index summary and local CIDs.
 */
export async function runPublicPropertyExport(
  options: PublicPropertyExportOptions,
): Promise<{
  readonly propertyCount: number;
  readonly totalBytes: number;
  readonly indexCid: string | null;
  readonly manifestCid: string | null;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const sourceSystem = sourceSystemForCounty(options.county);
  const pool = new Pool({
    application_name: "elephant-public-property-export",
    connectionString: databaseUrl,
    max: 5,
  });
  const startedAt = new Date().toISOString();
  const propertiesDirectory = join(options.outDir, "properties");
  await mkdir(propertiesDirectory, { recursive: true });
  const entries: ManifestEntry[] = [];
  let totalBytes = 0;
  try {
    const parents = await fetchParents(pool, sourceSystem);
    const distinctFolios = new Set(
      parents.map((row) => row.request_identifier),
    );
    if (parents.length !== distinctFolios.size) {
      throw new Error(
        `Parcel-rooted export has duplicate folios: rows=${parents.length} distinct=${distinctFolios.size}`,
      );
    }
    const folios = parents.map((row) => row.request_identifier);
    const [
      taxes,
      sales,
      structures,
      layouts,
      lots,
      utilities,
      deeds,
      files,
      valuations,
      geometries,
      flood,
    ] = await Promise.all([
      fetchChildren(
        pool,
        "taxes",
        "tax_year, property_assessed_value_amount AS assessed_value, property_market_value_amount AS market_value, property_building_amount AS building_value, property_land_amount AS land_value, property_taxable_value_amount AS taxable_value, yearly_tax_amount",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "sales_histories",
        "ownership_transfer_date AS sale_date, purchase_price_amount AS sale_price, sale_type, instrument_number",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "structures",
        "architectural_style_type, attachment_type, exterior_wall_material_primary, roof_covering_material, roof_design_type, foundation_type, number_of_stories, finished_base_area",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "layouts",
        "space_type, space_index, built_year, size_square_feet, livable_area_sq_ft, area_under_air_sq_ft, total_area_sq_ft",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "lots",
        "lot_type, lot_area_sqft, lot_size_acre, landscaping_features, view",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "utilities",
        "cooling_system_type, heating_system_type, heating_fuel_type, sewer_type, water_source_type, solar_panel_present, hvac_capacity_tons",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "deeds",
        "deed_type, book, page, instrument_number",
        sourceSystem,
        folios,
      ),
      fetchChildren(
        pool,
        "files",
        "document_type, file_format, ipfs_url, name",
        sourceSystem,
        folios,
      ),
      fetchValuations(pool, sourceSystem, folios),
      fetchChildren(
        pool,
        "geometries",
        "latitude, longitude, source_payload",
        sourceSystem,
        folios,
      ) as Promise<GeometryRow[]>,
      fetchChildren(
        pool,
        "flood_storm_information",
        "flood_zone, evacuation_zone, flood_insurance_required",
        sourceSystem,
        folios,
      ),
    ]);
    const maps = {
      taxes: groupByFolio(taxes),
      sales: groupByFolio(sales),
      structures: groupByFolio(structures),
      layouts: groupByFolio(layouts),
      lots: groupByFolio(lots),
      utilities: groupByFolio(utilities),
      deeds: groupByFolio(deeds),
      files: groupByFolio(files),
      valuations: groupByFolio(valuations),
      geometries: groupByFolio(geometries),
      flood: groupByFolio(flood),
    };
    for (
      let batchStart = 0;
      batchStart < parents.length;
      batchStart += options.batchSize
    ) {
      const batch = parents.slice(batchStart, batchStart + options.batchSize);
      for (const parent of batch) {
        const folio = parent.request_identifier;
        const geometryRows = maps.geometries.get(folio) ?? [];
        const structuredStreet = [
          parent.street_number,
          parent.street_name,
          parent.street_suffix_type,
        ]
          .filter((value): value is string => value !== null && value.length > 0)
          .join(" ");
        const parsedSiteAddress = parseRockIslandSiteAddress(
          parent.unnormalized_address,
        );
        const record = {
          schemaVersion: "1",
          parcelId: parent.parcel_id,
          requestIdentifier: folio,
          county: options.county,
          jurisdictionKey: parent.jurisdiction_key,
          sourceSystem: parent.source_system,
          address:
            parent.address_id === null
              ? null
              : {
                  street:
                    structuredStreet.length > 0
                      ? structuredStreet
                      : parsedSiteAddress.street,
                  city: parent.city_name ?? parsedSiteAddress.city,
                  state:
                    parent.address_state_code ??
                    parsedSiteAddress.state ??
                    parent.state_code,
                  postalCode:
                    parent.postal_code ?? parsedSiteAddress.postalCode,
                  unnormalizedAddress: parent.unnormalized_address,
                },
          property:
            parent.property_id === null
              ? null
              : {
                  propertyType: parent.property_type,
                  usageType: parent.property_usage_type,
                  structureForm: parent.structure_form,
                  buildStatus: parent.build_status,
                  builtYear: parent.built_year,
                  effectiveBuiltYear: parent.effective_built_year,
                  livableArea: parent.livable_floor_area,
                  totalArea: parent.total_area,
                  areaUnderAir: parent.area_under_air,
                  numberOfUnits: parent.number_of_units,
                  subdivision: parent.subdivision,
                  zoning: parent.zoning,
                  legalDescription: parent.legal_description,
                },
          parcel: {
            parcelIdentifier: parent.parcel_identifier,
            countyName: parent.county_name,
            stateCode: parent.state_code,
          },
          parcelPolygon: buildExactMultiPolygon(
            geometryRows.map((row) => row.source_payload),
          ),
          geometries: geometryRows.map((row) => ({
            latitude: row.latitude,
            longitude: row.longitude,
            sourcePayload: row.source_payload,
          })),
          taxes: maps.taxes.get(folio) ?? [],
          sales: maps.sales.get(folio) ?? [],
          structures: maps.structures.get(folio) ?? [],
          layouts: maps.layouts.get(folio) ?? [],
          lots: maps.lots.get(folio) ?? [],
          utilities: maps.utilities.get(folio) ?? [],
          deeds: maps.deeds.get(folio) ?? [],
          files: maps.files.get(folio) ?? [],
          valuations: maps.valuations.get(folio) ?? [],
          floodStormInformation: maps.flood.get(folio) ?? [],
          sourcePayload: parent.source_payload,
          coverage: {
            appraisal: "complete",
            permits: "not_ingested",
            corporate: "not_ingested",
            bbb: "not_ingested",
          },
          collectedAt: startedAt,
        };
        assertRockIslandArcGisOutFields(record.sourcePayload);
        assertPublicNonPii(record);
        const body = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
        const filePath = join(propertiesDirectory, `${parent.parcel_id}.json`);
        await writeFile(filePath, body, { mode: 0o600 });
        const cid = await computeIpfsCid(body);
        if (cid === null) {
          throw new Error(`Unable to compute property CID for folio ${folio}`);
        }
        entries.push(
          buildManifestEntry({
            propertyId: parent.parcel_id,
            parcelIdentifier: folio,
            filePath,
            fileSizeBytes: body.byteLength,
            sha256: createHash("sha256").update(body).digest("hex"),
            cid,
          }),
        );
        totalBytes += body.byteLength;
      }
      console.log(
        JSON.stringify({
          event: "public_property_export_batch",
          completed: Math.min(batchStart + batch.length, parents.length),
          total: parents.length,
        }),
      );
    }
    const completedAt = new Date().toISOString();
    const manifest = buildManifestSummary(
      entries,
      startedAt,
      completedAt,
      options.county,
    );
    const manifestBody = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(options.outDir, "manifest.json"), manifestBody, {
      mode: 0o600,
    });
    const index = await writeShardedIndex(
      entries,
      options.outDir,
      options.shardSize,
      options.county,
      startedAt,
      completedAt,
      totalBytes,
    );
    const indexBody = Buffer.from(
      `${JSON.stringify(index, null, 2)}\n`,
      "utf8",
    );
    const indexCid = await computeIpfsCid(indexBody);
    const manifestCid = await computeIpfsCid(manifestBody);
    console.log(
      JSON.stringify({
        event: "public_property_export_complete",
        propertyCount: entries.length,
        totalBytes,
        indexCid,
        manifestCid,
      }),
    );
    return {
      propertyCount: entries.length,
      totalBytes,
      indexCid,
      manifestCid,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Execute the public property exporter when invoked directly.
 *
 * @returns A promise that resolves after all local artifacts are written.
 */
async function main(): Promise<void> {
  await runPublicPropertyExport(
    parsePublicPropertyOptions(process.argv.slice(2)),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({ event: "public_property_export_failed", error: message }),
    );
    process.exit(1);
  });
}
