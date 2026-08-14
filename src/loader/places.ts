import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  hashNormalizedAddressKey,
  isJsonObject,
  normalizeName,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
} from "./normalizers.js";
import type { JsonObject, LogicalTableName, PreparedRow, PreparedRowBundle } from "./types.js";

const PLACES_SOURCE_SYSTEM = "overture_places" as const;

const APPROVED_PLACE_DATASET_BY_LOWER: ReadonlyMap<string, string> = new Map(
  [
    "meta",
    "microsoft",
    "foursquare",
    "pinmeto",
    "krick",
    "rendersEO",
    "dac",
    "brightquery",
    "alltheplaces",
    "Overture",
    "Overture-signals",
  ].map((name) => [name.toLowerCase(), name]),
);

export const PLACES_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "business_locations",
  "business_location_categories",
  "business_location_sources",
  "overture_place_extractions",
];

export type PlacesLicenceGateResult = {
  readonly passed: boolean;
  readonly distinctDatasets: readonly string[];
  readonly unknownDatasets: readonly string[];
  readonly osmPresent: boolean;
  readonly message: string;
};

export type PlacesDeactivation = {
  readonly gersId: string;
  readonly reason: "removed" | "moved_out";
};

export type PlacesDeactivationManifest = {
  readonly schemaVersion: "overture-places-deactivation/v1";
  readonly county: string;
  readonly release: string;
  readonly records: readonly PlacesDeactivation[];
};

/**
 * Assert that distinct Overture `sources[].dataset` values are a subset of the
 * approved publishable providers. Comparison is case-insensitive. Twin of
 * oracle-node `assertApprovedPlaceDatasets`. `osm` and any name outside the
 * approved set still fail. `Overture` / `Overture-signals` are allowed
 * (human decision 2026-08-12).
 *
 * @param datasets Distinct dataset names.
 * @returns Pass/fail plus the datasets that caused failure.
 */
export function assertApprovedPlaceDatasets(
  datasets: readonly string[],
): PlacesLicenceGateResult {
  const distinctDatasets = [...new Set(datasets.map((value) => value.trim()).filter(Boolean))].sort();
  const unknownDatasets = distinctDatasets.filter(
    (dataset) => !APPROVED_PLACE_DATASET_BY_LOWER.has(dataset.toLowerCase()),
  );
  const osmPresent = distinctDatasets.some((dataset) => dataset.toLowerCase() === "osm");
  const passed = unknownDatasets.length === 0 && !osmPresent;
  const message = passed
    ? `licence gate passed: ${distinctDatasets.join(", ") || "(no datasets)"}`
    : `licence gate FAILED: unknown dataset(s) ${unknownDatasets.join(", ")}${
        osmPresent ? " (osm present — do not publish)" : ""
      }`;
  return { passed, distinctDatasets, unknownDatasets, osmPresent, message };
}

/**
 * Expand one staged places artifact into place-shaped records.
 *
 * Accepts a single place object, a JSON array, JSONL objects, a summary envelope,
 * or `{ places: [] }`.
 *
 * @param record Parsed JSON value from a places artifact.
 * @returns Place candidate records for {@link mapOverturePlace}.
 */
export function expandOverturePlaceRecords(record: unknown): readonly unknown[] {
  if (Array.isArray(record)) return record;
  if (!isJsonObject(record)) return [record];
  if (record.record_kind === "overture_place" || typeof record.gers_id === "string") {
    return [record];
  }
  if (record.schemaVersion !== undefined && record.clipCount !== undefined) {
    return [];
  }
  const places = record.places;
  if (Array.isArray(places)) return places;
  return [record];
}

/**
 * Map one extracted Overture place JSONL record into query-db rows.
 *
 * Never writes `companies` or `company_id`. Address rows are written so
 * `address_id` can resolve as a soft link. Parcel links are not emitted.
 *
 * @param params Place payload and provenance URI.
 * @returns Prepared rows for addresses, the location, categories, and sources.
 */
export function mapOverturePlace(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "Overture place record is not a JSON object",
          sourcePayload: { value: params.record },
        },
      ],
    };
  }
  const gersId = readString(params.record.gers_id);
  if (gersId === null) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "Overture place record is missing gers_id",
          sourcePayload: params.record,
        },
      ],
    };
  }

  const sourceCandidates = Array.isArray(params.record.sources)
    ? params.record.sources
    : [];
  const sourceDatasets = sourceCandidates.map((source, index) => {
    if (!isJsonObject(source)) {
      throw new Error(`Overture place ${gersId} source ${index} is not an object`);
    }
    const dataset = readString(source.dataset);
    if (dataset === null) {
      throw new Error(`Overture place ${gersId} source ${index} has no dataset`);
    }
    return dataset;
  });
  const licenceGate = assertApprovedPlaceDatasets(sourceDatasets);
  if (!licenceGate.passed) {
    throw new Error(licenceGate.message);
  }

  const locationKey = `overture_places:${gersId}`;
  const addressKey = `${locationKey}:address`;
  const release = readString(params.record.overture_release) ?? "unknown";
  const countyKey = readString(params.record.county_key) ?? "unknown";
  const hierarchy = readStringArray(params.record.taxonomy_hierarchy);
  const address = readPlaceAddress(params.record, addressKey);
  const rows: PreparedRow[] = [
    ...(address === null ? [] : [addressRow(address, params.artifactUri)]),
    locationRow(params.record, locationKey, address, release, params.artifactUri),
    ...categoryRows(params.record, locationKey, hierarchy, params.artifactUri),
    ...sourceRows(params.record, locationKey, params.artifactUri),
  ];
  return { rows, skippedRecords: [] };
}

/**
 * Map an extract `manifest/summary.json` into an `overture_place_extractions` row.
 *
 * @param params Summary JSON and provenance URI.
 * @returns Prepared extraction row, or empty when the summary is not a run record.
 */
export function mapOverturePlaceExtraction(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return { rows: [], skippedRecords: [] };
  }
  const countyKey = readString(params.record.county);
  const release = readString(params.record.overtureRelease);
  if (countyKey === null || release === null) {
    return { rows: [], skippedRecords: [] };
  }
  const sourceRecordKey = `overture_places:extraction:${countyKey}:${release}`;
  const licenceGate = isJsonObject(params.record.licenceGate)
    ? params.record.licenceGate
    : {};
  const datasets = readStringArray(params.record.distinctSourceDatasets);
  const changeCounts = isJsonObject(params.record.changeCounts)
    ? params.record.changeCounts
    : {};
  return {
    rows: [
      {
        tableName: "overture_place_extractions",
        values: compactObject({
          ...buildSourceMetadata({
            sourceSystem: PLACES_SOURCE_SYSTEM,
            sourceRecordKey,
            sourcePayload: params.record,
            sourceArtifactUri: params.artifactUri,
          }),
          county_key: countyKey,
          county_fips: readString(params.record.countyFips),
          overture_release: release,
          previous_release: readString(params.record.previousRelease),
          run_status: "loaded",
          tiger_boundary_source: readString(params.record.boundarySource) ?? "unknown",
          tiger_vintage: readString(params.record.tigerYear) ?? "unknown",
          bbox_count: readNumber(params.record.bboxCount) ?? 0,
          clip_count: readNumber(params.record.clipCount) ?? 0,
          active_change_count: readNumber(params.record.activeChangeCount) ?? 0,
          deactivation_count: readNumber(params.record.deactivationCount) ?? 0,
          added_count: readNumber(changeCounts.added) ?? 0,
          data_changed_count: readNumber(changeCounts.data_changed) ?? 0,
          removed_count: readNumber(changeCounts.removed) ?? 0,
          moved_in_count: readNumber(params.record.movedInCount) ?? 0,
          moved_out_count: readNumber(params.record.movedOutCount) ?? 0,
          distinct_taxonomy_primary: readNumber(params.record.distinctTaxonomyPrimary),
          distinct_source_datasets: datasets,
          operating_status_counts: isJsonObject(params.record.operatingStatusCounts)
            ? params.record.operatingStatusCounts
            : {},
          confidence_distribution: isJsonObject(params.record.confidenceDistribution)
            ? params.record.confidenceDistribution
            : {},
          taxonomy_drift: isJsonObject(params.record.taxonomyDrift)
            ? params.record.taxonomyDrift
            : {},
          duration_ms: readNumber(params.record.durationMs),
          licence_gate_passed: readBoolean(licenceGate.passed) ?? false,
          extraction_location: readString(params.record.extractionLocation),
          source_payload: params.record,
        }),
      },
    ],
    skippedRecords: [],
  };
}

/**
 * Parse the explicit removed/moved-out manifest produced by oracle-node.
 * Duplicate GERS IDs and unsupported reasons are rejected before mutation.
 *
 * @param value Untrusted manifest JSON.
 * @returns Validated deactivation manifest.
 */
export function parsePlacesDeactivationManifest(
  value: unknown,
): PlacesDeactivationManifest {
  if (!isJsonObject(value)) {
    throw new Error("Places deactivation manifest must be an object");
  }
  if (value.schemaVersion !== "overture-places-deactivation/v1") {
    throw new Error("Unsupported places deactivation manifest schemaVersion");
  }
  const county = readString(value.county);
  const release = readString(value.release);
  if (county === null || release === null || !Array.isArray(value.records)) {
    throw new Error("Places deactivation manifest is missing county/release/records");
  }
  const seen = new Set<string>();
  const records = value.records.map((candidate, index): PlacesDeactivation => {
    if (!isJsonObject(candidate)) {
      throw new Error(`Places deactivation record ${index} must be an object`);
    }
    const gersId = readString(candidate.gersId);
    const reason = readString(candidate.reason);
    if (
      gersId === null ||
      (reason !== "removed" && reason !== "moved_out")
    ) {
      throw new Error(`Places deactivation record ${index} is invalid`);
    }
    if (seen.has(gersId)) {
      throw new Error(`Duplicate places deactivation GERS ID: ${gersId}`);
    }
    seen.add(gersId);
    return { gersId, reason };
  });
  return {
    schemaVersion: "overture-places-deactivation/v1",
    county,
    release,
    records,
  };
}

type PlaceAddress = {
  readonly sourceRecordKey: string;
  readonly fullAddress: string;
  readonly cityName: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly sourcePayload: JsonObject;
};

function locationRow(
  record: JsonObject,
  locationKey: string,
  address: PlaceAddress | null,
  release: string,
  artifactUri: string | null,
): PreparedRow {
  const name = readString(record.name_primary);
  return {
    tableName: "business_locations",
    ...(address === null
      ? {}
      : { references: { addressSourceRecordKey: address.sourceRecordKey } }),
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: PLACES_SOURCE_SYSTEM,
        sourceRecordKey: locationKey,
        sourcePayload: record,
        sourceArtifactUri: artifactUri,
      }),
      county_key: readString(record.county_key),
      county_fips: readString(record.county_fips),
      gers_id: readString(record.gers_id),
      overture_version: readNumber(record.overture_version),
      name_primary: name,
      normalized_name: normalizeName(name),
      taxonomy_primary: readString(record.taxonomy_primary),
      taxonomy_hierarchy: readStringArray(record.taxonomy_hierarchy),
      basic_category: readString(record.basic_category),
      legacy_category_primary: readString(record.legacy_category_primary),
      operating_status: readString(record.operating_status),
      confidence: readNumber(record.confidence),
      websites: readStringArray(record.websites),
      socials: readStringArray(record.socials),
      emails: readStringArray(record.emails),
      phones: readStringArray(record.phones),
      brand_name: readString(record.brand_name),
      brand_wikidata: readString(record.brand_wikidata),
      address_freeform: readString(record.address_freeform),
      address_locality: readString(record.address_locality),
      address_postcode: readString(record.address_postcode),
      address_region: readString(record.address_region),
      address_country: readString(record.address_country),
      longitude: readNumber(record.longitude),
      latitude: readNumber(record.latitude),
      is_hosted_service: readBoolean(record.is_hosted_service),
      hosted_service_rule: readString(record.hosted_service_rule),
      first_seen_release: release,
      last_seen_release: release,
      is_current: true,
      source_payload: record,
    }),
  };
}

function categoryRows(
  record: JsonObject,
  locationKey: string,
  hierarchy: readonly string[],
  artifactUri: string | null,
): readonly PreparedRow[] {
  const primary = readString(record.taxonomy_primary);
  const path = readString(record.taxonomy_hierarchy_path) ?? hierarchy.join("/");
  const rows: PreparedRow[] = [];
  if (primary !== null) {
    rows.push(
      categoryRow({
        locationKey,
        ordinal: 0,
        label: primary,
        path,
        isPrimary: true,
        payload: { label: primary, path, is_primary: true },
        artifactUri,
      }),
    );
  }
  const alternates = readStringArray(record.taxonomy_alternate);
  for (const [index, label] of alternates.entries()) {
    if (label === primary) continue;
    rows.push(
      categoryRow({
        locationKey,
        ordinal: index + 1,
        label,
        path: null,
        isPrimary: false,
        payload: { label, is_primary: false },
        artifactUri,
      }),
    );
  }
  return rows;
}

function categoryRow(params: {
  readonly locationKey: string;
  readonly ordinal: number;
  readonly label: string;
  readonly path: string | null;
  readonly isPrimary: boolean;
  readonly payload: JsonObject;
  readonly artifactUri: string | null;
}): PreparedRow {
  const sourceRecordKey = `${params.locationKey}:category:${params.ordinal}:${params.label}`;
  return {
    tableName: "business_location_categories",
    references: { businessLocationSourceRecordKey: params.locationKey },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: PLACES_SOURCE_SYSTEM,
        sourceRecordKey,
        sourcePayload: params.payload,
        sourceArtifactUri: params.artifactUri,
      }),
      category_label: params.label,
      taxonomy_path: params.path,
      is_primary: params.isPrimary,
      source_payload: params.payload,
    }),
  };
}

function sourceRows(
  record: JsonObject,
  locationKey: string,
  artifactUri: string | null,
): readonly PreparedRow[] {
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const rows: PreparedRow[] = [];
  for (const [index, entry] of sources.entries()) {
    if (!isJsonObject(entry)) continue;
    const dataset = readString(entry.dataset);
    if (dataset === null) continue;
    const sourceRecordKey = `${locationKey}:source:${index}:${dataset}`;
    rows.push({
      tableName: "business_location_sources",
      references: { businessLocationSourceRecordKey: locationKey },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem: PLACES_SOURCE_SYSTEM,
          sourceRecordKey,
          sourcePayload: entry,
          sourceArtifactUri: artifactUri,
        }),
        dataset,
        record_id: readString(entry.record_id ?? entry.recordId),
        update_time: readString(entry.update_time ?? entry.updateTime),
        confidence: readNumber(entry.confidence),
        license: readString(entry.license ?? entry.licence),
        source_payload: entry,
      }),
    });
  }
  return rows;
}

function readPlaceAddress(record: JsonObject, sourceRecordKey: string): PlaceAddress | null {
  const fullAddress = readString(record.address_freeform);
  if (fullAddress === null) return null;
  return {
    sourceRecordKey,
    fullAddress,
    cityName: readString(record.address_locality),
    stateCode: readString(record.address_region),
    postalCode: readString(record.address_postcode),
    countryCode: readString(record.address_country),
    latitude: readNumber(record.latitude),
    longitude: readNumber(record.longitude),
    sourcePayload: {
      address_freeform: record.address_freeform,
      address_locality: record.address_locality,
      address_postcode: record.address_postcode,
      address_region: record.address_region,
      address_country: record.address_country,
    },
  };
}

function addressRow(address: PlaceAddress, artifactUri: string | null): PreparedRow {
  const normalizedAddressKey = buildNormalizedAddressKey(address.fullAddress);
  return {
    tableName: "addresses",
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: PLACES_SOURCE_SYSTEM,
        sourceRecordKey: address.sourceRecordKey,
        sourcePayload: address.sourcePayload,
        sourceArtifactUri: artifactUri,
      }),
      request_identifier: address.sourceRecordKey,
      unnormalized_address: address.fullAddress,
      normalized_address_key: normalizedAddressKey,
      normalized_address_hash: hashNormalizedAddressKey(normalizedAddressKey),
      city_name: address.cityName,
      state_code: address.stateCode,
      postal_code: address.postalCode,
      country_code: address.countryCode,
      latitude: address.latitude,
      longitude: address.longitude,
      source_payload: address.sourcePayload,
    }),
  };
}
