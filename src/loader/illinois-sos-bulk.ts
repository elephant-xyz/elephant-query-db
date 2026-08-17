import {
  buildSourceMetadata,
  compactObject,
} from "./normalizers.js";
import { upsertPreparedRows } from "./sql.js";
import type {
  BatchUpsertCounters,
  JsonObject,
  PreparedRow,
  QueryClient,
} from "./types.js";

export const ILLINOIS_SOS_CORPORATION_DOCUMENTATION_URL =
  "https://www.ilsos.gov/content/dam/data/bs/proc_corp_data.pdf";
export const ILLINOIS_SOS_LLC_DOCUMENTATION_URL =
  "https://www.ilsos.gov/content/dam/data/bs/proc_llc_data.pdf";

export type IllinoisSosBulkEntityKind = "corporation" | "llc";
export type IllinoisSosCorporationSupplementalComponent =
  | "annual_report"
  | "assumed_old_name"
  | "other"
  | "stock";
export type IllinoisSosLlcComponent =
  | "agent"
  | "annual_report"
  | "assumed_name"
  | "manager_member"
  | "master"
  | "name"
  | "old_name"
  | "series_name";
export type IllinoisSosBulkComponent =
  | IllinoisSosCorporationSupplementalComponent
  | IllinoisSosLlcComponent;

type IllinoisSosFieldKind = "date" | "numeric" | "text";

/**
 * One documented fixed-width field. Positions are one-based and inclusive,
 * matching the official Illinois SOS manuals.
 */
export type IllinoisSosBulkFieldSpec = {
  readonly end: number;
  readonly kind: IllinoisSosFieldKind;
  readonly name: string;
  readonly start: number;
};

/**
 * Public parser contract for one official Corporation or LLC component.
 */
export type IllinoisSosBulkComponentSpec = {
  readonly component: IllinoisSosBulkComponent;
  readonly documentationUrl: string;
  readonly entityKind: IllinoisSosBulkEntityKind;
  readonly fields: readonly IllinoisSosBulkFieldSpec[];
  readonly recordLength: number;
};

/**
 * Parsed private source evidence from one component record.
 */
export type IllinoisSosBulkRecord = {
  readonly fields: JsonObject;
  readonly fileNumber: string;
  readonly rawLine: string;
  readonly sourceLineNumber: number;
};

/**
 * One independently dated official component file.
 */
export type IllinoisSosParsedBulkComponentFile = {
  readonly component: IllinoisSosBulkComponent;
  readonly documentationUrl: string;
  readonly entityKind: IllinoisSosBulkEntityKind;
  readonly headerFileLabel: string;
  readonly records: readonly IllinoisSosBulkRecord[];
  readonly recordLength: number;
  readonly runDate: string;
  readonly sourceArtifactUri: string;
  readonly sourceFileName: string;
  readonly trailerRecordCount: number;
};

export type IllinoisSosBulkJoinedRecord = {
  readonly component: IllinoisSosBulkComponent;
  readonly record: IllinoisSosBulkRecord;
  readonly runDate: string;
  readonly sourceArtifactUri: string;
  readonly sourceFileName: string;
};

export type IllinoisSosBulkEntityEvidence = {
  readonly components: readonly IllinoisSosBulkJoinedRecord[];
  readonly entityKind: IllinoisSosBulkEntityKind;
  readonly fileNumber: string;
};

const CORPORATION_SUPPLEMENTAL_SPECS: readonly IllinoisSosBulkComponentSpec[] = [
  {
    component: "annual_report",
    documentationUrl: ILLINOIS_SOS_CORPORATION_DOCUMENTATION_URL,
    entityKind: "corporation",
    recordLength: 126,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("current_factor", 9, 15, "numeric"),
      field("current_paid_amount", 16, 24, "numeric"),
      field("current_annual_report_capital", 25, 35, "numeric"),
      field("current_delinquent_run_date", 36, 43, "date"),
      field("current_run_date", 44, 51, "date"),
      field("current_paid_batch_number", 52, 55, "numeric"),
      field("current_paid_batch_year", 56, 59, "numeric"),
      field("current_paid_date", 60, 67, "date"),
      field("previous_factor", 68, 74, "numeric"),
      field("previous_paid_amount", 75, 83, "numeric"),
      field("previous_capital", 84, 94, "numeric"),
      field("previous_delinquent_run_date", 95, 102, "date"),
      field("previous_run_date", 103, 110, "date"),
      field("previous_paid_batch_number", 111, 114, "numeric"),
      field("previous_paid_batch_year", 115, 118, "numeric"),
      field("previous_paid_date", 119, 126, "date"),
    ],
  },
  {
    component: "assumed_old_name",
    documentationUrl: ILLINOIS_SOS_CORPORATION_DOCUMENTATION_URL,
    entityKind: "corporation",
    recordLength: 222,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("cancellation_date", 9, 16, "date"),
      field("current_date", 17, 24, "date"),
      field("assumed_old_indicator", 25, 25, "numeric"),
      field("assumed_old_date", 26, 33, "date"),
      field("assumed_old_name", 34, 222, "text"),
    ],
  },
  {
    component: "stock",
    documentationUrl: ILLINOIS_SOS_CORPORATION_DOCUMENTATION_URL,
    entityKind: "corporation",
    recordLength: 101,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("stock_class", 9, 33, "text"),
      field("stock_series", 34, 58, "text"),
      field("voting_rights", 59, 59, "text"),
      field("authorized_shares", 60, 72, "numeric"),
      field("issued_shares", 73, 88, "numeric"),
      field("par_value", 89, 101, "numeric"),
    ],
  },
  {
    component: "other",
    documentationUrl: ILLINOIS_SOS_CORPORATION_DOCUMENTATION_URL,
    entityKind: "corporation",
    recordLength: 127,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("hold_prorate_indicator", 9, 9, "numeric"),
      field("regulated_indicator", 10, 10, "numeric"),
      field("record_name_length_indicator", 11, 11, "numeric"),
      field("records_destroyed_indicator", 12, 12, "numeric"),
      field("capital_date", 13, 20, "date"),
      field("increase_letter_indicator", 21, 21, "numeric"),
      field("ab_initio_indicator", 22, 22, "numeric"),
      field("assumed_old_indicator", 23, 23, "numeric"),
      field("duration_date", 24, 31, "date"),
      field("total_capital", 32, 44, "numeric"),
      field("tax_capital", 45, 57, "numeric"),
      field("illinois_capital", 58, 68, "numeric"),
      field("current_new_illinois_capital", 69, 79, "numeric"),
      field("previous_illinois_capital", 80, 90, "numeric"),
      field("fiscal_year", 91, 98, "date"),
      field("section_code", 99, 102, "numeric"),
      field("stock_date", 103, 110, "date"),
      field("revenue_indicator", 111, 111, "numeric"),
      field("surviving_file_number", 112, 119, "numeric"),
      field("date_last_changed", 120, 127, "date"),
    ],
  },
];

const LLC_SPECS: readonly IllinoisSosBulkComponentSpec[] = [
  {
    component: "master",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 136,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("purpose_code", 9, 14, "numeric"),
      field("status_code", 15, 16, "numeric"),
      field("status_date", 17, 24, "date"),
      field("organized_date", 25, 32, "date"),
      field("dissolution_date", 33, 40, "date"),
      field("management_type", 41, 41, "numeric"),
      field("jurisdiction_organized", 42, 43, "text"),
      field("records_office_street", 44, 88, "text"),
      field("records_office_city", 89, 118, "text"),
      field("records_office_zip", 119, 127, "text"),
      field("records_office_jurisdiction", 128, 129, "text"),
      field("assumed_name_indicator", 130, 130, "numeric"),
      field("old_name_indicator", 131, 131, "numeric"),
      field("provisions_indicator", 132, 132, "numeric"),
      field("optional_indicator", 133, 133, "numeric"),
      field("series_indicator", 134, 134, "text"),
      field("uap_indicator", 135, 135, "text"),
      field("l3c_indicator", 136, 136, "text"),
    ],
  },
  {
    component: "name",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 128,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("llc_name", 9, 128, "text"),
    ],
  },
  {
    component: "agent",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 164,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("agent_code", 9, 9, "text"),
      field("agent_name", 10, 69, "text"),
      field("agent_street", 70, 114, "text"),
      field("agent_city", 115, 144, "text"),
      field("agent_zip", 145, 153, "numeric"),
      field("agent_county_code", 154, 156, "numeric"),
      field("agent_change_date", 157, 164, "date"),
    ],
  },
  {
    component: "annual_report",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 74,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("current_mail_date", 9, 16, "date"),
      field("current_file_date", 17, 24, "date"),
      field("current_delinquent_date", 25, 32, "date"),
      field("current_paid_amount", 33, 37, "numeric"),
      field("current_year_due", 38, 41, "numeric"),
      field("previous_mail_date", 42, 49, "date"),
      field("previous_file_date", 50, 57, "date"),
      field("previous_delinquent_date", 58, 65, "date"),
      field("previous_paid_amount", 66, 70, "numeric"),
      field("previous_year_due", 71, 74, "numeric"),
    ],
  },
  {
    component: "assumed_name",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 281,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("adoption_date", 9, 16, "date"),
      field("cancellation_date", 17, 24, "date"),
      field("cancellation_code", 25, 25, "numeric"),
      field("renewal_year", 26, 29, "numeric"),
      field("renewal_date", 30, 37, "date"),
      field("assumed_indicator", 38, 38, "numeric"),
      field("llc_name", 39, 278, "text"),
      field("series_number", 279, 281, "numeric"),
    ],
  },
  {
    component: "old_name",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 139,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("date_filed", 9, 16, "date"),
      field("llc_name", 17, 136, "text"),
      field("series_number", 137, 139, "numeric"),
    ],
  },
  {
    component: "manager_member",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 163,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("manager_member_name", 9, 68, "text"),
      field("manager_member_street", 69, 113, "text"),
      field("manager_member_city", 114, 143, "text"),
      field("manager_member_jurisdiction", 144, 145, "text"),
      field("manager_member_zip", 146, 154, "text"),
      field("manager_member_file_date", 155, 162, "date"),
      field("manager_member_type_code", 163, 163, "numeric"),
    ],
  },
  {
    component: "series_name",
    documentationUrl: ILLINOIS_SOS_LLC_DOCUMENTATION_URL,
    entityKind: "llc",
    recordLength: 277,
    fields: [
      field("file_number", 1, 8, "numeric"),
      field("series_number", 9, 11, "numeric"),
      field("series_status", 12, 13, "numeric"),
      field("status_date", 14, 21, "date"),
      field("begin_date", 22, 29, "date"),
      field("dissolution_date", 30, 37, "date"),
      field("series_name", 38, 277, "text"),
    ],
  },
];

export const ILLINOIS_SOS_BULK_COMPONENT_SPECS:
  readonly IllinoisSosBulkComponentSpec[] = [
    ...CORPORATION_SUPPLEMENTAL_SPECS,
    ...LLC_SPECS,
  ];

/**
 * Parse one official Illinois SOS supplemental Corporation or LLC bulk file.
 *
 * Files remain independently dated; this parser does not require component
 * run dates to agree. Original lines and artifact provenance are retained for
 * private audit, while parsed fields follow the exact official positions.
 *
 * @param params - Entity/component identity, source bytes, and local provenance.
 * @returns Validated records with official run date and record count.
 */
export function parseIllinoisSosBulkComponentFile(params: {
  readonly component: IllinoisSosBulkComponent;
  readonly contents: string;
  readonly entityKind: IllinoisSosBulkEntityKind;
  readonly sourceArtifactUri: string;
  readonly sourceFileName: string;
}): IllinoisSosParsedBulkComponentFile {
  const spec = getComponentSpec(params.entityKind, params.component);
  const lines = splitLines(params.contents);
  if (lines.length < 2) {
    throw new Error(`${params.sourceFileName} must contain a header and trailer`);
  }
  const header = lines[0];
  const trailer = lines.at(-1);
  if (header === undefined || trailer === undefined) {
    throw new Error(`${params.sourceFileName} is missing control records`);
  }
  normalizeWidth(header, spec.recordLength, params.sourceFileName, 1, "header");
  normalizeWidth(
    trailer,
    spec.recordLength,
    params.sourceFileName,
    lines.length,
    "trailer",
  );
  const headerMetadata = parseControlHeader(header, params.sourceFileName);
  const trailerRecordCount = parseControlTrailer(trailer, params.sourceFileName);
  const dataLines = lines.slice(1, -1);
  if (dataLines.length !== trailerRecordCount) {
    throw new Error(
      `${params.sourceFileName} trailer count ${trailerRecordCount} does not match ${dataLines.length} records`,
    );
  }
  const records = dataLines.map((rawLine, index) => {
    const sourceLineNumber = index + 2;
    const line = normalizeWidth(
      rawLine,
      spec.recordLength,
      params.sourceFileName,
      sourceLineNumber,
      "data",
    );
    const fields = parseFields(line, spec.fields, params.sourceFileName, sourceLineNumber);
    const fileNumber = fields["file_number"];
    if (typeof fileNumber !== "string" || /^0+$/.test(fileNumber)) {
      throw new Error(
        `${params.sourceFileName}:${sourceLineNumber} has an invalid file number`,
      );
    }
    return { fields, fileNumber, rawLine, sourceLineNumber };
  });
  return {
    component: params.component,
    documentationUrl: spec.documentationUrl,
    entityKind: params.entityKind,
    headerFileLabel: headerMetadata.fileLabel,
    recordLength: spec.recordLength,
    records,
    runDate: headerMetadata.runDate,
    sourceArtifactUri: params.sourceArtifactUri,
    sourceFileName: params.sourceFileName,
    trailerRecordCount,
  };
}

/**
 * Group independently dated component records by the official file number.
 *
 * Corporation and LLC number spaces are deliberately namespaced by entity
 * kind because Illinois can assign the same eight-digit value in both spaces.
 * Repeating components remain arrays because assumed names, managers/members,
 * series, and stock can have multiple rows for one entity.
 *
 * @param files - Validated official component files in any order.
 * @returns Stable entity groups and source records sorted deterministically.
 */
export function joinIllinoisSosBulkComponentEvidence(
  files: readonly IllinoisSosParsedBulkComponentFile[],
): readonly IllinoisSosBulkEntityEvidence[] {
  const groups = new Map<string, IllinoisSosBulkJoinedRecord[]>();
  for (const file of files) {
    for (const record of file.records) {
      const key = `${file.entityKind}:${record.fileNumber}`;
      const entries = groups.get(key) ?? [];
      entries.push({
        component: file.component,
        record,
        runDate: file.runDate,
        sourceArtifactUri: file.sourceArtifactUri,
        sourceFileName: file.sourceFileName,
      });
      groups.set(key, entries);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, components]) => {
      const separator = key.indexOf(":");
      const entityKind = key.slice(0, separator);
      const fileNumber = key.slice(separator + 1);
      if (entityKind !== "corporation" && entityKind !== "llc") {
        throw new Error(`Invalid grouped Illinois SOS key ${key}`);
      }
      return {
        components: [...components].sort(
          (left, right) =>
            left.component.localeCompare(right.component) ||
            left.runDate.localeCompare(right.runDate) ||
            left.record.sourceLineNumber - right.record.sourceLineNumber,
        ),
        entityKind,
        fileNumber,
      };
    });
}

/**
 * Map private component evidence to source-hash-guarded rows.
 *
 * No component field is copied into a public company, address, or relationship
 * table. Publication is constrained false in both the row and database schema.
 *
 * @param file - One validated independently dated source component.
 * @returns Prepared private evidence rows.
 */
export function mapIllinoisSosBulkComponentFile(
  file: IllinoisSosParsedBulkComponentFile,
): readonly PreparedRow[] {
  return file.records.map((record) => {
    const sourceRecordKey = [
      "illinois_sos",
      file.entityKind,
      file.component,
      file.runDate,
      record.fileNumber,
      record.sourceLineNumber,
    ].join(":");
    const sourcePayload = {
      component: file.component,
      documentationUrl: file.documentationUrl,
      entityKind: file.entityKind,
      fields: record.fields,
      fileNumber: record.fileNumber,
      privacyClassification: "private_non_publishable",
      publicationApproved: false,
      rawLine: record.rawLine,
      runDate: file.runDate,
      sourceFileName: file.sourceFileName,
      sourceLineNumber: record.sourceLineNumber,
    };
    return {
      tableName: "illinois_sos_component_records",
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem: "illinois_sos",
          sourceRecordKey,
          sourcePayload,
          sourceArtifactUri: file.sourceArtifactUri,
        }),
        component: file.component,
        entity_kind: file.entityKind,
        file_number: record.fileNumber,
        privacy_classification: "private_non_publishable",
        publication_approved: false,
        record_fields: record.fields,
        snapshot_date: file.runDate,
        source_file_name: file.sourceFileName,
        source_line_number: record.sourceLineNumber,
        source_payload: sourcePayload,
      }),
    };
  });
}

/**
 * Idempotently load a validated private component file.
 *
 * @param client - PostgreSQL-compatible loader query client.
 * @param file - Validated official component file.
 * @returns Changed/unchanged counters from source-hash guarded upserts.
 */
export async function loadIllinoisSosBulkComponentFile(
  client: QueryClient,
  file: IllinoisSosParsedBulkComponentFile,
): Promise<BatchUpsertCounters> {
  return upsertPreparedRows(client, mapIllinoisSosBulkComponentFile(file));
}

function field(
  name: string,
  start: number,
  end: number,
  kind: IllinoisSosFieldKind,
): IllinoisSosBulkFieldSpec {
  return { end, kind, name, start };
}

function getComponentSpec(
  entityKind: IllinoisSosBulkEntityKind,
  component: IllinoisSosBulkComponent,
): IllinoisSosBulkComponentSpec {
  const spec = ILLINOIS_SOS_BULK_COMPONENT_SPECS.find(
    (candidate) =>
      candidate.entityKind === entityKind && candidate.component === component,
  );
  if (spec === undefined) {
    throw new Error(
      `Unsupported Illinois SOS component ${entityKind}:${component}`,
    );
  }
  return spec;
}

function parseFields(
  line: string,
  specs: readonly IllinoisSosBulkFieldSpec[],
  sourceFileName: string,
  sourceLineNumber: number,
): JsonObject {
  const fields: JsonObject = {};
  for (const spec of specs) {
    const rawValue = line.slice(spec.start - 1, spec.end);
    const value = rawValue.trim();
    if (spec.kind === "text") {
      fields[spec.name] = value.length > 0 ? value : null;
      continue;
    }
    if (value.length === 0 || /^\d+$/.test(value) === false) {
      throw new Error(
        `${sourceFileName}:${sourceLineNumber} ${spec.name} positions ${spec.start}-${spec.end} must be numeric`,
      );
    }
    fields[spec.name] =
      spec.kind === "date"
        ? parseSourceDate(value, sourceFileName, sourceLineNumber, spec.name)
        : value;
  }
  return fields;
}

function parseSourceDate(
  value: string,
  sourceFileName: string,
  sourceLineNumber: number,
  fieldName: string,
): string | null {
  if (/^0+$/.test(value) || /^9+$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    value.length !== 8 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(
      `${sourceFileName}:${sourceLineNumber} ${fieldName} has invalid CCYYMMDD date ${value}`,
    );
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function splitLines(contents: string): readonly string[] {
  const normalized = contents.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0)) {
    throw new Error("Illinois SOS fixed-width files cannot contain blank records");
  }
  return lines;
}

function normalizeWidth(
  line: string,
  expectedLength: number,
  sourceFileName: string,
  sourceLineNumber: number,
  recordKind: "data" | "header" | "trailer",
): string {
  if (line.length > expectedLength) {
    throw new Error(
      `${sourceFileName}:${sourceLineNumber} ${recordKind} record has width ${line.length}; exceeds ${expectedLength}`,
    );
  }
  return line.padEnd(expectedLength, " ");
}

function parseControlHeader(
  line: string,
  sourceFileName: string,
): { readonly fileLabel: string; readonly runDate: string } {
  const match = /^RUN DATE\s*=\s*(\d{8})\s+FILE:\s*(.+)$/u.exec(
    line.trimEnd(),
  );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${sourceFileName} has an invalid RUN DATE header`);
  }
  const runDate = parseSourceDate(match[1], sourceFileName, 1, "run_date");
  if (runDate === null) {
    throw new Error(`${sourceFileName} header run date cannot be empty`);
  }
  return { fileLabel: match[2].trim(), runDate };
}

function parseControlTrailer(line: string, sourceFileName: string): number {
  const match = /^END OF FILE RECORD COUNT=\s*(\d{7})\s*$/u.exec(line);
  if (match?.[1] === undefined) {
    throw new Error(`${sourceFileName} has an invalid END OF FILE trailer`);
  }
  return Number.parseInt(match[1], 10);
}
