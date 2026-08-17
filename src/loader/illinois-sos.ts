import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  hashNormalizedAddressKey,
  normalizeName,
} from "./normalizers.js";
import { upsertPreparedRows } from "./sql.js";
import type {
  BatchUpsertCounters,
  PreparedRow,
  QueryClient,
} from "./types.js";

export const ILLINOIS_SOS_SOURCE_SYSTEM = "illinois_sos";
export const ILLINOIS_SOS_CORP_SCHEMA_VERSION = "corp-fixed-width-v004";
export const ILLINOIS_SOS_CORP_DOCUMENTATION_URL =
  "https://www.ilsos.gov/data/bs/proc_corp_data.pdf";

const ROCK_ISLAND_COUNTY_CODE = "081";

export type IllinoisSosCorporationComponent = "agent" | "master" | "name";
export type IllinoisSosAddressRole =
  | "entity_principal"
  | "officer_raw"
  | "registered_agent_office";
export type IllinoisSosDateField =
  | "agentChangeDate"
  | "extendedFilingDate"
  | "incorporationDate"
  | "transactionDate";

/**
 * Non-fatal source anomaly retained while parsing an otherwise usable record.
 */
export type IllinoisSosValidationIssue = {
  readonly code: "invalid_calendar_date";
  readonly fieldName: IllinoisSosDateField;
  readonly rawValue: string;
};

/**
 * Fields common to every parsed Illinois corporation component record.
 */
export type IllinoisSosSourceRecord = {
  readonly fileNumber: string;
  readonly rawLine: string;
  readonly sourceLineNumber: number;
  readonly validationIssues?: readonly IllinoisSosValidationIssue[];
};

/**
 * Parsed 160-character CORP-MASTER record from the official v004 specification.
 *
 * The president and secretary fields intentionally remain unsplit. The official
 * format supplies each as one 60-character name-and-address field and does not
 * define a safe delimiter between person name and address.
 */
export type IllinoisSosCorporationMasterRecord = IllinoisSosSourceRecord & {
  readonly businessIntentCode: string;
  readonly corporationTypeCode: string;
  readonly extendedFilingDate: string | null;
  readonly incorporationDate: string | null;
  readonly originStateCode: string;
  readonly presidentNameAddressRaw: string | null;
  readonly secretaryNameAddressRaw: string | null;
  readonly statusCode: string;
  readonly transactionDate: string | null;
};

/**
 * Parsed 197-character CORP-NAME record.
 */
export type IllinoisSosCorporationNameRecord = IllinoisSosSourceRecord & {
  readonly entityName: string;
};

/**
 * Parsed 164-character CORP-AGENT record.
 */
export type IllinoisSosCorporationAgentRecord = IllinoisSosSourceRecord & {
  readonly agentChangeDate: string | null;
  readonly agentCity: string | null;
  readonly agentCode: string;
  readonly agentCountyCode: string;
  readonly agentName: string | null;
  readonly agentStreet: string | null;
  readonly agentZip: string | null;
  readonly agentZipPlusFour: string | null;
};

/**
 * Metadata and records from one validated official fixed-width component file.
 */
export type IllinoisSosParsedFile<
  RecordType extends IllinoisSosSourceRecord,
  ComponentType extends IllinoisSosCorporationComponent = IllinoisSosCorporationComponent,
> = {
  readonly component: ComponentType;
  readonly headerFileLabel: string;
  readonly records: readonly RecordType[];
  readonly runDate: string;
  readonly sourceArtifactUri: string;
  readonly sourceFileName: string;
  readonly trailerRecordCount: number;
};

export type IllinoisSosParsedComponentFile =
  | IllinoisSosParsedFile<IllinoisSosCorporationAgentRecord, "agent">
  | IllinoisSosParsedFile<IllinoisSosCorporationMasterRecord, "master">
  | IllinoisSosParsedFile<IllinoisSosCorporationNameRecord, "name">;

/**
 * One corporation assembled from the three source components needed by this pilot.
 */
export type IllinoisSosJoinedCorporation = {
  readonly agent: IllinoisSosCorporationAgentRecord;
  readonly master: IllinoisSosCorporationMasterRecord;
  readonly name: IllinoisSosCorporationNameRecord;
};

/**
 * A validated corporation snapshot whose component records share one run date.
 */
export type IllinoisSosCorporationSnapshot = {
  readonly agentFile: IllinoisSosParsedFile<IllinoisSosCorporationAgentRecord>;
  readonly corporations: readonly IllinoisSosJoinedCorporation[];
  readonly masterFile: IllinoisSosParsedFile<IllinoisSosCorporationMasterRecord>;
  readonly nameFile: IllinoisSosParsedFile<IllinoisSosCorporationNameRecord>;
  readonly runDate: string;
};

/**
 * Internal, role-aware candidate for matching an Illinois registered office to
 * a Rock Island appraisal site address.
 *
 * A match is evidence of a shared address only. It cannot establish ownership,
 * occupancy, tenancy, headquarters, or the location where business is conducted.
 */
export type IllinoisSosRockIslandAddressCandidate = {
  readonly addressRole: "registered_agent_office";
  readonly canInferTenancyOrOwnership: false;
  readonly entityName: string;
  readonly illinoisFileNumber: string;
  readonly normalizedAddressHash: string;
  readonly normalizedAddressKey: string;
  readonly snapshotDate: string;
};

/**
 * Minimal appraisal address evidence accepted by the offline matcher.
 */
export type RockIslandAppraisalAddress = {
  readonly normalizedAddressHash: string;
  readonly propertyId: string;
};

/**
 * One role-aware address-hash match. No property relationship is inferred.
 */
export type IllinoisSosRockIslandAddressMatch = IllinoisSosRockIslandAddressCandidate & {
  readonly matchedPropertyIds: readonly string[];
  readonly matchMethod: "normalized_address_hash";
};

/**
 * Privacy-review input containing entity-level fields only.
 *
 * The explicit false flag prevents callers from treating candidate construction
 * as publication approval. Agent, officer, person, contact, and address fields
 * are intentionally absent from this contract.
 */
export type IllinoisSosPublicExportCandidate = {
  readonly businessIntentCode: string;
  readonly corporationType: string | null;
  readonly corporationTypeCode: string;
  readonly entityName: string;
  readonly illinoisFileNumber: string;
  readonly incorporationDate: string | null;
  readonly lastTransactionDate: string | null;
  readonly privacyReviewRequired: true;
  readonly publicationApproved: false;
  readonly snapshotDate: string;
  readonly sourceSystem: typeof ILLINOIS_SOS_SOURCE_SYSTEM;
  readonly status: string | null;
  readonly statusCode: string;
};

const RECORD_LENGTHS: Readonly<Record<IllinoisSosCorporationComponent, number>> = {
  agent: 164,
  master: 160,
  name: 197,
};

const STATUS_BY_CODE: Readonly<Record<string, string>> = {
  "00": "Goodstanding",
  "01": "Reinstated",
  "02": "Intent to dissolve",
  "03": "Bankruptcy",
  "04": "Unacceptable payment",
  "05": "Agent vacated",
  "06": "Withdrawn",
  "07": "Revoked",
  "08": "Dissolved",
  "09": "Merged/Consolidated",
  "10": "Registered name expiration",
  "11": "Expired",
  "12": "Registered name cancellation",
  "13": "Special Act Corporation",
  "14": "Administratively Dissolved",
  "15": "Converted",
  "16": "Redomisticated",
  "17": "Ag-Coop",
};

const CORPORATION_TYPE_BY_CODE: Readonly<Record<string, string>> = {
  "2": "Summons - Not Qualified",
  "3": "Registered Name Only",
  "4": "Domestic Business Corporation",
  "5": "Not-for-Profit Corporation",
  "6": "Foreign Business Corporation",
};

/**
 * Parse and validate one official Illinois SOS corporation component file.
 *
 * The portal currently strips trailing spaces from control and data records.
 * Lines are therefore accepted up to the documented fixed width and padded
 * only for field-position parsing. The original source line remains preserved
 * in each parsed record. The trailer count must equal the data-record count.
 *
 * @param params - Component kind, unmodified file text, and local provenance.
 * @returns Parsed component records with normalized snapshot metadata.
 * @throws Error when control records, widths, dates, keys, or counts are invalid.
 */
export function parseIllinoisSosCorporationFile(params: {
  readonly component: IllinoisSosCorporationComponent;
  readonly contents: string;
  readonly sourceArtifactUri: string;
  readonly sourceFileName: string;
}): IllinoisSosParsedComponentFile {
  const expectedLength = RECORD_LENGTHS[params.component];
  const lines = splitFixedWidthLines(params.contents);
  if (lines.length < 2) {
    throw new Error(`${params.sourceFileName} must contain a header and trailer`);
  }
  const header = lines[0];
  const trailer = lines.at(-1);
  if (header === undefined || trailer === undefined) {
    throw new Error(`${params.sourceFileName} is missing control records`);
  }
  normalizeLineWidth(header, expectedLength, params.sourceFileName, 1, "header");
  normalizeLineWidth(
    trailer,
    expectedLength,
    params.sourceFileName,
    lines.length,
    "trailer",
  );
  const headerMetadata = parseHeader(header, params.sourceFileName);
  const trailerRecordCount = parseTrailer(trailer, params.sourceFileName);
  const dataLines = lines.slice(1, -1);
  if (trailerRecordCount !== dataLines.length) {
    throw new Error(
      `${params.sourceFileName} trailer count ${trailerRecordCount} does not match ${dataLines.length} records`,
    );
  }
  const normalizedDataLines = dataLines.map((line, index) =>
    normalizeLineWidth(
      line,
      expectedLength,
      params.sourceFileName,
      index + 2,
      "data",
    ),
  );

  const common = {
    component: params.component,
    headerFileLabel: headerMetadata.fileLabel,
    runDate: headerMetadata.runDate,
    sourceArtifactUri: params.sourceArtifactUri,
    sourceFileName: params.sourceFileName,
    trailerRecordCount,
  };
  switch (params.component) {
    case "agent":
      return {
        ...common,
        component: "agent",
        records: normalizedDataLines.map((line, index) => ({
          ...parseAgentRecord(line, index + 2, params.sourceFileName),
          rawLine: dataLines[index] ?? line,
        })),
      };
    case "master":
      return {
        ...common,
        component: "master",
        records: normalizedDataLines.map((line, index) => ({
          ...parseMasterRecord(line, index + 2, params.sourceFileName),
          rawLine: dataLines[index] ?? line,
        })),
      };
    case "name":
      return {
        ...common,
        component: "name",
        records: normalizedDataLines.map((line, index) => ({
          ...parseNameRecord(line, index + 2, params.sourceFileName),
          rawLine: dataLines[index] ?? line,
        })),
      };
  }
}

/**
 * Join Master, Company Name, and Agent components by the official eight-digit
 * Illinois file number.
 *
 * @param params - Individually parsed component files from the same snapshot.
 * @returns Strict one-to-one joined snapshot in Master-file order.
 * @throws Error for run-date disagreement, duplicate keys, missing companions,
 * or companion rows with no Master.
 */
export function joinIllinoisSosCorporationSnapshot(params: {
  readonly agentFile: IllinoisSosParsedFile<IllinoisSosCorporationAgentRecord>;
  readonly masterFile: IllinoisSosParsedFile<IllinoisSosCorporationMasterRecord>;
  readonly nameFile: IllinoisSosParsedFile<IllinoisSosCorporationNameRecord>;
}): IllinoisSosCorporationSnapshot {
  const runDates = new Set([
    params.agentFile.runDate,
    params.masterFile.runDate,
    params.nameFile.runDate,
  ]);
  if (runDates.size !== 1) {
    throw new Error(`Illinois SOS component run dates do not match: ${[...runDates].join(", ")}`);
  }
  const names = indexUniqueRecords(params.nameFile.records, params.nameFile.sourceFileName);
  const agents = indexUniqueRecords(params.agentFile.records, params.agentFile.sourceFileName);
  const masters = indexUniqueRecords(params.masterFile.records, params.masterFile.sourceFileName);
  const corporations = params.masterFile.records.map((master) => {
    const name = names.get(master.fileNumber);
    const agent = agents.get(master.fileNumber);
    if (name === undefined || agent === undefined) {
      throw new Error(
        `Illinois file ${master.fileNumber} is missing ${name === undefined ? "Name" : "Agent"} data`,
      );
    }
    return { agent, master, name };
  });
  for (const fileNumber of names.keys()) {
    if (!masters.has(fileNumber)) {
      throw new Error(`Name row ${fileNumber} has no Master record`);
    }
  }
  for (const fileNumber of agents.keys()) {
    if (!masters.has(fileNumber)) {
      throw new Error(`Agent row ${fileNumber} has no Master record`);
    }
  }
  return {
    ...params,
    corporations,
    runDate: params.masterFile.runDate,
  };
}

/**
 * Map a validated Illinois corporation snapshot into the existing generic
 * business-registration logical tables.
 *
 * Sunbiz-only concepts such as FEI number, Florida filing codes, annual-report
 * slots, and Florida address selection flags are not synthesized. Officer
 * name/address composites remain role-labelled raw evidence in source_payload.
 *
 * @param snapshot - Joined official fixed-width snapshot.
 * @returns Dependency-ordered prepared rows suitable for idempotent upsert.
 */
export function mapIllinoisSosCorporationSnapshot(
  snapshot: IllinoisSosCorporationSnapshot,
): readonly PreparedRow[] {
  return snapshot.corporations.flatMap((corporation) =>
    mapJoinedCorporation(snapshot, corporation),
  );
}

/**
 * Upsert one joined Illinois snapshot through the shared source-hash guarded
 * PostgreSQL loader.
 *
 * @param client - Generic PostgreSQL-compatible query client.
 * @param snapshot - Joined snapshot to map and load.
 * @returns Changed/unchanged counters; an identical rerun is expected to report
 * all rows unchanged.
 */
export async function loadIllinoisSosCorporationSnapshot(
  client: QueryClient,
  snapshot: IllinoisSosCorporationSnapshot,
): Promise<BatchUpsertCounters> {
  return upsertPreparedRows(client, mapIllinoisSosCorporationSnapshot(snapshot));
}

/**
 * Build internal Rock Island address candidates only from agent records whose
 * official county code is 081.
 *
 * @param snapshot - Joined corporation snapshot.
 * @returns Registered-office candidates with explicit non-inference semantics.
 */
export function buildIllinoisSosRockIslandAddressCandidates(
  snapshot: IllinoisSosCorporationSnapshot,
): readonly IllinoisSosRockIslandAddressCandidate[] {
  return snapshot.corporations.flatMap((corporation) => {
    if (corporation.agent.agentCountyCode !== ROCK_ISLAND_COUNTY_CODE) return [];
    const address = buildAgentAddress(corporation.agent);
    if (address === null) return [];
    return [
      {
        addressRole: "registered_agent_office",
        canInferTenancyOrOwnership: false,
        entityName: corporation.name.entityName,
        illinoisFileNumber: corporation.master.fileNumber,
        normalizedAddressHash: address.normalizedAddressHash,
        normalizedAddressKey: address.normalizedAddressKey,
        snapshotDate: snapshot.runDate,
      },
    ];
  });
}

/**
 * Match role-aware Illinois candidates to appraisal addresses by normalized
 * address hash without creating ownership, tenancy, or occupancy links.
 *
 * @param candidates - Internal Illinois registered-office candidates.
 * @param appraisalAddresses - Rock Island property/address hash evidence.
 * @returns Candidates with one or more matching property IDs.
 */
export function matchIllinoisSosRockIslandCandidates(
  candidates: readonly IllinoisSosRockIslandAddressCandidate[],
  appraisalAddresses: readonly RockIslandAppraisalAddress[],
): readonly IllinoisSosRockIslandAddressMatch[] {
  const propertyIdsByHash = new Map<string, string[]>();
  for (const address of appraisalAddresses) {
    const existing = propertyIdsByHash.get(address.normalizedAddressHash) ?? [];
    existing.push(address.propertyId);
    propertyIdsByHash.set(address.normalizedAddressHash, existing);
  }
  return candidates.flatMap((candidate) => {
    const propertyIds = propertyIdsByHash.get(candidate.normalizedAddressHash);
    if (propertyIds === undefined || propertyIds.length === 0) return [];
    return [{
      ...candidate,
      matchedPropertyIds: [...new Set(propertyIds)].sort(),
      matchMethod: "normalized_address_hash",
    }];
  });
}

/**
 * Build entity-only candidates for a future public export privacy review.
 *
 * @param snapshot - Joined corporation snapshot.
 * @returns Non-approved candidates with no people, contacts, agents, officers,
 * or addresses.
 */
export function buildIllinoisSosPublicExportCandidates(
  snapshot: IllinoisSosCorporationSnapshot,
): readonly IllinoisSosPublicExportCandidate[] {
  return snapshot.corporations.map(({ master, name }) => ({
    businessIntentCode: master.businessIntentCode,
    corporationType: CORPORATION_TYPE_BY_CODE[master.corporationTypeCode] ?? null,
    corporationTypeCode: master.corporationTypeCode,
    entityName: name.entityName,
    illinoisFileNumber: master.fileNumber,
    incorporationDate: master.incorporationDate,
    lastTransactionDate: master.transactionDate,
    privacyReviewRequired: true,
    publicationApproved: false,
    snapshotDate: snapshot.runDate,
    sourceSystem: ILLINOIS_SOS_SOURCE_SYSTEM,
    status: STATUS_BY_CODE[master.statusCode] ?? null,
    statusCode: master.statusCode,
  }));
}

function mapJoinedCorporation(
  snapshot: IllinoisSosCorporationSnapshot,
  corporation: IllinoisSosJoinedCorporation,
): readonly PreparedRow[] {
  const { agent, master, name } = corporation;
  const rootKey = `${ILLINOIS_SOS_SOURCE_SYSTEM}:${master.fileNumber}`;
  const companyKey = `${rootKey}:company`;
  const registrationKey = `${rootKey}:business_registration`;
  const addressKey = `${rootKey}:address:registered_agent_office`;
  const address = buildAgentAddress(agent);
  const sourcePayload = {
    documentationUrl: ILLINOIS_SOS_CORP_DOCUMENTATION_URL,
    entityName: name.entityName,
    illinoisFileNumber: master.fileNumber,
    master,
    name,
    officerAddressEvidence: [
      buildOfficerEvidence("president_or_incorporator", master.presidentNameAddressRaw),
      buildOfficerEvidence("secretary_or_incorporator", master.secretaryNameAddressRaw),
    ],
    principalAddress: {
      parsingStatus: "not_present_in_corp_master_name_agent_components",
      role: "entity_principal" satisfies IllinoisSosAddressRole,
    },
    registeredAgent: agent,
    snapshotDate: snapshot.runDate,
  };
  const companyRow: PreparedRow = {
    tableName: "companies",
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: ILLINOIS_SOS_SOURCE_SYSTEM,
        sourceRecordKey: companyKey,
        sourcePayload,
        sourceArtifactUri: snapshot.nameFile.sourceArtifactUri,
      }),
      name: name.entityName,
      normalized_name: normalizeName(name.entityName),
      request_identifier: companyKey,
      source_payload: sourcePayload,
    }),
  };
  const registrationRow: PreparedRow = {
    tableName: "business_registrations",
    references: { companySourceRecordKey: companyKey },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: ILLINOIS_SOS_SOURCE_SYSTEM,
        sourceRecordKey: registrationKey,
        sourcePayload,
        sourceArtifactUri: snapshot.masterFile.sourceArtifactUri,
      }),
      document_number: master.fileNumber,
      entity_name: name.entityName,
      filed_date: master.incorporationDate,
      filing_type: CORPORATION_TYPE_BY_CODE[master.corporationTypeCode] ?? null,
      filing_type_code: master.corporationTypeCode,
      last_transaction_date: master.transactionDate,
      matched_address_roles: [],
      matched_zip_prefixes: [],
      parser_source: "illinois-sos-corp-fixed-width",
      raw_record_length: master.rawLine.length,
      request_identifier: registrationKey,
      schema_version: ILLINOIS_SOS_CORP_SCHEMA_VERSION,
      source_data_uri: snapshot.masterFile.sourceArtifactUri,
      source_file_name: snapshot.masterFile.sourceFileName,
      source_line_number: master.sourceLineNumber,
      source_payload: sourcePayload,
      status: STATUS_BY_CODE[master.statusCode] ?? null,
      status_code: master.statusCode,
    }),
  };
  if (address === null) return [companyRow, registrationRow];

  const addressPayload = {
    agent,
    canInferTenancyOrOwnership: false,
    illinoisFileNumber: master.fileNumber,
    snapshotDate: snapshot.runDate,
    sourceRole: "registered_agent_office" satisfies IllinoisSosAddressRole,
  };
  const addressRow: PreparedRow = {
    tableName: "addresses",
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: ILLINOIS_SOS_SOURCE_SYSTEM,
        sourceRecordKey: addressKey,
        sourcePayload: addressPayload,
        sourceArtifactUri: snapshot.agentFile.sourceArtifactUri,
      }),
      city_name: agent.agentCity,
      country_code: "US",
      county_name:
        agent.agentCountyCode === ROCK_ISLAND_COUNTY_CODE ? "Rock Island" : null,
      normalized_address_hash: address.normalizedAddressHash,
      normalized_address_key: address.normalizedAddressKey,
      plus_four_postal_code: agent.agentZipPlusFour,
      postal_code: agent.agentZip,
      request_identifier: addressKey,
      source_payload: addressPayload,
      state_code: "IL",
      unnormalized_address: address.singleLine,
    }),
  };
  const registrationAddressKey =
    `${rootKey}:business_registration_address:registered_agent_office`;
  const registrationAddressRow: PreparedRow = {
    tableName: "business_registration_addresses",
    references: {
      addressSourceRecordKey: addressKey,
      businessRegistrationDocumentNumber: master.fileNumber,
    },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: ILLINOIS_SOS_SOURCE_SYSTEM,
        sourceRecordKey: registrationAddressKey,
        sourcePayload: addressPayload,
        sourceArtifactUri: snapshot.agentFile.sourceArtifactUri,
      }),
      address_role: "registered_agent_office",
      city: agent.agentCity,
      country: "US",
      document_number: master.fileNumber,
      line_1: agent.agentStreet,
      matched_zip_prefixes: [],
      normalized: address.normalizedAddressKey,
      request_identifier: registrationAddressKey,
      single_line: address.singleLine,
      source_payload: addressPayload,
      state: "IL",
      zip: agent.agentZip,
    }),
  };
  if (agent.agentName === null) {
    return [addressRow, companyRow, registrationRow, registrationAddressRow];
  }
  const partyKey = `${rootKey}:party:registered_agent`;
  const registrationPartyRow: PreparedRow = {
    tableName: "business_registration_parties",
    references: {
      addressSourceRecordKey: addressKey,
      businessRegistrationDocumentNumber: master.fileNumber,
    },
    values: compactObject({
      ...buildSourceMetadata({
        sourceSystem: ILLINOIS_SOS_SOURCE_SYSTEM,
        sourceRecordKey: partyKey,
        sourcePayload: addressPayload,
        sourceArtifactUri: snapshot.agentFile.sourceArtifactUri,
      }),
      address_city: agent.agentCity,
      address_country: "US",
      address_line_1: agent.agentStreet,
      address_normalized: address.normalizedAddressKey,
      address_single_line: address.singleLine,
      address_state: "IL",
      address_zip: agent.agentZip,
      document_number: master.fileNumber,
      matched_zip_prefixes: [],
      name: agent.agentName,
      normalized_name: normalizeName(agent.agentName),
      party_role: "registered_agent",
      party_type_code: agent.agentCode,
      request_identifier: partyKey,
      source_payload: addressPayload,
    }),
  };
  return [
    addressRow,
    companyRow,
    registrationRow,
    registrationAddressRow,
    registrationPartyRow,
  ];
}

function parseMasterRecord(
  line: string,
  sourceLineNumber: number,
  sourceFileName: string,
): IllinoisSosCorporationMasterRecord {
  const validationIssues: IllinoisSosValidationIssue[] = [];
  const extendedFilingDate = parseOptionalCompactDate(
    readDigits(line, 16, 24, sourceFileName, sourceLineNumber),
    sourceFileName,
    sourceLineNumber,
    validationIssues,
    "extendedFilingDate",
  );
  const incorporationDate = parseOptionalCompactDate(
    readDigits(line, 8, 16, sourceFileName, sourceLineNumber),
    sourceFileName,
    sourceLineNumber,
    validationIssues,
    "incorporationDate",
  );
  const transactionDate = parseOptionalCompactDate(
    readDigits(line, 32, 40, sourceFileName, sourceLineNumber),
    sourceFileName,
    sourceLineNumber,
    validationIssues,
    "transactionDate",
  );
  return {
    businessIntentCode: readDigits(line, 26, 29, sourceFileName, sourceLineNumber),
    corporationTypeCode: readDigits(line, 31, 32, sourceFileName, sourceLineNumber),
    extendedFilingDate,
    fileNumber: readFileNumber(line, sourceFileName, sourceLineNumber),
    incorporationDate,
    originStateCode: readDigits(line, 24, 26, sourceFileName, sourceLineNumber),
    presidentNameAddressRaw: readText(line, 40, 100),
    rawLine: line,
    secretaryNameAddressRaw: readText(line, 100, 160),
    sourceLineNumber,
    statusCode: readDigits(line, 29, 31, sourceFileName, sourceLineNumber),
    transactionDate,
    ...(validationIssues.length > 0 ? { validationIssues } : {}),
  };
}

function parseNameRecord(
  line: string,
  sourceLineNumber: number,
  sourceFileName: string,
): IllinoisSosCorporationNameRecord {
  const entityName = readText(line, 8, 197);
  if (entityName === null) {
    throw new Error(`${sourceFileName}:${sourceLineNumber} has an empty corporation name`);
  }
  return {
    entityName,
    fileNumber: readFileNumber(line, sourceFileName, sourceLineNumber),
    rawLine: line,
    sourceLineNumber,
  };
}

function parseAgentRecord(
  line: string,
  sourceLineNumber: number,
  sourceFileName: string,
): IllinoisSosCorporationAgentRecord {
  const rawZip = readDigits(line, 152, 161, sourceFileName, sourceLineNumber);
  const hasZip = /^0+$/.test(rawZip) === false;
  const validationIssues: IllinoisSosValidationIssue[] = [];
  return {
    agentChangeDate: parseOptionalCompactDate(
      readDigits(line, 143, 151, sourceFileName, sourceLineNumber),
      sourceFileName,
      sourceLineNumber,
      validationIssues,
      "agentChangeDate",
    ),
    agentCity: readText(line, 113, 143),
    agentCode: line.slice(151, 152),
    agentCountyCode: readDigits(line, 161, 164, sourceFileName, sourceLineNumber),
    agentName: readText(line, 8, 68),
    agentStreet: readText(line, 68, 113),
    agentZip: hasZip ? rawZip.slice(0, 5) : null,
    agentZipPlusFour:
      hasZip && /^0+$/.test(rawZip.slice(5)) === false ? rawZip.slice(5) : null,
    fileNumber: readFileNumber(line, sourceFileName, sourceLineNumber),
    rawLine: line,
    sourceLineNumber,
    ...(validationIssues.length > 0 ? { validationIssues } : {}),
  };
}

function splitFixedWidthLines(contents: string): readonly string[] {
  const normalized = contents.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0)) {
    throw new Error("Illinois SOS fixed-width files cannot contain blank records");
  }
  return lines;
}

function parseHeader(
  line: string,
  sourceFileName: string,
): { readonly fileLabel: string; readonly runDate: string } {
  const match = /^RUN DATE\s*=\s*(\d{8})\s+FILE:\s*(.+)$/.exec(line.trimEnd());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${sourceFileName} has an invalid RUN DATE header`);
  }
  const runDate = parseOptionalCompactDate(match[1], sourceFileName, 1);
  if (runDate === null) {
    throw new Error(`${sourceFileName} header run date cannot be zero or all nines`);
  }
  return { fileLabel: match[2].trim(), runDate };
}

function parseTrailer(line: string, sourceFileName: string): number {
  const match = /^END OF FILE RECORD COUNT=\s*(\d{7})\s*$/.exec(line);
  if (match?.[1] === undefined) {
    throw new Error(`${sourceFileName} has an invalid END OF FILE trailer`);
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Pad a right-trimmed portal line to its documented field width.
 *
 * Illinois SOS currently emits records with trailing spaces removed even
 * though the format document describes fixed-width lines. Overlong lines are
 * still rejected because padding cannot safely repair shifted field positions.
 *
 * @param line - Unmodified source line.
 * @param expectedLength - Documented component width.
 * @param sourceFileName - Source filename used in validation errors.
 * @param sourceLineNumber - One-based source line number.
 * @param kind - Control or data-record role.
 * @returns Line padded on the right to the documented width.
 */
function normalizeLineWidth(
  line: string,
  expectedLength: number,
  sourceFileName: string,
  sourceLineNumber: number,
  kind: "data" | "header" | "trailer",
): string {
  if (line.length > expectedLength) {
    throw new Error(
      `${sourceFileName}:${sourceLineNumber} ${kind} record has width ${line.length}; exceeds ${expectedLength}`,
    );
  }
  return line.padEnd(expectedLength, " ");
}

function readFileNumber(
  line: string,
  sourceFileName: string,
  sourceLineNumber: number,
): string {
  const fileNumber = readDigits(line, 0, 8, sourceFileName, sourceLineNumber);
  if (/^0+$/.test(fileNumber)) {
    throw new Error(`${sourceFileName}:${sourceLineNumber} has an invalid zero file number`);
  }
  return fileNumber;
}

function readDigits(
  line: string,
  start: number,
  end: number,
  sourceFileName: string,
  sourceLineNumber: number,
): string {
  const value = line.slice(start, end);
  if (/^\d+$/.test(value) === false) {
    throw new Error(
      `${sourceFileName}:${sourceLineNumber} positions ${start + 1}-${end} must be numeric`,
    );
  }
  return value;
}

function readText(line: string, start: number, end: number): string | null {
  const value = line.slice(start, end).trim();
  return value.length > 0 ? value : null;
}

/**
 * Parse one optional compact source date with explicit anomaly retention.
 *
 * Zeroes and nines represent absent dates. Control-record callers omit the
 * issue collector and continue to fail on invalid calendar dates. Data-record
 * callers provide both optional arguments so a legacy invalid date becomes
 * null while its field and raw value remain available for audit.
 *
 * @param value - Eight numeric CCYYMMDD characters.
 * @param sourceFileName - Source filename used in validation errors.
 * @param sourceLineNumber - One-based source line number.
 * @param validationIssues - Optional mutable collector for non-fatal anomalies.
 * @param fieldName - Source field associated with a collected anomaly.
 * @returns ISO date, or null for absent or retained invalid source dates.
 */
function parseOptionalCompactDate(
  value: string,
  sourceFileName: string,
  sourceLineNumber: number,
  validationIssues?: IllinoisSosValidationIssue[],
  fieldName?: IllinoisSosDateField,
): string | null {
  if (/^0+$/.test(value) || /^9+$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    if (validationIssues !== undefined && fieldName !== undefined) {
      validationIssues.push({
        code: "invalid_calendar_date",
        fieldName,
        rawValue: value,
      });
      return null;
    }
    throw new Error(
      `${sourceFileName}:${sourceLineNumber} contains invalid CCYYMMDD date ${value}`,
    );
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function indexUniqueRecords<RecordType extends IllinoisSosSourceRecord>(
  records: readonly RecordType[],
  sourceFileName: string,
): ReadonlyMap<string, RecordType> {
  const indexed = new Map<string, RecordType>();
  for (const record of records) {
    if (indexed.has(record.fileNumber)) {
      throw new Error(`${sourceFileName} has duplicate file number ${record.fileNumber}`);
    }
    indexed.set(record.fileNumber, record);
  }
  return indexed;
}

function buildOfficerEvidence(
  role: "president_or_incorporator" | "secretary_or_incorporator",
  rawNameAddress: string | null,
): {
  readonly addressRole: "officer_raw";
  readonly parsingStatus: "unsplit_official_fixed_width_field";
  readonly rawNameAddress: string | null;
  readonly role: typeof role;
} {
  return {
    addressRole: "officer_raw",
    parsingStatus: "unsplit_official_fixed_width_field",
    rawNameAddress,
    role,
  };
}

function buildAgentAddress(agent: IllinoisSosCorporationAgentRecord): {
  readonly normalizedAddressHash: string;
  readonly normalizedAddressKey: string;
  readonly singleLine: string;
} | null {
  if (agent.agentStreet === null || agent.agentCity === null) return null;
  const postalCode =
    agent.agentZip === null
      ? null
      : `${agent.agentZip}${agent.agentZipPlusFour === null ? "" : `-${agent.agentZipPlusFour}`}`;
  const singleLine = [agent.agentStreet, agent.agentCity, "IL", postalCode]
    .filter((part): part is string => part !== null)
    .join(" ");
  const normalizedAddressKey = buildNormalizedAddressKey(singleLine);
  const normalizedAddressHash = hashNormalizedAddressKey(normalizedAddressKey);
  if (normalizedAddressKey === null || normalizedAddressHash === null) return null;
  return { normalizedAddressHash, normalizedAddressKey, singleLine };
}
