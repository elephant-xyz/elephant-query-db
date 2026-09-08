import {
  buildSourceMetadata,
  compactObject,
  isJsonObject,
  normalizeParcelIdentifier,
  readDate,
  readNumber,
  readString,
  readTimestamp,
} from "./normalizers.js";
import type { PreparedRow } from "./types.js";

export type ApprovedAvmSource = {
  readonly sourceProfileId: string;
  readonly provider: string;
  readonly countyFips: string;
  readonly licenseReviewReference: string;
  readonly publicationPermitted: boolean;
  readonly publicationApprovedAt: string;
  readonly sourceManifestSha256: string;
  readonly sourceRecordsSha256: string;
};

export type ApprovedAvmRecordParams = {
  readonly record: unknown;
  readonly approval: ApprovedAvmSource;
  readonly artifactUri: string | null;
  readonly sourceSystem: `${string}_avm`;
  readonly propertySourceSystem: `${string}_appraiser`;
};

const REGISTERED_AVM_SOURCE_PROFILES: ReadonlyMap<
  string,
  ApprovedAvmSource
> = new Map();

function requiredString(value: unknown, field: string): string {
  const text = readString(value);
  if (text === null) throw new Error(`Approved AVM requires ${field}`);
  return text;
}

function requiredPositiveNumber(value: unknown, field: string): number {
  const number = readNumber(value);
  if (number === null || number <= 0) {
    throw new Error(`Approved AVM requires a positive ${field}`);
  }
  return number;
}

function requiredSha256(value: unknown, field: string): string {
  const digest = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`Approved AVM requires a valid ${field}`);
  }
  return digest;
}

/**
 * Resolve only source profiles reviewed and committed with this loader.
 * The registry intentionally remains empty until a provider contract is
 * approved for durable public redistribution.
 */
export function assertRegisteredApprovedAvmSource(
  approval: ApprovedAvmSource,
): ApprovedAvmSource {
  const registered = REGISTERED_AVM_SOURCE_PROFILES.get(
    approval.sourceProfileId,
  );
  if (registered === undefined) {
    throw new Error(
      `AVM source profile ${approval.sourceProfileId} is not registered`,
    );
  }
  if (JSON.stringify(registered) !== JSON.stringify(approval)) {
    throw new Error(
      `AVM source profile ${approval.sourceProfileId} does not match its registered approval`,
    );
  }
  return registered;
}

/**
 * Map one separately approved vendor valuation into a query-db row.
 *
 * The approval object is intentionally separate from source records: vendor
 * bytes cannot self-assert publication rights. The caller must supply a
 * reviewed source profile with immutable manifest and records digests.
 */
export function mapApprovedAvmRecord(
  params: ApprovedAvmRecordParams,
): PreparedRow {
  if (!isJsonObject(params.record)) {
    throw new Error("Approved AVM record must be a JSON object");
  }
  if (params.approval.publicationPermitted !== true) {
    throw new Error("Approved AVM requires explicit publication approval");
  }
  if (
    !/^[a-z0-9_]+_avm$/u.test(params.sourceSystem) ||
    !/^[a-z0-9_]+_appraiser$/u.test(params.propertySourceSystem)
  ) {
    throw new Error(
      "Approved AVM requires explicit AVM and appraiser source systems",
    );
  }

  const sourceProfileId = requiredString(
    params.approval.sourceProfileId,
    "sourceProfileId",
  );
  const provider = requiredString(params.approval.provider, "provider");
  const countyFips = requiredString(
    params.approval.countyFips,
    "countyFips",
  );
  if (!/^\d{5}$/u.test(countyFips)) {
    throw new Error("Approved AVM requires a five-digit countyFips");
  }
  const licenseReviewReference = requiredString(
    params.approval.licenseReviewReference,
    "licenseReviewReference",
  );
  const publicationApprovedAt = readTimestamp(
    params.approval.publicationApprovedAt,
  );
  if (publicationApprovedAt === null) {
    throw new Error("Approved AVM requires publicationApprovedAt");
  }
  const sourceManifestSha256 = requiredSha256(
    params.approval.sourceManifestSha256,
    "sourceManifestSha256",
  );
  const sourceRecordsSha256 = requiredSha256(
    params.approval.sourceRecordsSha256,
    "sourceRecordsSha256",
  );

  if (params.record.county_fips !== countyFips) {
    throw new Error("Approved AVM record county_fips does not match approval");
  }
  const requestIdentifier = requiredString(
    params.record.request_identifier,
    "request_identifier",
  );
  const parcelIdentifier = requiredString(
    params.record.parcel_identifier,
    "parcel_identifier",
  );
  const vendorApn = requiredString(params.record.vendor_apn, "vendor_apn");
  const normalizedParcel = normalizeParcelIdentifier(parcelIdentifier);
  if (
    normalizedParcel === null ||
    normalizeParcelIdentifier(requestIdentifier) !== normalizedParcel ||
    normalizeParcelIdentifier(vendorApn) !== normalizedParcel
  ) {
    throw new Error(
      "Approved AVM request_identifier and vendor_apn must exactly match the normalized parcel_identifier",
    );
  }

  const currentAvmValue = requiredPositiveNumber(
    params.record.current_avm_value,
    "current_avm_value",
  );
  const lowValue = requiredPositiveNumber(
    params.record.valuation_low,
    "valuation_low",
  );
  const highValue = requiredPositiveNumber(
    params.record.valuation_high,
    "valuation_high",
  );
  if (lowValue > currentAvmValue || highValue < currentAvmValue) {
    throw new Error("Approved AVM valuation bounds do not contain its value");
  }
  const confidenceScore = readNumber(params.record.confidence_score);
  if (
    confidenceScore === null ||
    !Number.isInteger(confidenceScore) ||
    confidenceScore < 0 ||
    confidenceScore > 100
  ) {
    throw new Error(
      "Approved AVM requires an integer confidence_score from 0 through 100",
    );
  }
  const valuationDate = readDate(params.record.valuation_date);
  if (valuationDate === null) {
    throw new Error("Approved AVM requires a valid valuation_date");
  }
  if (valuationDate > publicationApprovedAt.slice(0, 10)) {
    throw new Error(
      "Approved AVM valuation_date cannot follow publication approval",
    );
  }
  const valuationMethodType = requiredString(
    params.record.valuation_method_type,
    "valuation_method_type",
  );
  if (/apprais|assess|tax.?roll/iu.test(valuationMethodType)) {
    throw new Error(
      "Approved AVM valuation_method_type cannot represent an appraiser or tax-roll value",
    );
  }
  const vendorPropertyId = requiredString(
    params.record.vendor_property_id,
    "vendor_property_id",
  );
  const artifactUri = requiredString(params.artifactUri, "artifactUri");
  const sourceRecordKey = [
    params.sourceSystem,
    countyFips,
    vendorPropertyId,
    valuationDate,
  ].join(":");

  return {
    tableName: "property_valuations",
    references: {
      propertySourceRecordKey: `${params.propertySourceSystem}:${requestIdentifier}:property:property`,
    },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: params.sourceSystem,
        sourceRecordKey,
        sourcePayload: params.record,
        sourceArtifactUri: artifactUri,
      }),
      request_identifier: requestIdentifier,
      valuation_date: valuationDate,
      valuation_method_type: valuationMethodType,
      confidence_score: confidenceScore,
      current_avm_value: currentAvmValue,
      high_value: highValue,
      low_value: lowValue,
      provider,
      vendor_property_id: vendorPropertyId,
      county_fips: countyFips,
      source_profile_id: sourceProfileId,
      publication_permitted: true,
      publication_approved_at: publicationApprovedAt,
      license_review_reference: licenseReviewReference,
      source_manifest_sha256: sourceManifestSha256,
      source_records_sha256: sourceRecordsSha256,
      source_payload: params.record,
    }),
  };
}
