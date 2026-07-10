import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  extractPostalCodeFromAddress,
  hashNormalizedAddressKey,
  hashString,
  isJsonObject,
  normalizeName,
  normalizeParcelIdentifier,
  readBoolean,
  readDate,
  readNumber,
  readString,
  readTimestamp,
  stableJsonStringify,
} from "./normalizers.js";
import type { JsonObject, PreparedRow, PreparedRowBundle, SourceSystem } from "./types.js";

type LeeCompletedInspection = {
  readonly result?: unknown;
  readonly inspectionCode?: unknown;
  readonly inspectionType?: unknown;
  readonly inspectionIdentifier?: unknown;
  readonly inspectorName?: unknown;
  readonly resultedDate?: unknown;
};

type LeePermitLink = {
  readonly text?: unknown;
  readonly url?: unknown;
  readonly title?: unknown;
};

type ParsedPermitEvent = {
  readonly eventType: string;
  readonly eventStatus: string | null;
  readonly eventDate: string | null;
  readonly actorName: string | null;
  readonly commentText: string | null;
  readonly sourcePayload: JsonObject;
};

type ParsedPermitFee = {
  readonly feeCode: string | null;
  readonly feeDescription: string | null;
  readonly feeStatus: string | null;
  readonly assessedAmount: number | null;
  readonly paidAmount: number | null;
  readonly balanceAmount: number | null;
  readonly assessedDate: string | null;
  readonly paidDate: string | null;
  readonly sourcePayload: JsonObject;
};

type ParsedLicensedProfessionalContact = {
  readonly sequenceNumber: number;
  readonly isPrimary: boolean;
  readonly rawText: string;
  readonly personName: string | null;
  readonly companyName: string | null;
  readonly addressText: string | null;
  readonly licenseType: string | null;
  readonly licenseNumber: string | null;
  readonly personSourceRecordKey: string | null;
  readonly companySourceRecordKey: string | null;
  readonly addressSourceRecordKey: string | null;
  readonly sourcePayload: JsonObject;
};

type ParsedContractorLicense = {
  readonly licenseType: string;
  readonly licenseNumber: string;
  readonly beforeLicense: string;
};

type ParsedContractorNameParts = {
  readonly personName: string | null;
  readonly companyName: string | null;
};

type ParsedPersonNameParts = {
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly suffixName: string | null;
};

type ContractorAddressSplit = {
  readonly prefixText: string;
  readonly addressText: string | null;
};

const DEFAULT_PERMIT_SOURCE_SYSTEM = "lee_accela";
const ADDITIONAL_LICENSED_PROFESSIONALS_MARKER = "View Additional Licensed Professionals>>";
const PERMIT_STATUS_MAX_LENGTH = 256;
const CONTRACTOR_COMPANY_INDICATOR_TOKENS = new Set<string>([
  "AIR",
  "BUILDERS",
  "BUILDING",
  "CO",
  "COMPANY",
  "CONSTRUCTION",
  "CONTRACTING",
  "CONTRACTOR",
  "CORP",
  "CORPORATION",
  "DESIGNS",
  "ELECTRIC",
  "ELECTRICAL",
  "HEATING",
  "INC",
  "LLC",
  "LTD",
  "SERVICES",
  "SERVICE",
  "SIGN",
  "SIGNS",
]);
const PERSON_SUFFIX_TOKENS = new Set<string>(["JR", "SR", "II", "III", "IV", "V"]);
const CONTRACTOR_LICENSE_PATTERN = new RegExp(
  String.raw`\b(` +
    [
      "Certified General Cntr",
      "General Contractor",
      "Certified Electrical Cntr",
      "Certified Electrical Cont",
      "Certified Outdoor Sign Spec",
      "Sign Erection Electrical",
      "Sign Contr-Limited",
      "Air Cond & Heating Class A",
      "Air Cond & Heating Class B",
      "Building Contractor",
      "Cement Mason",
      "Master Electrician",
    ].join("|") +
    String.raw`)\s+([A-Z]{1,5}\s*[A-Z0-9-]+|\d{3,})(?:\s+INACTIVE)?\b`,
  "gi",
);
const CONTRACTOR_ADDRESS_PATTERN =
  /^(?<prefix>.*?)(?<address>(?:P\.?O\.?\s+BOX|PO BOX|\d{1,6})\s+.+?,\s*(?:FL|FLORIDA),?\s*\d{5}(?:-\d{4})?)/i;

/**
 * Read the visible Lee Accela record status from a harvested artifact.
 *
 * The source payload and raw text still preserve the complete page text, but
 * the query-facing status columns must contain only the concise public status.
 * Some historic Accela pages omit a clean boundary after `Record Status`, which
 * caused collection controls and tab labels to be captured into status fields.
 *
 * @param value - Raw artifact status value.
 * @returns Clean status text suitable for indexed status columns, or `null`.
 */
function readPermitRecordStatus(value: unknown): string | null {
  const text = readString(value)?.replace(/\s+/g, " ") ?? null;
  if (text === null) return null;
  const boundary = /\s+(?:Click here for more information|Create a New Collection|Add to Existing Collection|Record Info|Record Details|Processing Status|Related Records|Work Location)\b/i.exec(
    text,
  );
  const status = boundary === null ? text : text.slice(0, boundary.index).trim();
  if (status.length === 0) return null;
  return status.length <= PERMIT_STATUS_MAX_LENGTH
    ? status
    : status.slice(0, PERMIT_STATUS_MAX_LENGTH).trimEnd();
}

/**
 * Map one extracted Lee Accela permit-detail artifact into logical query-db rows.
 *
 * @param params - Source artifact payload and provenance URI.
 * @returns Prepared rows for the permit, work-location address, contacts, inspections, links, and custom fields.
 */
export function mapLeePermitDetail(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
  readonly sourceSystem?: string;
}): PreparedRowBundle {
  const sourceSystem = (params.sourceSystem ?? DEFAULT_PERMIT_SOURCE_SYSTEM) as SourceSystem;
  if (!isJsonObject(params.record)) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "permit detail artifact is not a JSON object",
          sourcePayload: { value: params.record },
        },
      ],
    };
  }

  const recordNumber = readString(params.record.recordNumber);
  const idempotencyKey = readString(params.record.idempotencyKey);
  const sourceRecordKey = recordNumber ?? idempotencyKey;
  if (sourceRecordKey === null) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "permit detail artifact is missing recordNumber and idempotencyKey",
          sourcePayload: params.record,
        },
      ],
    };
  }

  const permitKey = `${sourceSystem}:permit:${sourceRecordKey}`;
  const workLocation = readString(params.record.workLocation);
  const workLocationKey = workLocation === null ? null : `${sourceSystem}:permit:${sourceRecordKey}:work_location`;
  const recordStatus = readPermitRecordStatus(params.record.recordStatus);
  const moreDetails = isJsonObject(params.record.moreDetails) ? params.record.moreDetails : {};
  const parsedFees = parsePermitFees(params.record);
  const totalFeeAmount = sumPermitFeeAmounts(parsedFees);
  const licensedProfessionalContacts = parseLicensedProfessionalContacts(
    readString(params.record.licensedProfessional),
    sourceSystem,
  );
  const primaryLicensedProfessional = licensedProfessionalContacts.find((contact) => contact.isPrimary);
  const rows: PreparedRow[] = [];

  if (workLocation !== null && workLocationKey !== null) {
    rows.push({
      tableName: "addresses",
      values: buildAddressRow({
        sourceRecordKey: workLocationKey,
        sourcePayload: params.record,
        artifactUri: params.artifactUri,
        unnormalizedAddress: workLocation,
        sourceSystem,
      }),
    });
  }
  rows.push(...mapLicensedProfessionalEntityRows(licensedProfessionalContacts, params.artifactUri, sourceSystem));

  const permitReferences = {
    ...(workLocationKey === null ? {} : { addressSourceRecordKey: workLocationKey }),
    ...(primaryLicensedProfessional?.companySourceRecordKey === null || primaryLicensedProfessional?.companySourceRecordKey === undefined
      ? {}
      : { companySourceRecordKey: primaryLicensedProfessional.companySourceRecordKey }),
  };

  const permitValues = compactObject({
    ...buildSourceMetadata({
      sourceSystem,
      sourceRecordKey: permitKey,
      sourcePayload: params.record,
      sourceArtifactUri: params.artifactUri,
    }),
    request_identifier: permitKey,
    permit_number: recordNumber,
    improvement_type: readString(moreDetails.Type) ?? readString(params.record.recordType),
    improvement_status: recordStatus,
    record_type: readString(params.record.recordType),
    source_status: recordStatus,
    record_status: recordStatus,
    schema_version: readString(params.record.schemaVersion),
    source: readString(params.record.source),
    source_url: readString(params.record.sourceUrl),
    retrieved_at: readTimestamp(params.record.retrievedAt),
    work_location: workLocation,
    parcel_identifier: normalizeParcelIdentifier(
      readString(params.record.parcelIdentifier) ?? moreDetails["Parcel Number"],
    ),
    applicant: readString(params.record.applicant),
    licensed_professional: readString(params.record.licensedProfessional),
    project_description: readString(params.record.projectDescription),
    private_provider_plan_review: readBoolean(moreDetails["Private Provider Plan Review?"]),
    private_provider_inspections: readBoolean(moreDetails["Private Provider Inspections?"]),
    is_owner_builder: readBoolean(moreDetails["Is the permit being pulled as Owner-Builder?"]),
    is_disaster_recovery: readBoolean(moreDetails["Is the proposed work a result of hurricane damage?"]),
    fee: totalFeeAmount,
    estimated_job_value:
      readNumber(moreDetails["Estimated Job Value"]) ?? readNumber(moreDetails["Est Const. Value"]),
    estimated_sq_ft:
      readNumber(moreDetails["Estimated Building SQFT"]) ?? readNumber(moreDetails["Building Square Footage"]),
    block: readString(moreDetails.Block),
    lot: readString(moreDetails.Lot),
    subdivision: readString(moreDetails.Subdivision),
    planning_community: readString(moreDetails.PLANNINGCOMMUNITY),
    municipal_code: readString(moreDetails.MUNICODE),
    historic: readString(moreDetails.HISTORIC),
    fire_district: readString(moreDetails.FIREDISTRICT),
    more_details: moreDetails,
    more_details_raw_text: readString(params.record.moreDetailsRawText),
    inspections_raw_text: readString(params.record.inspectionsRawText),
    processing_status_raw_text: readString(params.record.processingStatusRawText),
    raw_text: readString(params.record.rawText),
    source_search_result: isJsonObject(params.record.sourceSearchResult)
      ? params.record.sourceSearchResult
      : null,
    idempotency_key: idempotencyKey,
    source_http_request: sourceHttpRequestFromUrl(params.record.sourceUrl),
    source_payload: params.record,
  });
  rows.push(
    Object.keys(permitReferences).length === 0
      ? {
          tableName: "property_improvements",
          values: permitValues,
        }
      : {
          tableName: "property_improvements",
          references: permitReferences,
          values: permitValues,
        },
  );

  rows.push(...mapPermitContacts(params.record, permitKey, params.artifactUri, licensedProfessionalContacts, sourceSystem));
  rows.push(...mapPermitInspections(params.record, recordNumber, permitKey, params.artifactUri, sourceSystem));
  rows.push(...mapPermitEvents(params.record, permitKey, params.artifactUri, sourceSystem));
  rows.push(...mapPermitFees(parsedFees, permitKey, params.artifactUri, sourceSystem));
  rows.push(...mapPermitLinks(params.record, permitKey, params.artifactUri, sourceSystem));
  rows.push(...mapPermitCustomFields(moreDetails, permitKey, params.artifactUri, sourceSystem));

  return { rows, skippedRecords: [] };
}

/**
 * Map record-status and inspection-result details into permit event rows.
 *
 * Accela's processing-status tab is not consistently exposed in the harvested
 * JSON, but every detail artifact preserves the visible record status and
 * completed inspections. These rows create a deterministic permit timeline from
 * the public status evidence already present in the source payload.
 *
 * @param record - Parsed Lee Accela permit detail artifact.
 * @param permitKey - Stable source key for the parent permit row.
 * @param artifactUri - S3 URI of the source permit artifact.
 * @returns Prepared `permit_events` rows linked to the parent permit.
 */
function mapPermitEvents(
  record: JsonObject,
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  return parsePermitEvents(record).map((event) => {
    const identity = [
      event.eventType,
      event.eventStatus,
      event.eventDate,
      event.actorName,
      event.commentText,
      stableEventPayloadIdentity(event.sourcePayload),
    ].join("\n");
    const sourceRecordKey = `${permitKey}:event:${event.eventType.toLowerCase()}:${hashString(identity)}`;
    return {
      tableName: "permit_events",
      references: { propertyImprovementSourceRecordKey: permitKey },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem,
          sourceRecordKey,
          sourcePayload: event.sourcePayload,
          sourceArtifactUri: artifactUri,
        }),
        event_type: event.eventType,
        event_status: event.eventStatus,
        event_date: event.eventDate,
        actor_name: event.actorName,
        comment_text: event.commentText,
        source_payload: event.sourcePayload,
      }),
    };
  });
}

/**
 * Parse visible permit status and completed inspection details into timeline events.
 *
 * @param record - Parsed Lee Accela permit detail artifact.
 * @returns Normalized event objects suitable for `permit_events`.
 */
function parsePermitEvents(record: JsonObject): readonly ParsedPermitEvent[] {
  const events: ParsedPermitEvent[] = [];
  const recordStatus = readPermitRecordStatus(record.recordStatus);
  if (recordStatus !== null) {
    events.push({
      eventType: "RECORD_STATUS",
      eventStatus: recordStatus,
      eventDate: readTimestamp(record.retrievedAt),
      actorName: null,
      commentText: null,
      sourcePayload: compactObject({
        source: "record_status",
        recordNumber: readString(record.recordNumber),
        recordStatus,
        retrievedAt: readString(record.retrievedAt),
      }),
    });
  }

  const inspections = Array.isArray(record.completedInspections)
    ? record.completedInspections.filter(isJsonObject)
    : [];
  inspections.forEach((inspection, index) => {
    const typedInspection = inspection as LeeCompletedInspection;
    const result = readString(typedInspection.result);
    const inspectionType = readString(typedInspection.inspectionType);
    events.push({
      eventType: "INSPECTION_RESULT",
      eventStatus: result,
      eventDate: readTimestamp(typedInspection.resultedDate),
      actorName: readString(typedInspection.inspectorName),
      commentText: inspectionType,
      sourcePayload: compactObject({
        source: "completed_inspection",
        index,
        inspection,
      }),
    });
  });

  return events;
}

/**
 * Map parsed fee rows into permit fee extension rows.
 *
 * @param fees - Normalized fee line items parsed from the source payload.
 * @param permitKey - Stable source key for the parent permit row.
 * @param artifactUri - S3 URI of the source permit artifact.
 * @returns Prepared `permit_fees` rows linked to the parent permit.
 */
function mapPermitFees(
  fees: readonly ParsedPermitFee[],
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  return fees.map((fee, index) => {
    const sourceRecordKey = `${permitKey}:fee:${hashString(`${String(index)}\n${stableEventPayloadIdentity(fee.sourcePayload)}`)}`;
    return {
      tableName: "permit_fees",
      references: { propertyImprovementSourceRecordKey: permitKey },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem,
          sourceRecordKey,
          sourcePayload: fee.sourcePayload,
          sourceArtifactUri: artifactUri,
        }),
        fee_code: fee.feeCode,
        fee_description: fee.feeDescription,
        fee_status: fee.feeStatus,
        assessed_amount: fee.assessedAmount,
        paid_amount: fee.paidAmount,
        balance_amount: fee.balanceAmount,
        assessed_date: fee.assessedDate,
        paid_date: fee.paidDate,
        source_payload: fee.sourcePayload,
      }),
    };
  });
}

/**
 * Parse the public fee table text preserved in Accela's raw detail text.
 *
 * The harvester stores the complete page text in `rawText`. For legacy Lee
 * records the fee grid usually appears as repeated `Date Invoice Number Amount`
 * rows followed by `View Details`; this parser intentionally keeps the original
 * line evidence in `sourcePayload` so downstream users can audit each inferred
 * fee line.
 *
 * @param record - Parsed Lee Accela permit detail artifact.
 * @returns Fee line items parsed from `rawText`.
 */
function parsePermitFees(record: JsonObject): readonly ParsedPermitFee[] {
  const rawText = readString(record.rawText);
  if (rawText === null) return [];

  const fees: ParsedPermitFee[] = [];
  const pattern = /(\d{1,2}\/\d{1,2}\/\d{4})\s+([A-Z0-9-]+)\s+\$?([\d,]+(?:\.\d{2})?)\s+View Details/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawText)) !== null) {
    const paidDate = readDate(match[1]);
    const invoiceNumber = readString(match[2]);
    const amount = readNumber(match[3]);
    const status = inferFeeStatus(rawText, match.index);
    const sourceTextStart = Math.max(0, match.index - 80);
    const sourceTextEnd = Math.min(rawText.length, pattern.lastIndex + 40);
    const sourcePayload = compactObject({
      source: "raw_text_fee_table",
      sourceText: rawText.slice(sourceTextStart, sourceTextEnd).replace(/\s+/g, " ").trim(),
      invoiceNumber,
      amount,
      paidDate,
      status,
    });
    fees.push({
      feeCode: invoiceNumber,
      feeDescription: invoiceNumber === null ? null : `Invoice ${invoiceNumber}`,
      feeStatus: status,
      assessedAmount: amount,
      paidAmount: status === "PAID_OR_DISCOUNTED" ? amount : null,
      balanceAmount: status === "OUTSTANDING" ? amount : null,
      assessedDate: paidDate,
      paidDate: status === "PAID_OR_DISCOUNTED" ? paidDate : null,
      sourcePayload,
    });
  }

  return fees;
}

/**
 * Infer the fee status from the nearest heading before a fee row.
 *
 * @param text - Full raw page text.
 * @param matchIndex - Start offset of the parsed fee row.
 * @returns Normalized fee status label.
 */
function inferFeeStatus(text: string, matchIndex: number): string {
  const context = text.slice(Math.max(0, matchIndex - 240), matchIndex).toLowerCase();
  if (context.includes("paid / discounted") || context.includes("paid fees")) return "PAID_OR_DISCOUNTED";
  if (context.includes("outstanding")) return "OUTSTANDING";
  return "UNKNOWN";
}

/**
 * Sum parsed fee amounts for the parent permit's convenience `fee` column.
 *
 * @param fees - Parsed fee line items.
 * @returns Total assessed amount when at least one amount was parsed, otherwise `null`.
 */
function sumPermitFeeAmounts(fees: readonly ParsedPermitFee[]): number | null {
  const amounts = fees
    .map((fee) => fee.assessedAmount)
    .filter((amount): amount is number => amount !== null);
  if (amounts.length === 0) return null;
  return Number(amounts.reduce((total, amount) => total + amount, 0).toFixed(2));
}

/**
 * Build a compact identity string for event/fee source-key hashing.
 *
 * @param payload - Source payload object for one event or fee row.
 * @returns Stable JSON text used only for deterministic source keys.
 */
function stableEventPayloadIdentity(payload: JsonObject): string {
  return stableJsonStringify(payload);
}

function buildAddressRow(params: {
  readonly sourceRecordKey: string;
  readonly sourcePayload: JsonObject;
  readonly artifactUri: string | null;
  readonly unnormalizedAddress: string;
  readonly sourceSystem: SourceSystem;
}): JsonObject {
  const normalizedAddressKey = buildNormalizedAddressKey(params.unnormalizedAddress);
  return compactObject({
    ...buildSourceMetadata({
      sourceSystem: params.sourceSystem,
      sourceRecordKey: params.sourceRecordKey,
      sourcePayload: params.sourcePayload,
      sourceArtifactUri: params.artifactUri,
    }),
    request_identifier: params.sourceRecordKey,
    unnormalized_address: params.unnormalizedAddress,
    normalized_address_key: normalizedAddressKey,
    normalized_address_hash: hashNormalizedAddressKey(normalizedAddressKey),
    postal_code: extractPostalCodeFromAddress(params.unnormalizedAddress),
    state_code: /\bFL\b/i.test(params.unnormalizedAddress)
      ? "FL"
      : /\bCA\b/i.test(params.unnormalizedAddress)
        ? "CA"
        : null,
    country_code: "US",
    source_payload: params.sourcePayload,
  });
}

/**
 * Map parsed licensed-professional evidence into reusable company/person/address rows.
 *
 * @param contacts - Parsed primary and additional licensed-professional blocks from one permit detail record.
 * @param artifactUri - S3 URI of the source permit artifact.
 * @returns Deduplicated prepared rows for contractor people, contractor companies, and contractor addresses.
 */
function mapLicensedProfessionalEntityRows(
  contacts: readonly ParsedLicensedProfessionalContact[],
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  const rows: PreparedRow[] = [];
  const seenSourceKeys = new Set<string>();
  for (const contact of contacts) {
    if (contact.addressSourceRecordKey !== null && contact.addressText !== null) {
      pushUniquePreparedRow(rows, seenSourceKeys, {
        tableName: "addresses",
        values: buildAddressRow({
          sourceRecordKey: contact.addressSourceRecordKey,
          sourcePayload: contact.sourcePayload,
          artifactUri,
          unnormalizedAddress: contact.addressText,
          sourceSystem,
        }),
      });
    }
    if (contact.personSourceRecordKey !== null && contact.personName !== null) {
      const nameParts = splitPersonName(contact.personName);
      pushUniquePreparedRow(rows, seenSourceKeys, {
        tableName: "people",
        values: compactObject({
          ...buildSourceMetadata({
            sourceSystem,
            sourceRecordKey: contact.personSourceRecordKey,
            sourcePayload: contact.sourcePayload,
            sourceArtifactUri: artifactUri,
          }),
          request_identifier: contact.personSourceRecordKey,
          first_name: nameParts.firstName,
          middle_name: nameParts.middleName,
          last_name: nameParts.lastName,
          suffix_name: nameParts.suffixName,
          full_name: contact.personName,
          normalized_name: normalizeName(contact.personName),
          source_payload: contact.sourcePayload,
        }),
      });
    }
    if (contact.companySourceRecordKey !== null && contact.companyName !== null) {
      pushUniquePreparedRow(rows, seenSourceKeys, {
        tableName: "companies",
        values: compactObject({
          ...buildSourceMetadata({
            sourceSystem,
            sourceRecordKey: contact.companySourceRecordKey,
            sourcePayload: contact.sourcePayload,
            sourceArtifactUri: artifactUri,
          }),
          request_identifier: contact.companySourceRecordKey,
          name: contact.companyName,
          normalized_name: canonicalizeContractorName(contact.companyName),
          source_payload: contact.sourcePayload,
        }),
      });
    }
  }
  return rows;
}

function pushUniquePreparedRow(
  rows: PreparedRow[],
  seenSourceKeys: Set<string>,
  row: PreparedRow,
): void {
  const sourceRecordKey = readString(row.values.source_record_key);
  if (sourceRecordKey !== null) {
    const dedupeKey = `${row.tableName}\u0000${sourceRecordKey}`;
    if (seenSourceKeys.has(dedupeKey)) return;
    seenSourceKeys.add(dedupeKey);
  }
  rows.push(row);
}

function mapPermitContacts(
  record: JsonObject,
  permitKey: string,
  artifactUri: string | null,
  licensedProfessionalContacts: readonly ParsedLicensedProfessionalContact[],
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  const contacts: PreparedRow[] = [];
  const applicant = readString(record.applicant);
  if (applicant !== null) {
    contacts.push(buildPermitContactRow("APPLICANT", applicant, record, permitKey, artifactUri, sourceSystem));
  }
  for (const licensedProfessional of licensedProfessionalContacts) {
    contacts.push(buildLicensedProfessionalContactRow(licensedProfessional, permitKey, artifactUri, sourceSystem));
  }
  return contacts;
}

/**
 * Parse Accela's concatenated licensed-professional text into auditable contractor contacts.
 *
 * @param value - Raw `licensedProfessional` field from one Lee Accela permit detail artifact.
 * @returns Primary contact plus any `View Additional Licensed Professionals` blocks found in the source text.
 */
function parseLicensedProfessionalContacts(
  value: string | null,
  sourceSystem: SourceSystem,
): readonly ParsedLicensedProfessionalContact[] {
  if (value === null) return [];
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) return [];

  const markerIndex = normalized.indexOf(ADDITIONAL_LICENSED_PROFESSIONALS_MARKER);
  const primaryText = markerIndex < 0 ? normalized : normalized.slice(0, markerIndex).trim();
  const additionalText = markerIndex < 0
    ? ""
    : normalized.slice(markerIndex + ADDITIONAL_LICENSED_PROFESSIONALS_MARKER.length).trim();
  const contacts: ParsedLicensedProfessionalContact[] = [];
  if (primaryText.length > 0) contacts.push(parseLicensedProfessionalBlock(primaryText, 1, true, sourceSystem));
  for (const block of splitAdditionalLicensedProfessionalBlocks(additionalText)) {
    contacts.push(parseLicensedProfessionalBlock(block, contacts.length + 1, false, sourceSystem));
  }
  return contacts;
}

/**
 * Split Accela's numbered additional-professional section into individual raw blocks.
 *
 * @param value - Text after `View Additional Licensed Professionals>>`.
 * @returns Raw professional blocks without the numeric prefixes.
 */
function splitAdditionalLicensedProfessionalBlocks(value: string): readonly string[] {
  if (value.length === 0) return [];
  const blocks: string[] = [];
  const pattern = /(?:^|\s)\d+\)\s+(.+?)(?=\s+\d+\)\s+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const block = readString(match[1]);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/**
 * Parse one licensed-professional block into contractor identity, address, and license fields.
 *
 * @param rawText - Raw primary or additional licensed-professional text block.
 * @param sequenceNumber - One-based order within the permit's licensed-professional list.
 * @param isPrimary - Whether this block is the permit's primary licensed professional.
 * @returns Parsed contractor contact with deterministic source keys for entity linking.
 */
function parseLicensedProfessionalBlock(
  rawText: string,
  sequenceNumber: number,
  isPrimary: boolean,
  sourceSystem: SourceSystem,
): ParsedLicensedProfessionalContact {
  const normalizedRawText = normalizeWhitespace(rawText);
  const license = parseContractorLicense(normalizedRawText);
  const beforeLicense = stripContractorPhoneText(license?.beforeLicense ?? normalizedRawText);
  const addressSplit = splitContractorAddress(beforeLicense);
  const nameParts = splitContractorName(addressSplit.prefixText);
  const licenseNumber = license?.licenseNumber ?? null;
  const sourcePayload = compactObject({
    source: "licensed_professional",
    sequenceNumber,
    isPrimary,
    rawText: normalizedRawText,
    personName: nameParts.personName,
    companyName: nameParts.companyName,
    addressText: addressSplit.addressText,
    licenseType: license?.licenseType ?? null,
    licenseNumber,
  });

  return {
    sequenceNumber,
    isPrimary,
    rawText: normalizedRawText,
    personName: nameParts.personName,
    companyName: nameParts.companyName,
    addressText: addressSplit.addressText,
    licenseType: license?.licenseType ?? null,
    licenseNumber,
    personSourceRecordKey: buildContractorPersonSourceRecordKey(nameParts.personName, licenseNumber, sourceSystem),
    companySourceRecordKey: buildContractorCompanySourceRecordKey(nameParts.companyName, sourceSystem),
    addressSourceRecordKey: buildContractorAddressSourceRecordKey(addressSplit.addressText, sourceSystem),
    sourcePayload,
  };
}

/**
 * Parse the license type/number suffix from a licensed-professional block.
 *
 * @param value - Normalized raw licensed-professional text.
 * @returns Parsed license and text before the license suffix, or `null` when no known license pattern is present.
 */
function parseContractorLicense(value: string): ParsedContractorLicense | null {
  const matches = [...value.matchAll(CONTRACTOR_LICENSE_PATTERN)];
  const lastMatch = matches.at(-1);
  if (lastMatch === undefined || lastMatch.index === undefined) return null;
  const licenseType = readString(lastMatch[1]);
  const licenseNumber = readString(lastMatch[2]);
  if (licenseType === null || licenseNumber === null) return null;
  return {
    licenseType,
    licenseNumber: normalizeWhitespace(licenseNumber),
    beforeLicense: value.slice(0, lastMatch.index).trim(),
  };
}

function stripContractorPhoneText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\bPrimary Phone:\s*[0-9().\-\s]+/gi, " ")
      .replace(/\bAlternate Phone:\s*[0-9().\-\s]+/gi, " ")
      .replace(/\bFax:\s*[0-9().\-\s]+/gi, " "),
  );
}

function splitContractorAddress(value: string): ContractorAddressSplit {
  const match = CONTRACTOR_ADDRESS_PATTERN.exec(value);
  if (match?.groups === undefined) {
    return { prefixText: normalizeWhitespace(value), addressText: null };
  }
  return {
    prefixText: normalizeWhitespace(match.groups.prefix ?? ""),
    addressText: normalizeWhitespace(match.groups.address ?? "") || null,
  };
}

function splitContractorName(value: string): ParsedContractorNameParts {
  const normalized = normalizeWhitespace(value.replace(/[.,]/g, " "));
  if (normalized.length === 0) return { personName: null, companyName: null };
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  const earlyCompanyIndicatorIndex = tokens.findIndex(
    (token, index) => index <= 2 && CONTRACTOR_COMPANY_INDICATOR_TOKENS.has(token.toUpperCase()),
  );
  if (earlyCompanyIndicatorIndex >= 0) {
    return { personName: null, companyName: normalized };
  }

  const personTokenCount = inferLeadingPersonTokenCount(tokens);
  const personName = normalizeWhitespace(tokens.slice(0, personTokenCount).join(" ")) || null;
  const companyName = normalizeWhitespace(tokens.slice(personTokenCount).join(" ")) || null;
  return { personName, companyName };
}

function inferLeadingPersonTokenCount(tokens: readonly string[]): number {
  if (tokens.length <= 2) return tokens.length;
  let count = tokens[1]?.length === 1 ? 3 : 2;
  const suffix = tokens[count];
  if (suffix !== undefined && PERSON_SUFFIX_TOKENS.has(suffix.toUpperCase())) count += 1;
  return Math.min(count, tokens.length);
}

function splitPersonName(value: string): ParsedPersonNameParts {
  const tokens = normalizeWhitespace(value.replace(/[.,]/g, " ")).split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { firstName: null, middleName: null, lastName: null, suffixName: null };
  }
  const suffix = tokens.at(-1);
  const suffixName = suffix !== undefined && PERSON_SUFFIX_TOKENS.has(suffix.toUpperCase()) ? suffix : null;
  const nameTokens = suffixName === null ? tokens : tokens.slice(0, -1);
  return {
    firstName: nameTokens[0] ?? null,
    middleName: nameTokens.length > 2 ? nameTokens.slice(1, -1).join(" ") : null,
    lastName: nameTokens.length > 1 ? nameTokens.at(-1) ?? null : null,
    suffixName,
  };
}

function buildContractorPersonSourceRecordKey(
  personName: string | null,
  licenseNumber: string | null,
  sourceSystem: SourceSystem,
): string | null {
  const normalizedName = normalizeName(personName);
  if (normalizedName === null) return null;
  const normalizedLicenseNumber = normalizeContractorLicenseNumber(licenseNumber);
  return `${sourceSystem}:contractor_person:${hashString(`${normalizedName}\n${normalizedLicenseNumber ?? ""}`)}`;
}

function buildContractorCompanySourceRecordKey(companyName: string | null, sourceSystem: SourceSystem): string | null {
  const canonicalName = canonicalizeContractorName(companyName);
  if (canonicalName === null) return null;
  return `${sourceSystem}:contractor_company:${hashString(canonicalName)}`;
}

function buildContractorAddressSourceRecordKey(addressText: string | null, sourceSystem: SourceSystem): string | null {
  const normalizedAddressKey = buildNormalizedAddressKey(addressText);
  if (normalizedAddressKey === null) return null;
  return `${sourceSystem}:contractor_address:${hashString(normalizedAddressKey)}`;
}

function canonicalizeContractorName(value: unknown): string | null {
  const normalizedName = normalizeName(value);
  if (normalizedName === null) return null;
  return normalizedName
    .replace(/\bU S\b/g, "US")
    .replace(/\bAND\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeContractorLicenseNumber(value: string | null): string | null {
  const text = readString(value);
  return text === null ? null : text.toUpperCase().replace(/\s+/g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildLicensedProfessionalContactRow(
  contact: ParsedLicensedProfessionalContact,
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): PreparedRow {
  const sourceRecordKey = contact.isPrimary
    ? `${permitKey}:contact:licensed_professional`
    : `${permitKey}:contact:licensed_professional:${String(contact.sequenceNumber)}`;
  const references = {
    propertyImprovementSourceRecordKey: permitKey,
    ...(contact.personSourceRecordKey === null ? {} : { personSourceRecordKey: contact.personSourceRecordKey }),
    ...(contact.companySourceRecordKey === null ? {} : { companySourceRecordKey: contact.companySourceRecordKey }),
    ...(contact.addressSourceRecordKey === null ? {} : { addressSourceRecordKey: contact.addressSourceRecordKey }),
  };
  return {
    tableName: "permit_contacts",
    references,
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem,
        sourceRecordKey,
        sourcePayload: contact.sourcePayload,
        sourceArtifactUri: artifactUri,
      }),
      contact_role: contact.isPrimary ? "LICENSED_PROFESSIONAL" : "LICENSED_PROFESSIONAL_ADDITIONAL",
      raw_name: contact.rawText,
      raw_block_text: contact.rawText,
      license_number: contact.licenseNumber,
      license_type: contact.licenseType,
      source_payload: contact.sourcePayload,
    }),
  };
}

function buildPermitContactRow(
  role: string,
  rawName: string,
  sourcePayload: JsonObject,
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): PreparedRow {
  const sourceRecordKey = `${permitKey}:contact:${role.toLowerCase()}`;
  return {
    tableName: "permit_contacts",
    references: { propertyImprovementSourceRecordKey: permitKey },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem,
        sourceRecordKey,
        sourcePayload,
        sourceArtifactUri: artifactUri,
      }),
      contact_role: role,
      raw_name: rawName,
      raw_block_text: rawName,
      source_payload: { rawName, normalizedName: normalizeName(rawName) },
    }),
  };
}

function mapPermitInspections(
  record: JsonObject,
  recordNumber: string | null,
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  const inspections = Array.isArray(record.completedInspections)
    ? record.completedInspections.filter(isJsonObject)
    : [];
  return inspections.map((inspection, index) => {
    const typedInspection = inspection as LeeCompletedInspection;
    const sourceRecordKey = `${permitKey}:inspection:${readString(typedInspection.inspectionIdentifier) ?? index}`;
    return {
      tableName: "inspections",
      references: { propertyImprovementSourceRecordKey: permitKey },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem,
          sourceRecordKey,
          sourcePayload: inspection,
          sourceArtifactUri: artifactUri,
        }),
        inspection_status: readString(typedInspection.result),
        permit_number: recordNumber,
        result: readString(typedInspection.result),
        inspection_code: readString(typedInspection.inspectionCode),
        inspection_type: readString(typedInspection.inspectionType),
        inspection_identifier: readString(typedInspection.inspectionIdentifier),
        inspector_name: readString(typedInspection.inspectorName),
        resulted_date: readString(typedInspection.resultedDate),
        completed_date: readDate(typedInspection.resultedDate),
        source_payload: inspection,
      }),
    };
  });
}

function mapPermitLinks(
  record: JsonObject,
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  const links = [
    ...readLinkArray(record.documentLinks, "DOCUMENT"),
    ...readLinkArray(record.relatedLinks, "RELATED"),
  ];
  const rows: PreparedRow[] = [];
  const seenLinkKeys = new Set<string>();
  links.forEach((link, index) => {
    const url = readString(link.url) ?? `missing-url-${index}`;
    const linkIdentityKey = `${link.linkKind}\u0000${url}`;
    if (seenLinkKeys.has(linkIdentityKey)) return;
    seenLinkKeys.add(linkIdentityKey);
    const sourceRecordKey = buildPermitLinkSourceRecordKey(permitKey, link.linkKind, url);
    rows.push({
      tableName: "permit_links",
      references: { propertyImprovementSourceRecordKey: permitKey },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem,
          sourceRecordKey,
          sourcePayload: link,
          sourceArtifactUri: artifactUri,
        }),
        link_kind: link.linkKind,
        text: readString(link.text),
        url,
        title: readString(link.title),
        source_payload: link,
      }),
    });
  });
  return rows;
}

/**
 * Build a stable source key for a permit link using the same identity as the database URL uniqueness rule.
 *
 * @param permitKey - Source key for the parent permit.
 * @param linkKind - Logical link kind such as `DOCUMENT` or `RELATED`.
 * @param url - Link URL after defaulting missing values.
 * @returns Compact deterministic source key for idempotent permit link writes.
 */
function buildPermitLinkSourceRecordKey(permitKey: string, linkKind: string, url: string): string {
  return `${permitKey}:link:${linkKind.toLowerCase()}:${hashString(`${linkKind}\n${url}`)}`;
}

function readLinkArray(value: unknown, linkKind: string): readonly (LeePermitLink & { readonly linkKind: string })[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).map((entry) => ({ ...entry, linkKind }));
}

function mapPermitCustomFields(
  moreDetails: JsonObject,
  permitKey: string,
  artifactUri: string | null,
  sourceSystem: SourceSystem,
): readonly PreparedRow[] {
  return Object.entries(moreDetails).map(([fieldName, fieldValue]) => {
    const sourceRecordKey = `${permitKey}:custom:${fieldName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    return {
      tableName: "permit_custom_fields",
      references: { propertyImprovementSourceRecordKey: permitKey },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem,
          sourceRecordKey,
          sourcePayload: { fieldName, fieldValue },
          sourceArtifactUri: artifactUri,
        }),
        field_group: "more_details",
        field_name: fieldName,
        field_value: fieldValue === null || fieldValue === undefined ? null : String(fieldValue),
        field_payload: { fieldName, fieldValue },
        source_payload: { fieldName, fieldValue },
      }),
    };
  });
}

function sourceHttpRequestFromUrl(value: unknown): JsonObject | null {
  const url = readString(value);
  return url === null ? null : { method: "GET", url };
}

/**
 * Map one normalized city permit-portal record (bulk CSV/API pull) into
 * logical query-db rows.
 *
 * Unlike Lee Accela detail artifacts (one `.json` file per permit, camelCase
 * fields, inspections/fees/contacts), bulk city pulls are flat JSONL rows with
 * snake_case fields produced by a city normalizer (e.g. San Jose / Palo Alto
 * for Santa Clara county):
 *
 * ```json
 * {"source_system":"sanjose_permits","source_url":"…","city":"San Jose",
 *  "permit_number":"2018-112785-IR","parcel_identifier":"12437065",
 *  "work_location":"155 CALIFORNIA AV, …","permit_issue_date":"2018-04-10",
 *  "record_status":"Active","record_type":"Voluntary",
 *  "project_description":"…","is_roof_permit":false,"raw":{…}}
 * ```
 *
 * The DB `source_system` comes from `--permit-source-system` (county-scoped,
 * e.g. `santa_clara_permits`) so the permit-table export's anchored
 * `^<county>_` prefix match finds these rows. The record's own city-level
 * `source_system` (`sanjose_permits`, `paloalto_permits`, …) is preserved in
 * the source key (so permit numbers can never collide across cities), in the
 * `source` column, and in `more_details.city_source_system`.
 *
 * @param params - Source record, provenance URI, and county-scoped source system.
 * @returns Prepared permit row plus a work-location address row when the address is usable.
 */
export function mapNormalizedCityPermit(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
  readonly sourceSystem: string;
}): PreparedRowBundle {
  const sourceSystem = params.sourceSystem as SourceSystem;
  if (!isJsonObject(params.record)) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "normalized city permit record is not a JSON object",
          sourcePayload: { value: params.record },
        },
      ],
    };
  }

  const permitNumber = readString(params.record.permit_number);
  if (permitNumber === null) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "normalized city permit record is missing permit_number",
          sourcePayload: params.record,
        },
      ],
    };
  }

  const citySourceSystem = readString(params.record.source_system) ?? "unknown";
  const permitKey = `${sourceSystem}:permit:${citySourceSystem}:${permitNumber}`;
  const recordStatus = readString(params.record.record_status);
  const recordType = readString(params.record.record_type);
  const parcelIdentifier = normalizeParcelIdentifier(params.record.parcel_identifier);
  const workLocation = readString(params.record.work_location);
  const normalizedWorkLocationKey = buildNormalizedAddressKey(workLocation);
  // Bulk city pulls contain placeholder locations like "," that normalize to
  // an empty key — skip the address row for those instead of staging junk.
  const workLocationKey =
    normalizedWorkLocationKey !== null && normalizedWorkLocationKey.length > 0
      ? `${permitKey}:work_location`
      : null;
  const rows: PreparedRow[] = [];

  if (workLocation !== null && workLocationKey !== null) {
    rows.push({
      tableName: "addresses",
      values: buildAddressRow({
        sourceRecordKey: workLocationKey,
        sourcePayload: params.record,
        artifactUri: params.artifactUri,
        unnormalizedAddress: workLocation,
        sourceSystem,
      }),
    });
  }

  const permitValues = compactObject({
    ...buildSourceMetadata({
      sourceSystem,
      sourceRecordKey: permitKey,
      sourcePayload: params.record,
      sourceArtifactUri: params.artifactUri,
    }),
    request_identifier: permitKey,
    permit_number: permitNumber,
    improvement_type: recordType,
    improvement_status: recordStatus,
    record_type: recordType,
    source_status: recordStatus,
    record_status: recordStatus,
    source: citySourceSystem,
    source_url: readString(params.record.source_url),
    permit_issue_date: readDate(params.record.permit_issue_date),
    work_location: workLocation,
    parcel_identifier: parcelIdentifier,
    project_description: readString(params.record.project_description),
    more_details: compactObject({
      city: readString(params.record.city),
      city_source_system: citySourceSystem,
      is_roof_permit: readBoolean(params.record.is_roof_permit),
    }),
    source_http_request: sourceHttpRequestFromUrl(params.record.source_url),
    source_payload: params.record,
  });
  const permitReferences = buildNormalizedCityPermitReferences({
    parcelIdentifier,
    permitSourceSystem: sourceSystem,
    workLocationKey,
  });
  rows.push(
    permitReferences === undefined
      ? { tableName: "property_improvements", values: permitValues }
      : {
          tableName: "property_improvements",
          references: permitReferences,
          values: permitValues,
        },
  );

  return { rows, skippedRecords: [] };
}

/**
 * Build cross-source references for a normalized city permit.
 *
 * County-scoped city permit systems use `<county>_permits`, while their
 * appraisal parents use `<county>_appraiser`. When a normalized APN is
 * available, the appraisal source keys are deterministic and let both the
 * single-row and bulk loaders resolve `parcel_id` and `property_id` without a
 * county-specific post-load linker.
 */
function buildNormalizedCityPermitReferences(params: {
  readonly parcelIdentifier: string | null;
  readonly permitSourceSystem: SourceSystem;
  readonly workLocationKey: string | null;
}): PreparedRow["references"] | undefined {
  const appraiserSourceSystem = appraiserSourceSystemFromPermitSourceSystem(
    params.permitSourceSystem,
  );
  const references = {
    ...(params.workLocationKey === null
      ? {}
      : { addressSourceRecordKey: params.workLocationKey }),
    ...(params.parcelIdentifier === null || appraiserSourceSystem === null
      ? {}
      : {
          parcelSourceRecordKey: `${appraiserSourceSystem}:${params.parcelIdentifier}:parcel:property_seed`,
          propertySourceRecordKey: `${appraiserSourceSystem}:${params.parcelIdentifier}:property:property`,
        }),
  };
  return Object.keys(references).length === 0 ? undefined : references;
}

function appraiserSourceSystemFromPermitSourceSystem(
  sourceSystem: SourceSystem,
): SourceSystem | null {
  const suffix = "_permits";
  if (!sourceSystem.endsWith(suffix) || sourceSystem.length <= suffix.length) {
    return null;
  }
  return `${sourceSystem.slice(0, -suffix.length)}_appraiser` as SourceSystem;
}
