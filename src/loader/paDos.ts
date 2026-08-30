import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  hashNormalizedAddressKey,
  isJsonObject,
  normalizeName,
  normalizePostalCode,
  readDate,
  readString,
} from "./normalizers.js";
import type { JsonObject, PreparedRow, PreparedRowBundle } from "./types.js";

export const PA_DOS_SOURCE_SYSTEM = "pa_dos";

const PA_DOS_SOURCE_HTTP_REQUEST = Object.freeze({
  method: "GET",
  url: "https://data.pa.gov/resource/xvd7-5r2c.json",
});

/**
 * One deduped PA Department of State entity ready for loader mapping.
 */
export type PaDosEntityInput = {
  readonly filingNumber: string;
  readonly businessName: string;
  readonly addressLine1: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly entityType: string | null;
  readonly partyType: string | null;
  readonly creationDate: string | null;
  readonly countyName: string | null;
};

/**
 * @param filingNumber - PA DOS filing number.
 * @param suffix - Stable record suffix.
 * @returns Canonical pa_dos source_record_key.
 */
export function paDosSourceRecordKey(filingNumber: string, suffix: string): string {
  return `${PA_DOS_SOURCE_SYSTEM}:${filingNumber}:${suffix}`;
}

/**
 * Build the single-line address used for normalization.
 *
 * @param entity - PA DOS entity input.
 * @returns Uppercase comma-separated address text.
 */
export function buildPaDosUnnormalizedAddress(entity: PaDosEntityInput): string | null {
  const line1 = readString(entity.addressLine1);
  const city = readString(entity.city)?.split(",")[0]?.trim() ?? null;
  const state = readString(entity.state)?.toUpperCase() ?? "PA";
  const zip = normalizePostalCode(entity.zip);
  if (line1 === null || city === null || zip === null) return null;
  return `${line1.toUpperCase()}, ${city.toUpperCase()} ${state}, ${zip}`;
}

/**
 * Map one Chester-scoped PA DOS entity into query-db business-registration rows.
 *
 * @param params - Entity payload and optional artifact URI for provenance.
 * @returns Prepared rows for addresses, company, registration, and address bridge.
 */
export function mapPaDosEntity(params: {
  readonly entity: PaDosEntityInput;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  const filingNumber = readString(params.entity.filingNumber);
  const businessName = readString(params.entity.businessName);
  if (filingNumber === null || businessName === null) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "PA DOS entity missing filing_number or business_name",
          sourcePayload: params.entity as unknown as JsonObject,
        },
      ],
    };
  }

  const unnormalizedAddress = buildPaDosUnnormalizedAddress(params.entity);
  const normalizedAddressKey = buildNormalizedAddressKey(unnormalizedAddress);
  const addressKey = paDosSourceRecordKey(filingNumber, "address:registered_office");
  const companyKey = paDosSourceRecordKey(filingNumber, "company");
  const registrationKey = paDosSourceRecordKey(filingNumber, "business_registration");
  const bridgeKey = paDosSourceRecordKey(filingNumber, "business_registration_address:registered_office");

  /** @type {PreparedRow[]} */
  const rows: PreparedRow[] = [];

  if (unnormalizedAddress !== null) {
    rows.push({
      tableName: "addresses",
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem: PA_DOS_SOURCE_SYSTEM,
          sourceRecordKey: addressKey,
          sourcePayload: params.entity as unknown as JsonObject,
          sourceArtifactUri: params.artifactUri,
        }),
        request_identifier: addressKey,
        city_name: readString(params.entity.city)?.split(",")[0]?.trim() ?? null,
        state_code: readString(params.entity.state)?.toUpperCase() ?? "PA",
        postal_code: normalizePostalCode(params.entity.zip),
        country_code: "US",
        unnormalized_address: unnormalizedAddress,
        normalized_address_key: normalizedAddressKey,
        normalized_address_hash: hashNormalizedAddressKey(normalizedAddressKey),
        source_http_request: PA_DOS_SOURCE_HTTP_REQUEST,
        source_payload: params.entity,
      }),
    });
  }

  rows.push({
    tableName: "companies",
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: PA_DOS_SOURCE_SYSTEM,
        sourceRecordKey: companyKey,
        sourcePayload: params.entity as unknown as JsonObject,
        sourceArtifactUri: params.artifactUri,
      }),
      request_identifier: companyKey,
      name: businessName,
      normalized_name: normalizeName(businessName),
      source_http_request: PA_DOS_SOURCE_HTTP_REQUEST,
      source_payload: params.entity,
    }),
  });

  rows.push({
    tableName: "business_registrations",
    references: { companySourceRecordKey: companyKey },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: PA_DOS_SOURCE_SYSTEM,
        sourceRecordKey: registrationKey,
        sourcePayload: params.entity as unknown as JsonObject,
        sourceArtifactUri: params.artifactUri,
      }),
      request_identifier: registrationKey,
      document_number: filingNumber,
      entity_name: businessName,
      filing_type: readString(params.entity.entityType),
      filed_date: readDate(params.entity.creationDate),
      state_country: "PA",
      parser_source: "pa-dos-open-data",
      schema_version: "elephant-query-db.pa-dos.v1",
      source_payload: params.entity,
    }),
  });

  if (unnormalizedAddress !== null) {
    rows.push({
      tableName: "business_registration_addresses",
      references: {
        businessRegistrationDocumentNumber: filingNumber,
        addressSourceRecordKey: addressKey,
      },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem: PA_DOS_SOURCE_SYSTEM,
          sourceRecordKey: bridgeKey,
          sourcePayload: params.entity as unknown as JsonObject,
          sourceArtifactUri: params.artifactUri,
        }),
        request_identifier: bridgeKey,
        document_number: filingNumber,
        address_role: "REGISTERED_OFFICE",
        line_1: readString(params.entity.addressLine1),
        city: readString(params.entity.city)?.split(",")[0]?.trim() ?? null,
        state: readString(params.entity.state)?.toUpperCase() ?? "PA",
        zip: normalizePostalCode(params.entity.zip),
        country: "US",
        single_line: unnormalizedAddress,
        normalized: normalizedAddressKey,
        source_payload: params.entity,
      }),
    });
  }

  return { rows, skippedRecords: [] };
}

/**
 * Map one lexicon-style PA DOS JSON object when already expanded to class records.
 *
 * @param params - Parsed class record and artifact URI.
 * @returns Prepared row bundle.
 */
export function mapPaDosClassRecord(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "PA DOS record is not a JSON object",
          sourcePayload: { value: params.record },
        },
      ],
    };
  }
  const entity: PaDosEntityInput = {
    filingNumber: readString(params.record.filing_number) ?? "",
    businessName: readString(params.record.business_name) ?? "",
    addressLine1: readString(params.record.address_line1) ?? "",
    city: readString(params.record.city) ?? "",
    state: readString(params.record.state) ?? "PA",
    zip: readString(params.record.zip) ?? "",
    entityType: readString(params.record.typeofbusinessregistration),
    partyType: readString(params.record.party_type),
    creationDate: readString(params.record.creationdate),
    countyName: readString(params.record.shortcountyname),
  };
  return mapPaDosEntity({ entity, artifactUri: params.artifactUri });
}
