import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  extractPostalCodeFromAddress,
  hashNormalizedAddressKey,
  isJsonObject,
  normalizeName,
  normalizePostalCode,
  readBoolean,
  readDate,
  readInteger,
  readString,
  readStringArray,
} from "./normalizers.js";
import type { JsonObject, PreparedRow, PreparedRowBundle } from "./types.js";

export type SunbizClassType =
  | "address"
  | "business_registration"
  | "business_registration_address"
  | "business_registration_party"
  | "company";

const SUNBIZ_SOURCE_SYSTEM = "sunbiz";

/**
 * Map one Sunbiz lexicon class record into its logical query-db table row.
 *
 * @param params - Sunbiz class type, parsed record payload, and source artifact URI.
 * @returns Prepared row bundle for recognized records, or a skipped-record entry for invalid payloads.
 */
export function mapSunbizClassRecord(params: {
  readonly classType: SunbizClassType;
  readonly record: unknown;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: `Sunbiz ${params.classType} record is not a JSON object`,
          sourcePayload: { value: params.record },
        },
      ],
    };
  }

  const row = mapSunbizObject(params.classType, params.record, params.artifactUri);
  return row === null
    ? {
        rows: [],
        skippedRecords: [
          {
            artifactUri: params.artifactUri,
            reason: `Sunbiz ${params.classType} record is missing request_identifier`,
            sourcePayload: params.record,
          },
        ],
      }
    : { rows: [row], skippedRecords: [] };
}

/**
 * Expand annual-report columns from a Sunbiz registration record into repeatable child rows.
 *
 * @param params - Parsed business-registration record payload and artifact URI.
 * @returns Prepared annual-report rows for non-empty annual report fields.
 */
export function mapSunbizAnnualReportsFromRegistration(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return { rows: [], skippedRecords: [] };
  }
  const documentNumber = readString(params.record.document_number);
  const registrationKey = readString(params.record.request_identifier);
  if (documentNumber === null || registrationKey === null) {
    return { rows: [], skippedRecords: [] };
  }
  const rows: PreparedRow[] = [];
  for (const ordinal of [1, 2, 3] as const) {
    const reportYear = readString(params.record[`annual_report_${ordinal}_year`]);
    const reportDate = readDate(params.record[`annual_report_${ordinal}_date`]);
    if (reportYear === null && reportDate === null) continue;
    const sourceRecordKey = `${registrationKey}:annual_report:${ordinal}`;
    rows.push({
      tableName: "business_registration_annual_reports",
      references: {
        businessRegistrationDocumentNumber: documentNumber,
        businessRegistrationSourceRecordKey: registrationKey,
      },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem: SUNBIZ_SOURCE_SYSTEM,
          sourceRecordKey,
          sourcePayload: { documentNumber, ordinal, reportYear, reportDate },
          sourceArtifactUri: params.artifactUri,
        }),
        document_number: documentNumber,
        report_ordinal: ordinal,
        report_year: reportYear,
        report_date: reportDate,
        source_payload: { documentNumber, ordinal, reportYear, reportDate },
      }),
    });
  }
  return { rows, skippedRecords: [] };
}

function mapSunbizObject(
  classType: SunbizClassType,
  record: JsonObject,
  artifactUri: string | null,
): PreparedRow | null {
  switch (classType) {
    case "address":
      return mapAddress(record, artifactUri);
    case "business_registration":
      return mapBusinessRegistration(record, artifactUri);
    case "business_registration_address":
      return mapBusinessRegistrationAddress(record, artifactUri);
    case "business_registration_party":
      return mapBusinessRegistrationParty(record, artifactUri);
    case "company":
      return mapCompany(record, artifactUri);
  }
}

function sourceMetadata(record: JsonObject, artifactUri: string | null): ReturnType<typeof buildSourceMetadata> | null {
  const sourceRecordKey = readString(record.request_identifier);
  if (sourceRecordKey === null) return null;
  return buildSourceMetadata({
    sourceSystem: SUNBIZ_SOURCE_SYSTEM,
    sourceRecordKey,
    sourcePayload: record,
    sourceArtifactUri: artifactUri,
  });
}

function mapCompany(record: JsonObject, artifactUri: string | null): PreparedRow | null {
  const metadata = sourceMetadata(record, artifactUri);
  if (metadata === null) return null;
  const name = readString(record.name);
  return {
    tableName: "companies",
    values: compactObject({
      ...metadata,
      request_identifier: metadata.source_record_key,
      name,
      normalized_name: normalizeName(name),
      source_http_request: isJsonObject(record.source_http_request) ? record.source_http_request : null,
      source_payload: record,
    }),
  };
}

function mapAddress(record: JsonObject, artifactUri: string | null): PreparedRow | null {
  const metadata = sourceMetadata(record, artifactUri);
  if (metadata === null) return null;
  const unnormalizedAddress = readString(record.unnormalized_address);
  const normalizedAddressKey = buildNormalizedAddressKey(unnormalizedAddress);
  return {
    tableName: "addresses",
    values: compactObject({
      ...metadata,
      request_identifier: metadata.source_record_key,
      city_name: readString(record.city_name),
      country_code: readString(record.country_code) ?? "US",
      plus_four_postal_code: readString(record.plus_four_postal_code),
      postal_code: normalizePostalCode(record.postal_code) ?? extractPostalCodeFromAddress(unnormalizedAddress),
      state_code: readString(record.state_code),
      unnormalized_address: unnormalizedAddress,
      normalized_address_key: normalizedAddressKey,
      normalized_address_hash: hashNormalizedAddressKey(normalizedAddressKey),
      source_http_request: isJsonObject(record.source_http_request) ? record.source_http_request : null,
      source_payload: record,
    }),
  };
}

function mapBusinessRegistration(record: JsonObject, artifactUri: string | null): PreparedRow | null {
  const metadata = sourceMetadata(record, artifactUri);
  if (metadata === null) return null;
  const documentNumber = readString(record.document_number);
  const values = compactObject({
      ...metadata,
      request_identifier: metadata.source_record_key,
      source_data_uri: readString(record.source_data_uri),
      source_file_name: readString(record.source_file_name),
      source_line_number: readInteger(record.source_line_number),
      schema_version: readString(record.schema_version),
      parser_source: readString(record.parser_source),
      document_number: documentNumber,
      entity_name: readString(record.entity_name),
      status_code: readString(record.status_code),
      status: readString(record.status),
      filing_type_code: readString(record.filing_type_code),
      filing_type: readString(record.filing_type),
      filed_date: readDate(record.filed_date),
      fei_number: readString(record.fei_number),
      last_transaction_date: readDate(record.last_transaction_date),
      state_country: readString(record.state_country),
      annual_report_1_year: readString(record.annual_report_1_year),
      annual_report_1_date: readDate(record.annual_report_1_date),
      annual_report_2_year: readString(record.annual_report_2_year),
      annual_report_2_date: readDate(record.annual_report_2_date),
      annual_report_3_year: readString(record.annual_report_3_year),
      annual_report_3_date: readDate(record.annual_report_3_date),
      more_than_six_officers: readBoolean(record.more_than_six_officers),
      raw_record_length: readInteger(record.raw_record_length),
      matched_address_roles: readStringArray(record.matched_address_roles),
      matched_zip_prefixes: readStringArray(record.matched_zip_prefixes),
      source_payload: record,
  });
  if (documentNumber === null) {
    return {
      tableName: "business_registrations",
      values,
    };
  }
  return {
    tableName: "business_registrations",
    references: { companySourceRecordKey: `sunbiz:${documentNumber}:company` },
    values,
  };
}

function mapBusinessRegistrationAddress(
  record: JsonObject,
  artifactUri: string | null,
): PreparedRow | null {
  const metadata = sourceMetadata(record, artifactUri);
  const documentNumber = readString(record.document_number);
  if (metadata === null || documentNumber === null) return null;
  return {
    tableName: "business_registration_addresses",
    references: { businessRegistrationDocumentNumber: documentNumber },
    values: compactObject({
      ...metadata,
      request_identifier: metadata.source_record_key,
      document_number: documentNumber,
      address_role: readString(record.address_role),
      line_1: readString(record.line_1),
      line_2: readString(record.line_2),
      city: readString(record.city),
      state: readString(record.state),
      zip: normalizePostalCode(record.zip),
      country: readString(record.country),
      single_line: readString(record.single_line),
      normalized: readString(record.normalized),
      matched_zip_prefixes: readStringArray(record.matched_zip_prefixes),
      source_payload: record,
    }),
  };
}

function mapBusinessRegistrationParty(
  record: JsonObject,
  artifactUri: string | null,
): PreparedRow | null {
  const metadata = sourceMetadata(record, artifactUri);
  const documentNumber = readString(record.document_number);
  if (metadata === null || documentNumber === null) return null;
  const name = readString(record.name);
  return {
    tableName: "business_registration_parties",
    references: { businessRegistrationDocumentNumber: documentNumber },
    values: compactObject({
      ...metadata,
      request_identifier: metadata.source_record_key,
      document_number: documentNumber,
      party_role: readString(record.party_role),
      name,
      normalized_name: readString(record.normalized_name) ?? normalizeName(name),
      party_type_code: readString(record.party_type_code),
      title: readString(record.title),
      officer_ordinal: readInteger(record.officer_ordinal),
      address_line_1: readString(record.address_line_1),
      address_line_2: readString(record.address_line_2),
      address_city: readString(record.address_city),
      address_state: readString(record.address_state),
      address_zip: normalizePostalCode(record.address_zip),
      address_country: readString(record.address_country),
      address_single_line: readString(record.address_single_line),
      address_normalized: readString(record.address_normalized),
      matched_zip_prefixes: readStringArray(record.matched_zip_prefixes),
      source_payload: record,
    }),
  };
}
