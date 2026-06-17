import { buildStreetAddressBase } from "./curated-sample.js";
import { isJsonObject, normalizeParcelIdentifier, readString } from "./normalizers.js";
import type { PreparedRow } from "./types.js";
import type { SunbizClassType } from "./sunbiz.js";

export type ScopedLoadSelection = {
  readonly appraisalArtifactUris: ReadonlySet<string>;
  readonly parcelIdentifiers: ReadonlySet<string>;
  readonly addressBases: ReadonlySet<string>;
  readonly sourceCandidateCount: number;
};

export type SunbizRelatedAddressPair = {
  readonly relationshipType: string;
  readonly relatedSourceRecordKey: string;
  readonly addressSourceRecordKey: string;
  readonly documentNumber: string;
};

/**
 * Build a compact selection object from a curated-commercial manifest.
 *
 * The manifest is intentionally treated as untrusted JSON because it is a local
 * run artifact. Candidates that do not expose a usable parcel id or street-base
 * address are ignored independently so one malformed candidate does not prevent
 * the rest of the scoped load from running.
 *
 * @param manifestRecord - Parsed JSON manifest produced by `select-curated-commercial-sample.ts`.
 * @returns Immutable sets of transformed appraisal artifact URIs, normalized parcel identifiers, and address bases.
 */
export function buildScopedLoadSelectionFromManifest(
  manifestRecord: unknown,
): ScopedLoadSelection {
  if (!isJsonObject(manifestRecord) || !Array.isArray(manifestRecord.candidates)) {
    throw new Error("Scoped load manifest must contain a candidates array");
  }

  const appraisalArtifactUris = new Set<string>();
  const parcelIdentifiers = new Set<string>();
  const addressBases = new Set<string>();
  for (const candidate of manifestRecord.candidates) {
    if (!isJsonObject(candidate)) continue;
    const appraisalOutputS3Uri = readString(candidate.appraisalOutputS3Uri);
    if (appraisalOutputS3Uri !== null) appraisalArtifactUris.add(appraisalOutputS3Uri);

    const parcelIdentifier = normalizeParcelIdentifier(candidate.parcelIdentifier);
    if (parcelIdentifier !== null) parcelIdentifiers.add(parcelIdentifier);

    const addressBase = buildStreetAddressBase(
      readString(candidate.addressBase) ?? readString(candidate.bestPermitAddress),
    );
    if (addressBase !== null) addressBases.add(addressBase);
  }

  return {
    appraisalArtifactUris,
    parcelIdentifiers,
    addressBases,
    sourceCandidateCount: manifestRecord.candidates.length,
  };
}

/**
 * Decide whether prepared appraisal rows belong to one selected parcel.
 *
 * Appraisal transformed ZIPs contain multiple logical rows for one property, so
 * the safest artifact-level filter is to look for any selected parcel identifier
 * in the mapped parcel/property rows before writing the artifact's full row set.
 *
 * @param rows - Prepared rows produced from one appraisal ZIP.
 * @param selection - Scoped parcel/address selection built from the manifest.
 * @returns `true` when the artifact should be included in the scoped load.
 */
export function preparedRowsContainSelectedParcel(
  rows: readonly PreparedRow[],
  selection: ScopedLoadSelection,
): boolean {
  if (selection.appraisalArtifactUris.size > 0) {
    for (const row of rows) {
      const artifactUri = readString(row.values.source_artifact_uri);
      if (artifactUri !== null && selection.appraisalArtifactUris.has(artifactUri)) {
        return true;
      }
    }
  }

  for (const row of rows) {
    const parcelIdentifier = normalizeParcelIdentifier(
      row.values.parcel_identifier ?? row.values.request_identifier,
    );
    if (parcelIdentifier !== null && selection.parcelIdentifiers.has(parcelIdentifier)) {
      return true;
    }
  }
  return false;
}

/**
 * Decide whether one Lee Accela permit-detail source record belongs to the scoped parcels.
 *
 * @param record - Raw permit JSON record from S3.
 * @param selection - Scoped parcel/address selection built from the manifest.
 * @returns `true` when the permit should be transformed and staged.
 */
export function isLeePermitRecordSelected(
  record: unknown,
  selection: ScopedLoadSelection,
): boolean {
  if (!isJsonObject(record)) return false;
  const moreDetails = isJsonObject(record.moreDetails) ? record.moreDetails : {};
  const parcelIdentifier = normalizeParcelIdentifier(
    record.parcelIdentifier ?? moreDetails["Parcel Number"],
  );
  return parcelIdentifier !== null && selection.parcelIdentifiers.has(parcelIdentifier);
}

/**
 * Read a stable Sunbiz address source key from an address-class record.
 *
 * @param record - Raw Sunbiz address class JSON record.
 * @returns Source record key when the record is a Sunbiz address, otherwise `null`.
 */
export function readSunbizAddressSourceRecordKey(record: unknown): string | null {
  if (!isJsonObject(record)) return null;
  const requestIdentifier = readString(record.request_identifier);
  if (requestIdentifier === null || !requestIdentifier.startsWith("sunbiz:address:")) {
    return null;
  }
  return requestIdentifier;
}

/**
 * Decide whether a Sunbiz address record directly matches a selected property address base.
 *
 * @param record - Raw Sunbiz address class JSON record.
 * @param selection - Scoped parcel/address selection built from the manifest.
 * @returns `true` when the address is evidence for one selected property.
 */
export function isSunbizAddressRecordSelected(
  record: unknown,
  selection: ScopedLoadSelection,
): boolean {
  if (!isJsonObject(record)) return false;
  const addressBase = buildStreetAddressBase(
    record.normalized_address_key ?? record.unnormalized_address,
  );
  return addressBase !== null && selection.addressBases.has(addressBase);
}

/**
 * Extract a Sunbiz document number from a class record.
 *
 * @param record - Raw Sunbiz class JSON record.
 * @returns Document number from `document_number` or the request identifier, otherwise `null`.
 */
export function readSunbizDocumentNumber(record: unknown): string | null {
  if (!isJsonObject(record)) return null;
  return (
    readString(record.document_number) ??
    readSunbizDocumentNumberFromRequestIdentifier(record.request_identifier)
  );
}

/**
 * Extract a Sunbiz document number from known request-identifier shapes.
 *
 * @param requestIdentifier - Value such as `sunbiz:N92000000500:business_registration`.
 * @returns Document number when the identifier belongs to a document-scoped class.
 */
export function readSunbizDocumentNumberFromRequestIdentifier(
  requestIdentifier: unknown,
): string | null {
  const text = readString(requestIdentifier);
  if (text === null) return null;
  const match = /^sunbiz:([^:]+):(business_registration|business_registration_address|party|company)(?::|$)/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Decide whether a Sunbiz class record should be loaded for a scoped Sunbiz plan.
 *
 * Address records are filtered by the address source-key set gathered from
 * relationships. Document-scoped classes are filtered by selected document
 * numbers so registrations, companies, parties, and registration addresses stay
 * internally consistent.
 *
 * @param params - Class type, raw record, and selected Sunbiz keys.
 * @returns `true` when the class record belongs in the scoped load.
 */
export function isSunbizClassRecordSelected(params: {
  readonly classType: SunbizClassType;
  readonly record: unknown;
  readonly selectedAddressSourceRecordKeys: ReadonlySet<string>;
  readonly selectedDocumentNumbers: ReadonlySet<string>;
}): boolean {
  if (params.classType === "address") {
    const addressSourceRecordKey = readSunbizAddressSourceRecordKey(params.record);
    return addressSourceRecordKey !== null && params.selectedAddressSourceRecordKeys.has(addressSourceRecordKey);
  }

  const documentNumber = readSunbizDocumentNumber(params.record);
  return documentNumber !== null && params.selectedDocumentNumbers.has(documentNumber);
}

/**
 * Extract the related row/address pair from Sunbiz address relationship records.
 *
 * The transform emits normalized graph relationship JSON. For the query DB we
 * collapse the relevant address relationships into direct `address_id` foreign
 * keys on `business_registration_addresses` and `business_registration_parties`.
 *
 * @param record - Raw relationship JSONL record.
 * @returns Related-source-key/address-source-key pair, or `null` for unrelated shapes.
 */
export function readSunbizRelatedAddressPair(record: unknown): SunbizRelatedAddressPair | null {
  if (!isJsonObject(record)) return null;
  const relationshipType = readString(record.relationship_type);
  if (
    relationshipType !== "business_registration_address_has_address" &&
    relationshipType !== "business_registration_party_has_address"
  ) {
    return null;
  }

  const from = isJsonObject(record.from) ? record.from : null;
  const to = isJsonObject(record.to) ? record.to : null;
  if (from === null || to === null) return null;
  const fromType = readString(from.type);
  const toType = readString(to.type);
  const relatedSourceRecordKey = readString(from.request_identifier);
  const addressSourceRecordKey = readString(to.request_identifier);
  if (
    toType !== "address" ||
    relatedSourceRecordKey === null ||
    addressSourceRecordKey === null ||
    !addressSourceRecordKey.startsWith("sunbiz:address:") ||
    (fromType !== "business_registration_address" && fromType !== "business_registration_party")
  ) {
    return null;
  }

  const documentNumber = readSunbizDocumentNumberFromRequestIdentifier(relatedSourceRecordKey);
  if (documentNumber === null) return null;
  return {
    relationshipType,
    relatedSourceRecordKey,
    addressSourceRecordKey,
    documentNumber,
  };
}

/**
 * Add direct address source-key references to prepared Sunbiz rows.
 *
 * @param rows - Prepared rows produced by the Sunbiz class mappers.
 * @param addressSourceRecordKeyByRelatedSourceRecordKey - Relationship-derived lookup.
 * @returns Prepared rows with address references attached where available.
 */
export function addSunbizAddressReferencesToRows(
  rows: readonly PreparedRow[],
  addressSourceRecordKeyByRelatedSourceRecordKey: ReadonlyMap<string, string>,
): readonly PreparedRow[] {
  return rows.map((row) => {
    const sourceRecordKey = readString(row.values.source_record_key);
    if (sourceRecordKey === null) return row;
    const addressSourceRecordKey = addressSourceRecordKeyByRelatedSourceRecordKey.get(sourceRecordKey);
    if (addressSourceRecordKey === undefined) return row;
    return {
      ...row,
      references: {
        ...row.references,
        addressSourceRecordKey,
      },
    };
  });
}
