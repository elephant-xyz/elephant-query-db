import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool, type PoolClient } from "pg";

import {
  buildNormalizedAddressKey,
  hashJson,
  hashNormalizedAddressKey,
  type JsonObject,
} from "../src/loader/index.js";

const SOURCE_SYSTEM = "rock_island_appraiser";
const EXPECTED_PROPERTIES = 65_806;
const EXPECTED_SUPPORTED_ADDRESSES = 65_800;
const EXPECTED_NULL_ADDRESSES = 6;
const EXPECTED_FOUND_BACKFILLS = 19;
const EXPECTED_NOT_FOUND = 6;
const EXPECTED_OFFICIAL_LABELS = 65_653;
const EXPECTED_NON_UNKNOWN_USAGE = 63_123;
const EXPECTED_COMMERCIAL_INDUSTRIAL = 4_602;
const EXPECTED_UNKNOWN_USAGE = 2_683;
const ADDRESS_PACKAGE_ID = "rock-island-site-address-backfill-v1";
const ADDRESS_PACKAGE_SHA256 =
  "94e5a720ba91a827b752929879170d740b2d135674f1c181bb4c99f3f4d790b6";
const CLASS_MAPPING_VERSION =
  "rock-island-assessors-instructions-2021-v1";
const CLASS_MAPPING_SOURCE_URL =
  "https://rockislandcountyil.gov/DocumentCenter/View/204";
const ADVISORY_LOCK_KEY = "rock_island_address_class_backfill_v1";

/**
 * Public fingerprint and cardinality contract for the private address package.
 *
 * The package bytes remain outside git; these non-PII values let tests verify
 * the exact production safeguard without reading a sibling repository or a
 * local download.
 */
export const ROCK_ISLAND_ADDRESS_PACKAGE_CONTRACT = {
  packageId: ADDRESS_PACKAGE_ID,
  recordsSha256: ADDRESS_PACKAGE_SHA256,
  expectedRecordCount: EXPECTED_FOUND_BACKFILLS + EXPECTED_NOT_FOUND,
  expectedFoundCount: EXPECTED_FOUND_BACKFILLS,
  expectedNotFoundCount: EXPECTED_NOT_FOUND,
} as const;

type PropertyUsageType =
  | "Residential"
  | "Commercial"
  | "Industrial"
  | "Agricultural"
  | "Conservation"
  | "TimberLand"
  | "Unknown";

type ClassDefinition = {
  readonly officialLabel: string;
  readonly propertyUsageType: PropertyUsageType;
  readonly normalizationBasis: string;
};

type ClassMapping = {
  readonly rawCode: string | null;
  readonly officialLabel: string | null;
  readonly propertyUsageType: PropertyUsageType;
  readonly dictionaryStatus:
    | "authoritative_definition"
    | "unmapped_source_code"
    | "missing_source_code";
  readonly mappingVersion: string;
  readonly sourceUrl: string;
  readonly normalizationBasis: string;
};

type BackfillOptions = {
  readonly addressPackagePath: string;
  readonly apply: boolean;
  readonly manifestPath: string;
  readonly runId: string;
};

type SiteAddress = {
  readonly streetLine: string;
  readonly city: string;
  readonly stateCode: "IL";
  readonly postalCode: string;
  readonly unnormalizedAddress: string;
};

type AddressRecord = {
  readonly folio: string;
  readonly status: "found" | "not_found";
  readonly siteAddress: SiteAddress | null;
  readonly reason: string | null;
  readonly conflicting: false;
  readonly provenance: JsonObject;
};

type AddressPackage = {
  readonly packageId: string;
  readonly recordsByFolio: Readonly<Record<string, AddressRecord>>;
  readonly recordsSha256: string;
};

type PropertyRow = {
  readonly property_id: string;
  readonly request_identifier: string;
  readonly property_type: string | null;
  readonly property_usage_type: string | null;
  readonly source_payload: JsonObject;
  readonly source_record_hash: string | null;
};

type AddressRow = {
  readonly address_id: string;
  readonly request_identifier: string;
  readonly source_record_key: string;
  readonly unnormalized_address: string | null;
  readonly source_payload: JsonObject;
  readonly source_record_hash: string | null;
};

type PropertyUpdate = {
  readonly propertyId: string;
  readonly requestIdentifier: string;
  readonly propertyUsageType: PropertyUsageType;
  readonly sourcePayload: JsonObject;
  readonly sourceRecordHash: string;
  readonly classification: ClassMapping;
};

type AddressUpdate = {
  readonly requestIdentifier: string;
  readonly sourceRecordKey: string;
  readonly unnormalizedAddress: string;
  readonly normalizedAddressKey: string;
  readonly normalizedAddressHash: string;
  readonly cityName: string;
  readonly stateCode: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly countyName: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly sourcePayload: JsonObject;
  readonly sourceRecordHash: string;
};

type VerificationCounts = {
  readonly properties: number;
  readonly supportedAddresses: number;
  readonly nullAddresses: number;
  readonly exactFoundAddresses: number;
  readonly exactNotFoundNulls: number;
  readonly addressConflicts: number;
  readonly parcelOrphans: number;
  readonly propertyOrphans: number;
  readonly addressOrphans: number;
  readonly duplicateParcels: number;
  readonly duplicateProperties: number;
  readonly duplicateAddresses: number;
  readonly officialLabels: number;
  readonly nonUnknownUsage: number;
  readonly commercialIndustrial: number;
  readonly unknownUsage: number;
};

type ProtectedCounts = {
  readonly geometryComponents: number;
  readonly geometryRings: number;
  readonly corporateRegistrations: number;
  readonly corporateAddresses: number;
  readonly permits: number;
  readonly permitLinks: number;
  readonly linkedPermits: number;
};

type CountRow = { readonly count: string };
type BooleanRow = { readonly acquired: boolean };

/**
 * County-authored labels paired with conservative Elephant usage values.
 *
 * The labels are copied verbatim from the official county instructions. Usage
 * values are transform decisions; ambiguous categories remain `Unknown`.
 */
export const PROPERTY_CLASS_DEFINITIONS: Readonly<
  Record<string, Readonly<ClassDefinition>>
> = Object.freeze({
  "0010": Object.freeze({
    officialLabel: "Rural Non-Farmland with Improvements",
    propertyUsageType: "Residential",
    normalizationBasis:
      "County instructions require a residential home-site value when this class is improved.",
  }),
  "0011": Object.freeze({
    officialLabel: "Farm Land with Improvements",
    propertyUsageType: "Agricultural",
    normalizationBasis: "The county definition explicitly identifies farm land.",
  }),
  "0020": Object.freeze({
    officialLabel: "Rural Non-Farmland Vacant",
    propertyUsageType: "Unknown",
    normalizationBasis:
      "The county says this idle-land class is not necessarily residential, commercial, industrial, or agricultural.",
  }),
  "0021": Object.freeze({
    officialLabel: "Farm Land Vacant",
    propertyUsageType: "Agricultural",
    normalizationBasis: "The county definition explicitly identifies farm land.",
  }),
  "0028": Object.freeze({
    officialLabel: "Conservation Stewardship",
    propertyUsageType: "Conservation",
    normalizationBasis:
      "The county definition requires an approved conservation management plan.",
  }),
  "0029": Object.freeze({
    officialLabel: "Wooded Acreage Transition",
    propertyUsageType: "TimberLand",
    normalizationBasis:
      "The county definition explicitly identifies qualifying wooded acreage.",
  }),
  "0030": Object.freeze({
    officialLabel: "Residential Vacant Land",
    propertyUsageType: "Residential",
    normalizationBasis:
      "The county definition explicitly identifies residential use.",
  }),
  "0032": Object.freeze({
    officialLabel: "10-30 Residential Vacant Land",
    propertyUsageType: "Residential",
    normalizationBasis:
      "The county definition explicitly identifies residential use.",
  }),
  "0040": Object.freeze({
    officialLabel: "Residential with Improvements",
    propertyUsageType: "Residential",
    normalizationBasis:
      "The county definition explicitly identifies residential use.",
  }),
  "0041": Object.freeze({
    officialLabel: "Residential Model Home",
    propertyUsageType: "Residential",
    normalizationBasis:
      "The county definition explicitly identifies residential use.",
  }),
  "0050": Object.freeze({
    officialLabel: "Commercial Vacant Land",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county definition explicitly identifies commercial use.",
  }),
  "0052": Object.freeze({
    officialLabel: "10-30 Commercial Vacant Land",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county definition explicitly identifies commercial use.",
  }),
  "0060": Object.freeze({
    officialLabel: "Commercial with Improvements",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county definition explicitly identifies commercial use.",
  }),
  "0062": Object.freeze({
    officialLabel: "10-30 Commercial Vacant Land",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county definition explicitly identifies commercial use.",
  }),
  "0065": Object.freeze({
    officialLabel: "Commercial with Farm Land",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county's primary class is commercial even though farm land is also present.",
  }),
  "0070": Object.freeze({
    officialLabel: "Commercial Office with Improvements",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county definition explicitly identifies commercial use.",
  }),
  "0072": Object.freeze({
    officialLabel: "10-30 Commercial Vacant Land Office",
    propertyUsageType: "Commercial",
    normalizationBasis:
      "The county definition explicitly identifies commercial use.",
  }),
  "0080": Object.freeze({
    officialLabel: "Industrial with Improvements",
    propertyUsageType: "Industrial",
    normalizationBasis:
      "The county definition explicitly identifies industrial use.",
  }),
  "0081": Object.freeze({
    officialLabel: "Industrial Vacant Land",
    propertyUsageType: "Industrial",
    normalizationBasis:
      "The county definition explicitly identifies industrial use.",
  }),
  "0082": Object.freeze({
    officialLabel: "10-30 Industrial Vacant Land",
    propertyUsageType: "Industrial",
    normalizationBasis:
      "The county definition explicitly identifies industrial use.",
  }),
  "0085": Object.freeze({
    officialLabel: "Industrial with Farm Land",
    propertyUsageType: "Industrial",
    normalizationBasis:
      "The county's primary class is industrial even though farm land is also present.",
  }),
  "0090": Object.freeze({
    officialLabel: "Tax Exempt",
    propertyUsageType: "Unknown",
    normalizationBasis:
      "Tax-exempt status does not distinguish government, religious, educational, charitable, or other use.",
  }),
});

/**
 * Map an exact source class code to official county provenance and a
 * conservative Elephant usage value.
 *
 * @param value - Raw ArcGIS class value.
 * @returns Versioned mapping that never infers unpublished codes.
 */
export function mapRockIslandPropertyClass(value: unknown): ClassMapping {
  const rawCode = readText(value);
  if (rawCode === null) {
    return {
      rawCode: null,
      officialLabel: null,
      propertyUsageType: "Unknown",
      dictionaryStatus: "missing_source_code",
      mappingVersion: CLASS_MAPPING_VERSION,
      sourceUrl: CLASS_MAPPING_SOURCE_URL,
      normalizationBasis: "The source parcel has no assessment class code.",
    };
  }
  const definition = PROPERTY_CLASS_DEFINITIONS[rawCode];
  if (definition === undefined) {
    return {
      rawCode,
      officialLabel: null,
      propertyUsageType: "Unknown",
      dictionaryStatus: "unmapped_source_code",
      mappingVersion: CLASS_MAPPING_VERSION,
      sourceUrl: CLASS_MAPPING_SOURCE_URL,
      normalizationBasis:
        "The source code is absent from the county's published complete list and is not inferred.",
    };
  }
  return {
    rawCode,
    officialLabel: definition.officialLabel,
    propertyUsageType: definition.propertyUsageType,
    dictionaryStatus: "authoritative_definition",
    mappingVersion: CLASS_MAPPING_VERSION,
    sourceUrl: CLASS_MAPPING_SOURCE_URL,
    normalizationBasis: definition.normalizationBasis,
  };
}

/**
 * Read the raw ArcGIS class from retained source evidence.
 *
 * Raw feature evidence wins over any previously added mapping object. The
 * mapping object is only an idempotent fallback after the source has already
 * been verified and backfilled.
 *
 * @param payload - Existing property source payload.
 * @returns Exact source code with leading zeroes retained.
 */
export function readRockIslandRawClass(payload: unknown): string | null {
  const candidates = collectPayloadCandidates(payload);
  for (const candidate of candidates) {
    const response = asObject(candidate.response);
    const features = response === null ? null : response.features;
    if (!Array.isArray(features)) continue;
    for (const feature of features) {
      const properties = asObject(asObject(feature)?.properties);
      const rawCode = readText(properties?.class);
      if (rawCode !== null) return rawCode;
    }
  }
  for (const candidate of candidates) {
    const classification = asObject(candidate.classification);
    const rawCode = readText(classification?.rawCode);
    if (rawCode !== null) return rawCode;
  }
  return null;
}

/**
 * Parse the fail-closed CLI contract.
 *
 * @param argv - Arguments after the script filename.
 * @returns Explicit dry-run/apply mode and durable evidence paths.
 */
export function parseAddressClassBackfillOptions(
  argv: readonly string[],
): BackfillOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      token?.startsWith("--") !== true ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid address/class backfill option: ${token ?? ""}`);
    }
    values.set(token.slice(2), value);
    index += 1;
  }
  for (const key of values.keys()) {
    if (
      key !== "address-package" &&
      key !== "manifest" &&
      key !== "run-id"
    ) {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  const addressPackagePath = values.get("address-package");
  const manifestPath = values.get("manifest");
  const runId = values.get("run-id");
  if (addressPackagePath === undefined || addressPackagePath.length === 0) {
    throw new Error("--address-package is required");
  }
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("--manifest is required");
  }
  if (
    runId === undefined ||
    !/^[a-z][a-z0-9_]{0,31}$/u.test(runId)
  ) {
    throw new Error(
      "--run-id must contain 1-32 lowercase letters, digits, or underscores and start with a letter",
    );
  }
  return {
    addressPackagePath: resolve(addressPackagePath),
    apply,
    manifestPath: resolve(manifestPath),
    runId,
  };
}

/**
 * Validate the immutable private address package and return typed records.
 *
 * @param value - Parsed package JSON.
 * @returns Exact 25-folio package.
 */
export function parseAddressPackage(value: unknown): AddressPackage {
  const root = asObject(value);
  if (
    root === null ||
    root.packageId !== ADDRESS_PACKAGE_ID ||
    typeof root.recordsSha256 !== "string"
  ) {
    throw new Error("Unexpected Rock Island address package identity");
  }
  const recordsObject = asObject(root.recordsByFolio);
  if (recordsObject === null) {
    throw new Error("Address package recordsByFolio is missing");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(recordsObject))
    .digest("hex");
  if (
    digest !== ADDRESS_PACKAGE_SHA256 ||
    root.recordsSha256 !== ADDRESS_PACKAGE_SHA256
  ) {
    throw new Error("Address package SHA-256 mismatch");
  }
  const recordsByFolio: Record<string, AddressRecord> = {};
  for (const [folio, rawRecord] of Object.entries(recordsObject)) {
    const record = parseAddressRecord(folio, rawRecord);
    recordsByFolio[folio] = record;
  }
  const records = Object.values(recordsByFolio);
  if (
    records.length !== 25 ||
    records.filter((record) => record.status === "found").length !==
      EXPECTED_FOUND_BACKFILLS ||
    records.filter((record) => record.status === "not_found").length !==
      EXPECTED_NOT_FOUND
  ) {
    throw new Error("Address package scope/count proof failed");
  }
  return {
    packageId: root.packageId,
    recordsByFolio,
    recordsSha256: root.recordsSha256,
  };
}

/**
 * Generate a transactional rollback that restores the exact checkpointed rows.
 *
 * @param checkpointSchema - Validated checkpoint schema.
 * @returns Source-scoped rollback SQL with no cascade or truncate.
 */
export function buildAddressClassRollbackSql(
  checkpointSchema: string,
): string {
  const schema = quoteIdentifier(checkpointSchema);
  return [
    "BEGIN;",
    "UPDATE public.addresses target",
    "   SET request_identifier = before.request_identifier,",
    "       street_number = before.street_number,",
    "       street_pre_directional_text = before.street_pre_directional_text,",
    "       street_name = before.street_name,",
    "       street_suffix_type = before.street_suffix_type,",
    "       street_post_directional_text = before.street_post_directional_text,",
    "       unit_identifier = before.unit_identifier,",
    "       city_name = before.city_name,",
    "       municipality_name = before.municipality_name,",
    "       county_name = before.county_name,",
    "       state_code = before.state_code,",
    "       postal_code = before.postal_code,",
    "       plus_four_postal_code = before.plus_four_postal_code,",
    "       country_code = before.country_code,",
    "       latitude = before.latitude,",
    "       longitude = before.longitude,",
    "       unnormalized_address = before.unnormalized_address,",
    "       normalized_address_key = before.normalized_address_key,",
    "       normalized_address_hash = before.normalized_address_hash,",
    "       source_payload = before.source_payload,",
    "       source_record_hash = before.source_record_hash,",
    "       updated_at = before.updated_at",
    `  FROM ${schema}.addresses_before before`,
    " WHERE target.address_id = before.address_id;",
    "UPDATE public.properties target",
    "   SET address_id = before.address_id,",
    "       property_type = before.property_type,",
    "       property_usage_type = before.property_usage_type,",
    "       source_payload = before.source_payload,",
    "       source_record_hash = before.source_record_hash,",
    "       updated_at = before.updated_at",
    `  FROM ${schema}.properties_before before`,
    " WHERE target.property_id = before.property_id;",
    "DELETE FROM public.addresses target",
    ` USING ${schema}.target_folios scope`,
    ` WHERE target.source_system = '${SOURCE_SYSTEM}'`,
    "   AND target.request_identifier = scope.request_identifier",
    `   AND NOT EXISTS (
         SELECT 1
           FROM ${schema}.addresses_before before
          WHERE before.address_id = target.address_id
       );`,
    "COMMIT;",
    "",
  ].join("\n");
}

/**
 * Run a dry-run or exact source-scoped apply with checkpoint and reconciliation.
 *
 * @param options - Validated paths, run identifier, and explicit mode.
 * @returns Aggregate-only verification manifest.
 */
export async function backfillRockIslandAddressClass(
  options: BackfillOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const addressPackage = parseAddressPackage(
    JSON.parse(await readFile(options.addressPackagePath, "utf8")) as unknown,
  );
  const targetFolios = Object.keys(addressPackage.recordsByFolio).sort();
  const checkpointSchema = `ri_address_class_${options.runId}`;
  const rollbackPath = `${options.manifestPath}.rollback.sql`;
  const pool = new Pool({
    application_name: "rock-island-address-class-backfill",
    connectionString: databaseUrl,
    max: 2,
  });
  let lockAcquired = false;
  try {
    const lock = await pool.query<BooleanRow>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [ADVISORY_LOCK_KEY],
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new Error("Another Rock Island address/class backfill holds the lock");
    }

    const protectedBefore = await readProtectedCounts(pool);
    const propertyRows = await readProperties(pool);
    const addressRows = await readTargetAddresses(pool, targetFolios);
    const propertyUpdates = buildPropertyUpdates(propertyRows);
    const addressUpdates = buildAddressUpdates(
      addressRows,
      addressPackage,
    );
    assertPlannedClassCounts(propertyUpdates);
    assertAddressScope(addressRows, addressPackage);
    const before = await readVerificationCounts(pool, addressPackage);

    let changedAddresses = 0;
    let changedProperties = 0;
    if (options.apply) {
      await createCheckpoint(
        pool,
        checkpointSchema,
        targetFolios,
        protectedBefore,
      );
      changedAddresses = await applyAddressUpdates(pool, addressUpdates);
      changedProperties = await applyPropertyUpdates(pool, propertyUpdates);
      await linkTargetProperties(pool, targetFolios);
    }

    const after = await readVerificationCounts(pool, addressPackage);
    const protectedAfter = await readProtectedCounts(pool);
    const protectedCountsUnchanged =
      JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
    const verified = options.apply
      ? after.properties === EXPECTED_PROPERTIES &&
        after.supportedAddresses === EXPECTED_SUPPORTED_ADDRESSES &&
        after.nullAddresses === EXPECTED_NULL_ADDRESSES &&
        after.exactFoundAddresses === EXPECTED_FOUND_BACKFILLS &&
        after.exactNotFoundNulls === EXPECTED_NOT_FOUND &&
        after.addressConflicts === 0 &&
        after.parcelOrphans === 0 &&
        after.propertyOrphans === 0 &&
        after.addressOrphans === 0 &&
        after.duplicateParcels === 0 &&
        after.duplicateProperties === 0 &&
        after.duplicateAddresses === 0 &&
        after.officialLabels === EXPECTED_OFFICIAL_LABELS &&
        after.nonUnknownUsage === EXPECTED_NON_UNKNOWN_USAGE &&
        after.commercialIndustrial === EXPECTED_COMMERCIAL_INDUSTRIAL &&
        after.unknownUsage === EXPECTED_UNKNOWN_USAGE &&
        protectedCountsUnchanged
      : before.properties === EXPECTED_PROPERTIES &&
        propertyUpdates.length === EXPECTED_PROPERTIES &&
        addressUpdates.length === EXPECTED_FOUND_BACKFILLS &&
        protectedCountsUnchanged;

    const manifest = {
      schemaVersion: "rock-island-address-class-backfill-v1",
      mode: options.apply ? "apply" : "dry-run",
      status: verified ? "verified" : "blocked",
      sourceSystem: SOURCE_SYSTEM,
      addressPackage: {
        packageId: addressPackage.packageId,
        recordsSha256: addressPackage.recordsSha256,
        found: EXPECTED_FOUND_BACKFILLS,
        notFound: EXPECTED_NOT_FOUND,
      },
      classMapping: {
        version: CLASS_MAPPING_VERSION,
        sourceUrl: CLASS_MAPPING_SOURCE_URL,
        definitions: Object.keys(PROPERTY_CLASS_DEFINITIONS).length,
      },
      before,
      after,
      changedRows: {
        addresses: changedAddresses,
        properties: changedProperties,
      },
      protectedCountsBefore: protectedBefore,
      protectedCountsAfter: protectedAfter,
      protectedCountsUnchanged,
      checkpoint: options.apply
        ? {
            schema: checkpointSchema,
            addressesTable: `${checkpointSchema}.addresses_before`,
            propertiesTable: `${checkpointSchema}.properties_before`,
            rollbackPath,
          }
        : null,
      privacy: {
        aggregateOnly: true,
        ownerMailingTaxBillDataUsed: false,
        siteAddressSource: "official_county_e911",
      },
      generatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(options.manifestPath), { recursive: true });
    await writeFile(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (options.apply) {
      await writeFile(
        rollbackPath,
        buildAddressClassRollbackSql(checkpointSchema),
        { mode: 0o600 },
      );
    }
    if (!verified) {
      throw new Error("Rock Island address/class reconciliation failed");
    }
    return manifest;
  } finally {
    if (lockAcquired) {
      await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [
        ADVISORY_LOCK_KEY,
      ]);
    }
    await pool.end();
  }
}

function buildPropertyUpdates(
  rows: readonly PropertyRow[],
): readonly PropertyUpdate[] {
  if (rows.length !== EXPECTED_PROPERTIES) {
    throw new Error(
      `Expected ${EXPECTED_PROPERTIES} Rock Island properties, found ${rows.length}`,
    );
  }
  const folios = new Set<string>();
  return rows.map((row) => {
    if (folios.has(row.request_identifier)) {
      throw new Error(`Duplicate property folio ${row.request_identifier}`);
    }
    folios.add(row.request_identifier);
    const classification = mapRockIslandPropertyClass(
      readRockIslandRawClass(row.source_payload),
    );
    const currentSidecar = asObject(row.source_payload.source_payload) ?? {};
    const sourcePayload: JsonObject = {
      ...row.source_payload,
      property_usage_type: classification.propertyUsageType,
      source_payload: {
        ...currentSidecar,
        classification,
      },
    };
    return {
      propertyId: row.property_id,
      requestIdentifier: row.request_identifier,
      propertyUsageType: classification.propertyUsageType,
      sourcePayload,
      sourceRecordHash: hashJson(sourcePayload),
      classification,
    };
  });
}

function buildAddressUpdates(
  rows: readonly AddressRow[],
  addressPackage: AddressPackage,
): readonly AddressUpdate[] {
  const rowsByFolio = new Map(
    rows.map((row) => [row.request_identifier, row] as const),
  );
  return Object.values(addressPackage.recordsByFolio)
    .filter(
      (record): record is AddressRecord & { readonly siteAddress: SiteAddress } =>
        record.status === "found" && record.siteAddress !== null,
    )
    .sort((left, right) => left.folio.localeCompare(right.folio))
    .map((record) => {
      const row = rowsByFolio.get(record.folio);
      const expectedSourceRecordKey = `${SOURCE_SYSTEM}:${record.folio}:address:site`;
      if (
        row !== undefined &&
        row.source_record_key !== expectedSourceRecordKey
      ) {
        throw new Error(`Conflicting source key for folio ${record.folio}`);
      }
      const currentAddress = readText(row?.unnormalized_address);
      if (
        currentAddress !== null &&
        currentAddress !== record.siteAddress.unnormalizedAddress
      ) {
        throw new Error(`Conflicting site address for folio ${record.folio}`);
      }
      const e911 = asObject(record.provenance.e911AddressPoint);
      const geometry = asObject(e911?.geometry);
      const latitude = readFiniteNumber(geometry?.latitude);
      const longitude = readFiniteNumber(geometry?.longitude);
      if (latitude === null || longitude === null) {
        throw new Error(`Missing E911 point for folio ${record.folio}`);
      }
      const normalizedAddressKey = buildNormalizedAddressKey(
        record.siteAddress.unnormalizedAddress,
      );
      const normalizedAddressHash = hashNormalizedAddressKey(
        normalizedAddressKey,
      );
      if (
        normalizedAddressKey === null ||
        normalizedAddressHash === null
      ) {
        throw new Error(`Address normalization failed for ${record.folio}`);
      }
      const sourcePayload: JsonObject = {
        ...(row?.source_payload ?? {}),
        request_identifier: record.folio,
        unnormalized_address: record.siteAddress.unnormalizedAddress,
        city_name: record.siteAddress.city,
        state_code: record.siteAddress.stateCode,
        postal_code: record.siteAddress.postalCode,
        country_code: "US",
        latitude,
        longitude,
        supplemental_site_address: {
          packageId: addressPackage.packageId,
          recordsSha256: addressPackage.recordsSha256,
          sourceRole: "site",
          ownerMailingTaxBillDataUsed: false,
          provenance: record.provenance,
        },
      };
      return {
        requestIdentifier: record.folio,
        sourceRecordKey: expectedSourceRecordKey,
        unnormalizedAddress: record.siteAddress.unnormalizedAddress,
        normalizedAddressKey,
        normalizedAddressHash,
        cityName: record.siteAddress.city,
        stateCode: record.siteAddress.stateCode,
        postalCode: record.siteAddress.postalCode,
        countryCode: "US",
        countyName: "Rock Island",
        latitude,
        longitude,
        sourcePayload,
        sourceRecordHash: hashJson(sourcePayload),
      };
    });
}

function assertPlannedClassCounts(
  updates: readonly PropertyUpdate[],
): void {
  const officialLabels = updates.filter(
    (update) => update.classification.officialLabel !== null,
  ).length;
  const nonUnknownUsage = updates.filter(
    (update) => update.propertyUsageType !== "Unknown",
  ).length;
  const commercialIndustrial = updates.filter(
    (update) =>
      update.propertyUsageType === "Commercial" ||
      update.propertyUsageType === "Industrial",
  ).length;
  const unknownUsage = updates.filter(
    (update) => update.propertyUsageType === "Unknown",
  ).length;
  if (
    officialLabels !== EXPECTED_OFFICIAL_LABELS ||
    nonUnknownUsage !== EXPECTED_NON_UNKNOWN_USAGE ||
    commercialIndustrial !== EXPECTED_COMMERCIAL_INDUSTRIAL ||
    unknownUsage !== EXPECTED_UNKNOWN_USAGE
  ) {
    throw new Error(
      `Class proof failed: official=${officialLabels} nonUnknown=${nonUnknownUsage} commercialIndustrial=${commercialIndustrial} unknown=${unknownUsage}`,
    );
  }
}

function assertAddressScope(
  rows: readonly AddressRow[],
  addressPackage: AddressPackage,
): void {
  if (rows.length > 25) {
    throw new Error(`Expected at most 25 exact address rows, found ${rows.length}`);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.request_identifier)) {
      throw new Error(`Duplicate address folio ${row.request_identifier}`);
    }
    seen.add(row.request_identifier);
    const record = addressPackage.recordsByFolio[row.request_identifier];
    if (record === undefined) {
      throw new Error(`Unexpected address folio ${row.request_identifier}`);
    }
    const currentAddress = readText(row.unnormalized_address);
    if (record.status === "not_found" && currentAddress !== null) {
      throw new Error(
        `Not-found folio ${row.request_identifier} has a non-null address`,
      );
    }
    if (
      record.status === "found" &&
      currentAddress !== null &&
      currentAddress !== record.siteAddress?.unnormalizedAddress
    ) {
      throw new Error(
        `Found folio ${row.request_identifier} has conflicting source address`,
      );
    }
  }
}

async function readProperties(pool: Pool): Promise<readonly PropertyRow[]> {
  const result = await pool.query<PropertyRow>(
    `SELECT property_id::text,
            request_identifier,
            property_type,
            property_usage_type,
            source_payload,
            source_record_hash
       FROM public.properties
      WHERE source_system = $1
      ORDER BY request_identifier`,
    [SOURCE_SYSTEM],
  );
  return result.rows;
}

async function readTargetAddresses(
  pool: Pool,
  targetFolios: readonly string[],
): Promise<readonly AddressRow[]> {
  const result = await pool.query<AddressRow>(
    `SELECT address_id::text,
            request_identifier,
            source_record_key,
            unnormalized_address,
            source_payload,
            source_record_hash
       FROM public.addresses
      WHERE source_system = $1
        AND request_identifier = ANY($2::text[])
      ORDER BY request_identifier`,
    [SOURCE_SYSTEM, targetFolios],
  );
  return result.rows;
}

async function createCheckpoint(
  pool: Pool,
  checkpointSchema: string,
  targetFolios: readonly string[],
  protectedCounts: ProtectedCounts,
): Promise<void> {
  const schema = quoteIdentifier(checkpointSchema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.baseline_counts (
         captured_at timestamptz NOT NULL DEFAULT now(),
         counts jsonb NOT NULL
       )`,
    );
    const existingCheckpoint = await client.query<CountRow>(
      `SELECT count(*)::text AS count FROM ${schema}.baseline_counts`,
    );
    if (Number(existingCheckpoint.rows[0]?.count ?? "0") > 0) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.addresses_before
       (LIKE public.addresses INCLUDING ALL)`,
    );
    await client.query(
      `INSERT INTO ${schema}.addresses_before
       SELECT *
         FROM public.addresses
        WHERE source_system = $1
          AND request_identifier = ANY($2::text[])
       ON CONFLICT (source_system, source_record_key) DO NOTHING`,
      [SOURCE_SYSTEM, targetFolios],
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.properties_before
       (LIKE public.properties INCLUDING ALL)`,
    );
    await client.query(
      `INSERT INTO ${schema}.properties_before
       SELECT *
         FROM public.properties
        WHERE source_system = $1
       ON CONFLICT (source_system, source_record_key) DO NOTHING`,
      [SOURCE_SYSTEM],
    );
    await client.query(
      `INSERT INTO ${schema}.baseline_counts (counts) VALUES ($1::jsonb)`,
      [JSON.stringify(protectedCounts)],
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.target_folios (
         request_identifier text PRIMARY KEY
       )`,
    );
    await client.query(
      `INSERT INTO ${schema}.target_folios (request_identifier)
       SELECT unnest($1::text[])
       ON CONFLICT (request_identifier) DO NOTHING`,
      [targetFolios],
    );
    await client.query("COMMIT");
  } catch (caught: unknown) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

async function applyAddressUpdates(
  pool: Pool,
  updates: readonly AddressUpdate[],
): Promise<number> {
  let changedRows = 0;
  for (const batch of chunks(updates, 500)) {
    const result = await pool.query(
      `WITH updates AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS row(
             "requestIdentifier" text,
             "sourceRecordKey" text,
             "unnormalizedAddress" text,
             "normalizedAddressKey" text,
             "normalizedAddressHash" text,
             "cityName" text,
             "stateCode" text,
             "postalCode" text,
             "countryCode" text,
             "countyName" text,
             latitude numeric,
             longitude numeric,
             "sourcePayload" jsonb,
             "sourceRecordHash" text
           )
       )
       INSERT INTO public.addresses (
         request_identifier,
         unnormalized_address,
         normalized_address_key,
         normalized_address_hash,
         city_name,
         state_code,
         postal_code,
         country_code,
         county_name,
         latitude,
         longitude,
         source_payload,
         source_system,
         source_record_key,
         source_record_hash
       )
       SELECT
         updates."requestIdentifier",
         updates."unnormalizedAddress",
         updates."normalizedAddressKey",
         updates."normalizedAddressHash",
         updates."cityName",
         updates."stateCode",
         updates."postalCode",
         updates."countryCode",
         updates."countyName",
         updates.latitude,
         updates.longitude,
         updates."sourcePayload",
         $2,
         updates."sourceRecordKey",
         updates."sourceRecordHash"
       FROM updates
       ON CONFLICT (source_system, source_record_key) DO UPDATE
         SET unnormalized_address = EXCLUDED.unnormalized_address,
             normalized_address_key = EXCLUDED.normalized_address_key,
             normalized_address_hash = EXCLUDED.normalized_address_hash,
             city_name = EXCLUDED.city_name,
             state_code = EXCLUDED.state_code,
             postal_code = EXCLUDED.postal_code,
             country_code = EXCLUDED.country_code,
             county_name = EXCLUDED.county_name,
             latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude,
             source_payload = EXCLUDED.source_payload,
             source_record_hash = EXCLUDED.source_record_hash,
             updated_at = now()
       WHERE (
         addresses.request_identifier,
         addresses.unnormalized_address,
         addresses.normalized_address_key,
         addresses.normalized_address_hash,
         addresses.city_name,
         addresses.state_code,
         addresses.postal_code,
         addresses.country_code,
         addresses.county_name,
         addresses.latitude,
         addresses.longitude,
         addresses.source_payload,
         addresses.source_record_hash
       ) IS DISTINCT FROM (
         EXCLUDED.request_identifier,
         EXCLUDED.unnormalized_address,
         EXCLUDED.normalized_address_key,
         EXCLUDED.normalized_address_hash,
         EXCLUDED.city_name,
         EXCLUDED.state_code,
         EXCLUDED.postal_code,
         EXCLUDED.country_code,
         EXCLUDED.county_name,
         EXCLUDED.latitude,
         EXCLUDED.longitude,
         EXCLUDED.source_payload,
         EXCLUDED.source_record_hash
       )`,
      [JSON.stringify(batch), SOURCE_SYSTEM],
    );
    changedRows += result.rowCount ?? 0;
  }
  return changedRows;
}

async function applyPropertyUpdates(
  pool: Pool,
  updates: readonly PropertyUpdate[],
): Promise<number> {
  let changedRows = 0;
  for (const batch of chunks(updates, 1_000)) {
    const rows = batch.map((update) => ({
      propertyId: update.propertyId,
      requestIdentifier: update.requestIdentifier,
      propertyUsageType: update.propertyUsageType,
      sourcePayload: update.sourcePayload,
      sourceRecordHash: update.sourceRecordHash,
    }));
    const result = await pool.query(
      `WITH updates AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS row(
             "propertyId" uuid,
             "requestIdentifier" text,
             "propertyUsageType" text,
             "sourcePayload" jsonb,
             "sourceRecordHash" text
           )
       )
       UPDATE public.properties target
          SET property_usage_type = updates."propertyUsageType",
              source_payload = updates."sourcePayload",
              source_record_hash = updates."sourceRecordHash",
              updated_at = now()
         FROM updates
        WHERE target.property_id = updates."propertyId"
          AND target.source_system = $2
          AND target.request_identifier = updates."requestIdentifier"
          AND (
            target.property_usage_type,
            target.source_payload,
            target.source_record_hash
          ) IS DISTINCT FROM (
            updates."propertyUsageType",
            updates."sourcePayload",
            updates."sourceRecordHash"
          )`,
      [JSON.stringify(rows), SOURCE_SYSTEM],
    );
    changedRows += result.rowCount ?? 0;
  }
  return changedRows;
}

async function linkTargetProperties(
  pool: Pool,
  targetFolios: readonly string[],
): Promise<void> {
  await pool.query(
    `UPDATE public.properties property
        SET address_id = address.address_id,
            updated_at = CASE
              WHEN property.address_id IS DISTINCT FROM address.address_id
                THEN now()
              ELSE property.updated_at
            END
       FROM public.addresses address
      WHERE property.source_system = $1
        AND address.source_system = $1
        AND property.request_identifier = address.request_identifier
        AND property.request_identifier = ANY($2::text[])
        AND property.address_id IS DISTINCT FROM address.address_id`,
    [SOURCE_SYSTEM, targetFolios],
  );
}

async function readVerificationCounts(
  pool: Pool,
  addressPackage: AddressPackage,
): Promise<VerificationCounts> {
  const foundRecords = Object.values(addressPackage.recordsByFolio).filter(
    (record): record is AddressRecord & { readonly siteAddress: SiteAddress } =>
      record.status === "found" && record.siteAddress !== null,
  );
  const foundJson = foundRecords.map((record) => ({
    folio: record.folio,
    address: record.siteAddress.unnormalizedAddress,
  }));
  const notFoundFolios = Object.values(addressPackage.recordsByFolio)
    .filter((record) => record.status === "not_found")
    .map((record) => record.folio);
  const result = await pool.query<
    Record<keyof VerificationCounts, string>
  >(
    `WITH expected_found AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS row(folio text, address text)
     )
     SELECT
       (SELECT count(*) FROM properties WHERE source_system = $1)::text AS "properties",
       (SELECT count(*)
          FROM properties property
          JOIN addresses address
            ON address.address_id = property.address_id
           AND address.source_system = $1
         WHERE property.source_system = $1
           AND nullif(btrim(address.unnormalized_address), '') IS NOT NULL)::text AS "supportedAddresses",
       (SELECT count(*)
          FROM properties property
          LEFT JOIN addresses address
            ON address.address_id = property.address_id
           AND address.source_system = $1
         WHERE property.source_system = $1
           AND nullif(btrim(address.unnormalized_address), '') IS NULL)::text AS "nullAddresses",
       (SELECT count(*)
          FROM expected_found expected
          JOIN properties property
            ON property.source_system = $1
           AND property.request_identifier = expected.folio
          JOIN addresses address
            ON address.address_id = property.address_id
           AND address.unnormalized_address = expected.address)::text AS "exactFoundAddresses",
       (SELECT count(*)
          FROM properties property
          LEFT JOIN addresses address
            ON address.address_id = property.address_id
           AND address.source_system = $1
         WHERE property.source_system = $1
           AND property.request_identifier = ANY($3::text[])
           AND nullif(btrim(address.unnormalized_address), '') IS NULL)::text AS "exactNotFoundNulls",
       (SELECT count(*)
          FROM expected_found expected
          JOIN addresses address
            ON address.source_system = $1
           AND address.request_identifier = expected.folio
         WHERE nullif(btrim(address.unnormalized_address), '') IS NOT NULL
           AND address.unnormalized_address <> expected.address)::text AS "addressConflicts",
       (SELECT count(*)
          FROM parcels parcel
          LEFT JOIN properties property
            ON property.parcel_id = parcel.parcel_id
           AND property.source_system = $1
         WHERE parcel.source_system = $1
           AND property.property_id IS NULL)::text AS "parcelOrphans",
       (SELECT count(*)
          FROM properties
         WHERE source_system = $1
           AND parcel_id IS NULL)::text AS "propertyOrphans",
       (SELECT count(*)
          FROM addresses address
          LEFT JOIN properties property
            ON property.address_id = address.address_id
           AND property.source_system = $1
         WHERE address.source_system = $1
           AND property.property_id IS NULL)::text AS "addressOrphans",
       (SELECT count(*)
          FROM (
            SELECT request_identifier
              FROM parcels
             WHERE source_system = $1
             GROUP BY request_identifier
            HAVING count(*) > 1
          ) duplicate)::text AS "duplicateParcels",
       (SELECT count(*)
          FROM (
            SELECT request_identifier
              FROM properties
             WHERE source_system = $1
             GROUP BY request_identifier
            HAVING count(*) > 1
          ) duplicate)::text AS "duplicateProperties",
       (SELECT count(*)
          FROM (
            SELECT request_identifier
              FROM addresses
             WHERE source_system = $1
             GROUP BY request_identifier
            HAVING count(*) > 1
          ) duplicate)::text AS "duplicateAddresses",
       (SELECT count(*)
          FROM properties
         WHERE source_system = $1
           AND source_payload #>> '{source_payload,classification,officialLabel}' IS NOT NULL)::text AS "officialLabels",
       (SELECT count(*)
          FROM properties
         WHERE source_system = $1
           AND property_usage_type <> 'Unknown')::text AS "nonUnknownUsage",
       (SELECT count(*)
          FROM properties
         WHERE source_system = $1
           AND property_usage_type IN ('Commercial', 'Industrial'))::text AS "commercialIndustrial",
       (SELECT count(*)
          FROM properties
         WHERE source_system = $1
           AND property_usage_type = 'Unknown')::text AS "unknownUsage"`,
    [SOURCE_SYSTEM, JSON.stringify(foundJson), notFoundFolios],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Address/class verification returned no row");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as VerificationCounts;
}

async function readProtectedCounts(pool: Pool): Promise<ProtectedCounts> {
  return {
    geometryComponents: await countExactSource(
      pool,
      "geometries",
      SOURCE_SYSTEM,
    ),
    geometryRings: await countOptionalExactSource(
      pool,
      "geometry_rings",
      SOURCE_SYSTEM,
    ),
    corporateRegistrations: await countExactSource(
      pool,
      "business_registrations",
      "illinois_sos",
    ),
    corporateAddresses: await countExactSource(
      pool,
      "business_registration_addresses",
      "illinois_sos",
    ),
    permits: await countSourcePattern(
      pool,
      "property_improvements",
      "rock_island_%",
    ),
    permitLinks: await countSourcePattern(
      pool,
      "permit_links",
      "rock_island_%",
    ),
    linkedPermits: await countQuery(
      pool,
      `SELECT count(*)::text AS count
         FROM public.property_improvements permit
         JOIN public.properties property
           ON property.property_id = permit.property_id
        WHERE permit.source_system LIKE $1
          AND property.source_system = $2`,
      ["rock_island_%", SOURCE_SYSTEM],
    ),
  };
}

async function countOptionalExactSource(
  pool: Pool,
  table: string,
  sourceSystem: string,
): Promise<number> {
  const exists = await pool.query<{ readonly table_name: string | null }>(
    "SELECT to_regclass($1)::text AS table_name",
    [`public.${table}`],
  );
  if (exists.rows[0]?.table_name === null) return 0;
  return countExactSource(pool, table, sourceSystem);
}

async function countExactSource(
  pool: Pool,
  table: string,
  sourceSystem: string,
): Promise<number> {
  return countQuery(
    pool,
    `SELECT count(*)::text AS count
       FROM public.${quoteIdentifier(table)}
      WHERE source_system = $1`,
    [sourceSystem],
  );
}

async function countSourcePattern(
  pool: Pool,
  table: string,
  sourcePattern: string,
): Promise<number> {
  return countQuery(
    pool,
    `SELECT count(*)::text AS count
       FROM public.${quoteIdentifier(table)}
      WHERE source_system LIKE $1`,
    [sourcePattern],
  );
}

async function countQuery(
  pool: Pool,
  sql: string,
  parameters: readonly unknown[],
): Promise<number> {
  const result = await pool.query<CountRow>(sql, [...parameters]);
  return Number(result.rows[0]?.count ?? "0");
}

function parseAddressRecord(folio: string, value: unknown): AddressRecord {
  const record = asObject(value);
  if (
    record === null ||
    !/^\d{10}$/u.test(folio) ||
    record.folio !== folio ||
    (record.status !== "found" && record.status !== "not_found") ||
    record.conflicting !== false
  ) {
    throw new Error(`Invalid address record ${folio}`);
  }
  const provenance = asObject(record.provenance);
  if (
    provenance === null ||
    provenance.addressRole !== "site" ||
    !Array.isArray(provenance.prohibitedSourcesExcluded) ||
    !["owner", "mailing", "tax_bill"].every((source) =>
      Array.isArray(provenance.prohibitedSourcesExcluded) &&
      provenance.prohibitedSourcesExcluded.includes(source),
    )
  ) {
    throw new Error(`Address record ${folio} lacks source exclusions`);
  }
  const siteAddress =
    record.siteAddress === null ? null : parseSiteAddress(record.siteAddress);
  if (
    (record.status === "found" && siteAddress === null) ||
    (record.status === "not_found" && siteAddress !== null)
  ) {
    throw new Error(`Address record ${folio} has inconsistent status`);
  }
  return {
    folio,
    status: record.status,
    siteAddress,
    reason: typeof record.reason === "string" ? record.reason : null,
    conflicting: false,
    provenance,
  };
}

function parseSiteAddress(value: unknown): SiteAddress {
  const address = asObject(value);
  if (
    address === null ||
    typeof address.streetLine !== "string" ||
    typeof address.city !== "string" ||
    address.stateCode !== "IL" ||
    typeof address.postalCode !== "string" ||
    !/^\d{5}$/u.test(address.postalCode) ||
    typeof address.unnormalizedAddress !== "string"
  ) {
    throw new Error("Invalid staged E911 site address");
  }
  return {
    streetLine: address.streetLine,
    city: address.city,
    stateCode: "IL",
    postalCode: address.postalCode,
    unnormalizedAddress: address.unnormalizedAddress,
  };
}

function collectPayloadCandidates(value: unknown): readonly JsonObject[] {
  const root = asObject(value);
  if (root === null) return [];
  const nested = asObject(root.source_payload);
  return nested === null ? [root] : [root, nested];
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function readText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function chunks<T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const options = parseAddressClassBackfillOptions(process.argv.slice(2));
  backfillRockIslandAddressClass(options)
    .then((manifest) => {
      console.log(JSON.stringify(manifest));
    })
    .catch((caught: unknown) => {
      const message =
        caught instanceof Error ? caught.message : String(caught);
      console.error(JSON.stringify({ event: "backfill_failed", message }));
      process.exitCode = 1;
    });
}
