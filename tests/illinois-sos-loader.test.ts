import { describe, expect, it } from "vitest";

import {
  buildIllinoisSosPublicExportCandidates,
  buildIllinoisSosRockIslandAddressCandidates,
  joinIllinoisSosCorporationSnapshot,
  loadIllinoisSosCorporationSnapshot,
  mapIllinoisSosCorporationSnapshot,
  matchIllinoisSosRockIslandCandidates,
  parseIllinoisSosCorporationFile,
  type IllinoisSosCorporationAgentRecord,
  type IllinoisSosCorporationMasterRecord,
  type IllinoisSosCorporationNameRecord,
  type IllinoisSosParsedFile,
  type JsonObject,
  type QueryClient,
  type QueryRowsResult,
} from "../src/loader/index.js";

const FILE_NUMBER = "12345678";
const RUN_DATE = "2026-08-13";
const RUN_DATE_COMPACT = "20260813";

describe("Illinois SOS fixed-width pilot", () => {
  it("parses fixed-width headers, trailers, and official field positions", () => {
    const master = parseMaster();
    const name = parseName();
    const agent = parseAgent();

    expect(master.runDate).toBe(RUN_DATE);
    expect(master.trailerRecordCount).toBe(1);
    expect(master.records[0]).toMatchObject({
      businessIntentCode: "012",
      corporationTypeCode: "4",
      fileNumber: FILE_NUMBER,
      incorporationDate: "2020-01-02",
      statusCode: "00",
      transactionDate: "2026-07-01",
    });
    expect(name.records[0]?.entityName).toBe("SYNTHETIC RIVER INDUSTRIES INC");
    expect(agent.records[0]).toMatchObject({
      agentCity: "MOLINE",
      agentCountyCode: "081",
      agentName: "SYNTHETIC REGISTERED AGENT CO",
      agentStreet: "100 TEST DATA AVE",
      agentZip: "61265",
      agentZipPlusFour: "1234",
    });
  });

  it("parses portal records with trailing spaces removed", () => {
    const rawRecord = buildMasterRecord().trimEnd();
    const parsed = parseIllinoisSosCorporationFile({
      component: "master",
      contents: [
        "RUN DATE=20260729   FILE:CORP MASTER DATA",
        rawRecord,
        "END OF FILE RECORD COUNT= 0000001",
      ].join("\r\n"),
      sourceArtifactUri: "file:///synthetic/cdxallmst.txt",
      sourceFileName: "cdxallmst.txt",
    });

    expect(parsed.runDate).toBe("2026-07-29");
    expect(parsed.headerFileLabel).toBe("CORP MASTER DATA");
    expect(parsed.records[0]).toMatchObject({
      fileNumber: FILE_NUMBER,
      rawLine: rawRecord,
      statusCode: "00",
    });
  });

  it("retains a warning instead of dropping a legacy invalid source date", () => {
    const rawRecord = writeField(
      buildMasterRecord(),
      8,
      16,
      "19910229",
    ).trimEnd();
    const parsed = parseIllinoisSosCorporationFile({
      component: "master",
      contents: [
        "RUN DATE=20260729   FILE:CORP MASTER DATA",
        rawRecord,
        "END OF FILE RECORD COUNT= 0000001",
      ].join("\n"),
      sourceArtifactUri: "file:///synthetic/cdxallmst.txt",
      sourceFileName: "cdxallmst.txt",
    });

    expect(parsed.records[0]).toMatchObject({
      incorporationDate: null,
      rawLine: rawRecord,
      validationIssues: [
        {
          code: "invalid_calendar_date",
          fieldName: "incorporationDate",
          rawValue: "19910229",
        },
      ],
    });
  });

  it("rejects overlong widths, control counts, numeric fields, and blank records", () => {
    const validRow = buildMasterRecord();
    expect(() =>
      parseIllinoisSosCorporationFile({
        component: "master",
        contents: buildFixedWidthFile("CORPMASTER", 160, [`${validRow}X`]),
        sourceArtifactUri: "file:///synthetic/master.txt",
        sourceFileName: "master.txt",
      }),
    ).toThrow("width 161; exceeds 160");
    expect(() =>
      parseIllinoisSosCorporationFile({
        component: "master",
        contents: buildFixedWidthFile("CORPMASTER", 160, [validRow], 2),
        sourceArtifactUri: "file:///synthetic/master.txt",
        sourceFileName: "master.txt",
      }),
    ).toThrow("trailer count 2 does not match 1 records");
    expect(() =>
      parseIllinoisSosCorporationFile({
        component: "master",
        contents: buildFixedWidthFile(
          "CORPMASTER",
          160,
          [`X${validRow.slice(1)}`],
        ),
        sourceArtifactUri: "file:///synthetic/master.txt",
        sourceFileName: "master.txt",
      }),
    ).toThrow("positions 1-8 must be numeric");
    expect(() =>
      parseIllinoisSosCorporationFile({
        component: "master",
        contents: `${buildFixedWidthFile("CORPMASTER", 160, [validRow])}\n\n`,
        sourceArtifactUri: "file:///synthetic/master.txt",
        sourceFileName: "master.txt",
      }),
    ).toThrow("cannot contain blank records");
  });

  it("joins components strictly by Illinois file number", () => {
    const snapshot = buildSnapshot();

    expect(snapshot.corporations).toHaveLength(1);
    expect(snapshot.corporations[0]).toMatchObject({
      agent: { fileNumber: FILE_NUMBER },
      master: { fileNumber: FILE_NUMBER },
      name: { fileNumber: FILE_NUMBER },
    });

    const unmatchedAgent = parseAgent("87654321");
    expect(() =>
      joinIllinoisSosCorporationSnapshot({
        agentFile: unmatchedAgent,
        masterFile: parseMaster(),
        nameFile: parseName(),
      }),
    ).toThrow(`Illinois file ${FILE_NUMBER} is missing Agent data`);
  });

  it("preserves role-aware evidence without inventing principal or ownership links", () => {
    const snapshot = buildSnapshot();
    const rows = mapIllinoisSosCorporationSnapshot(snapshot);
    const registration = rows.find(
      (row) => row.tableName === "business_registrations",
    );
    const address = rows.find(
      (row) => row.tableName === "business_registration_addresses",
    );
    const party = rows.find(
      (row) => row.tableName === "business_registration_parties",
    );
    const payload = registration?.values.source_payload;

    expect(address?.values.address_role).toBe("registered_agent_office");
    expect(party?.values.party_role).toBe("registered_agent");
    expect(payload).toMatchObject({
      officerAddressEvidence: [
        {
          addressRole: "officer_raw",
          parsingStatus: "unsplit_official_fixed_width_field",
          role: "president_or_incorporator",
        },
        {
          addressRole: "officer_raw",
          parsingStatus: "unsplit_official_fixed_width_field",
          role: "secretary_or_incorporator",
        },
      ],
      principalAddress: {
        parsingStatus: "not_present_in_corp_master_name_agent_components",
        role: "entity_principal",
      },
    });
    expect(rows.some((row) => row.tableName === "ownerships")).toBe(false);
    expect(rows.some((row) => row.tableName === "properties")).toBe(false);
  });

  it("matches Rock Island registered-office candidates by address hash only", () => {
    const candidates = buildIllinoisSosRockIslandAddressCandidates(buildSnapshot());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      addressRole: "registered_agent_office",
      canInferTenancyOrOwnership: false,
      illinoisFileNumber: FILE_NUMBER,
    });
    const hash = candidates[0]?.normalizedAddressHash;
    if (hash === undefined) throw new Error("expected one synthetic address candidate");

    const matches = matchIllinoisSosRockIslandCandidates(candidates, [
      { normalizedAddressHash: hash, propertyId: "property-2" },
      { normalizedAddressHash: hash, propertyId: "property-1" },
      { normalizedAddressHash: "not-a-match", propertyId: "property-3" },
    ]);

    expect(matches).toEqual([
      expect.objectContaining({
        canInferTenancyOrOwnership: false,
        matchedPropertyIds: ["property-1", "property-2"],
        matchMethod: "normalized_address_hash",
      }),
    ]);
  });

  it("keeps people, contact, agent, officer, and address fields out of public candidates", () => {
    const candidates = buildIllinoisSosPublicExportCandidates(buildSnapshot());
    const serialized = JSON.stringify(candidates);

    expect(candidates).toEqual([
      expect.objectContaining({
        entityName: "SYNTHETIC RIVER INDUSTRIES INC",
        illinoisFileNumber: FILE_NUMBER,
        privacyReviewRequired: true,
        publicationApproved: false,
      }),
    ]);
    expect(serialized).not.toContain("SYNTHETIC REGISTERED AGENT CO");
    expect(serialized).not.toContain("100 TEST DATA AVE");
    expect(serialized).not.toContain("PRESIDENT ROLE SYNTHETIC");
    expect(serialized).not.toMatch(/agent|officer|contact|address|person/i);
  });

  it("reports an identical second PostgreSQL upsert run as unchanged", async () => {
    const client = createIdempotentMemoryClient();
    const snapshot = buildSnapshot();

    const first = await loadIllinoisSosCorporationSnapshot(client, snapshot);
    const second = await loadIllinoisSosCorporationSnapshot(client, snapshot);

    expect(first).toEqual({
      attemptedRows: 5,
      changedRows: 5,
      unchangedRows: 0,
    });
    expect(second).toEqual({
      attemptedRows: 5,
      changedRows: 0,
      unchangedRows: 5,
    });
  });
});

/**
 * Build the three validated synthetic components and join them.
 *
 * @returns One-record non-PII snapshot.
 */
function buildSnapshot() {
  return joinIllinoisSosCorporationSnapshot({
    agentFile: parseAgent(),
    masterFile: parseMaster(),
    nameFile: parseName(),
  });
}

/**
 * Parse one synthetic Master component.
 *
 * @returns Typed Master file.
 */
function parseMaster(): IllinoisSosParsedFile<IllinoisSosCorporationMasterRecord> {
  const parsed = parseIllinoisSosCorporationFile({
    component: "master",
    contents: buildFixedWidthFile("CORPMASTER", 160, [buildMasterRecord()]),
    sourceArtifactUri: "file:///synthetic/master.txt",
    sourceFileName: "master.txt",
  });
  if (parsed.component !== "master") throw new Error("expected Master parser result");
  return parsed;
}

/**
 * Parse one synthetic Name component.
 *
 * @returns Typed Name file.
 */
function parseName(): IllinoisSosParsedFile<IllinoisSosCorporationNameRecord> {
  const parsed = parseIllinoisSosCorporationFile({
    component: "name",
    contents: buildFixedWidthFile("CORPNAME", 197, [buildNameRecord()]),
    sourceArtifactUri: "file:///synthetic/name.txt",
    sourceFileName: "name.txt",
  });
  if (parsed.component !== "name") throw new Error("expected Name parser result");
  return parsed;
}

/**
 * Parse one synthetic Agent component.
 *
 * @param fileNumber - Optional join key override.
 * @returns Typed Agent file.
 */
function parseAgent(
  fileNumber = FILE_NUMBER,
): IllinoisSosParsedFile<IllinoisSosCorporationAgentRecord> {
  const parsed = parseIllinoisSosCorporationFile({
    component: "agent",
    contents: buildFixedWidthFile("CORPAGENT", 164, [
      buildAgentRecord(fileNumber),
    ]),
    sourceArtifactUri: "file:///synthetic/agent.txt",
    sourceFileName: "agent.txt",
  });
  if (parsed.component !== "agent") throw new Error("expected Agent parser result");
  return parsed;
}

/**
 * Construct a control-record-wrapped fixed-width file.
 *
 * @param label - Header file label.
 * @param width - Official component record width.
 * @param records - Already padded data records.
 * @param trailerCount - Optional deliberate trailer count override.
 * @returns Complete fixed-width text with one trailing newline.
 */
function buildFixedWidthFile(
  label: string,
  width: number,
  records: readonly string[],
  trailerCount = records.length,
): string {
  const header = `RUN DATE = ${RUN_DATE_COMPACT} FILE: ${label}`.padEnd(width);
  const trailer =
    `END OF FILE RECORD COUNT= ${String(trailerCount).padStart(7, "0")}`.padEnd(
      width,
    );
  return `${[header, ...records, trailer].join("\n")}\n`;
}

/**
 * Build one official-width synthetic CORP-MASTER row.
 *
 * @returns 160-character record.
 */
function buildMasterRecord(): string {
  let row = " ".repeat(160);
  row = writeField(row, 0, 8, FILE_NUMBER);
  row = writeField(row, 8, 16, "20200102");
  row = writeField(row, 16, 24, "00000000");
  row = writeField(row, 24, 26, "17");
  row = writeField(row, 26, 29, "012");
  row = writeField(row, 29, 31, "00");
  row = writeField(row, 31, 32, "4");
  row = writeField(row, 32, 40, "20260701");
  row = writeField(row, 40, 100, "PRESIDENT ROLE SYNTHETIC");
  return writeField(row, 100, 160, "SECRETARY ROLE SYNTHETIC");
}

/**
 * Build one official-width synthetic CORP-NAME row.
 *
 * @returns 197-character record.
 */
function buildNameRecord(): string {
  let row = " ".repeat(197);
  row = writeField(row, 0, 8, FILE_NUMBER);
  return writeField(row, 8, 197, "SYNTHETIC RIVER INDUSTRIES INC");
}

/**
 * Build one official-width synthetic CORP-AGENT row.
 *
 * @param fileNumber - Eight-digit join key.
 * @returns 164-character record.
 */
function buildAgentRecord(fileNumber: string): string {
  let row = " ".repeat(164);
  row = writeField(row, 0, 8, fileNumber);
  row = writeField(row, 8, 68, "SYNTHETIC REGISTERED AGENT CO");
  row = writeField(row, 68, 113, "100 TEST DATA AVE");
  row = writeField(row, 113, 143, "MOLINE");
  row = writeField(row, 143, 151, "20250101");
  row = writeField(row, 151, 152, "1");
  row = writeField(row, 152, 161, "612651234");
  return writeField(row, 161, 164, "081");
}

/**
 * Write one left-aligned value into an exact fixed-width range.
 *
 * @param row - Existing fixed-width record.
 * @param start - Zero-based inclusive position.
 * @param end - Zero-based exclusive position.
 * @param value - Field content.
 * @returns Updated record with unchanged total width.
 */
function writeField(
  row: string,
  start: number,
  end: number,
  value: string,
): string {
  const width = end - start;
  if (value.length > width) throw new Error(`Synthetic field exceeds width ${width}`);
  return `${row.slice(0, start)}${value.padEnd(width)}${row.slice(end)}`;
}

/**
 * Emulate the source-key/hash behavior needed to prove second-run idempotency.
 *
 * @returns Query client that resolves inserted parents and suppresses unchanged
 * hashes on replay.
 */
function createIdempotentMemoryClient(): QueryClient {
  const hashes = new Map<string, string>();
  const ids = new Map<string, string>();
  const registrationsByDocument = new Map<string, string>();
  let nextId = 1;
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ): Promise<QueryRowsResult<Row>> {
      if (text.startsWith("SELECT")) {
        const tableMatch = /FROM "([^"]+)"/.exec(text);
        const table = tableMatch?.[1];
        if (table === "business_registrations") {
          const documentNumber = String(values[1]);
          const id = registrationsByDocument.get(documentNumber);
          return queryRows<Row>(
            id === undefined ? [] : [{ business_registration_id: id }],
          );
        }
        const sourceRecordKey = String(values.at(-1));
        const id = ids.get(`${table}:${sourceRecordKey}`);
        if (id === undefined || table === undefined) return queryRows<Row>([]);
        const idColumn =
          table === "addresses" ? "address_id" : table === "companies" ? "company_id" : "";
        return idColumn.length === 0
          ? queryRows<Row>([])
          : queryRows<Row>([{ [idColumn]: id }]);
      }

      const insertMatch = /^INSERT INTO "([^"]+)" \(([^)]+)\)/.exec(text);
      if (insertMatch?.[1] === undefined || insertMatch[2] === undefined) {
        return queryRows<Row>([]);
      }
      const table = insertMatch[1];
      const columns = insertMatch[2]
        .split(", ")
        .map((column) => column.replaceAll("\"", ""));
      const valueByColumn = Object.fromEntries(
        columns.map((column, index) => [column, values[index]]),
      );
      const sourceRecordKey = String(valueByColumn.source_record_key);
      const sourceRecordHash = String(valueByColumn.source_record_hash);
      const storageKey = `${table}:${sourceRecordKey}`;
      if (hashes.get(storageKey) === sourceRecordHash) return queryRows<Row>([]);
      hashes.set(storageKey, sourceRecordHash);
      const id = ids.get(storageKey) ?? `synthetic-id-${nextId++}`;
      ids.set(storageKey, id);
      if (table === "business_registrations") {
        registrationsByDocument.set(String(valueByColumn.document_number), id);
      }
      return queryRows<Row>([{ changed_id: id }]);
    },
  };
}

/**
 * Adapt plain synthetic objects to the generic query-result type.
 *
 * @param values - Rows to return.
 * @returns Typed readonly query result.
 */
function queryRows<Row extends JsonObject>(
  values: readonly JsonObject[],
): QueryRowsResult<Row> {
  return { rows: values as readonly Row[] };
}
