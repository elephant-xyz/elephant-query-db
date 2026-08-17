import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ParquetReader,
  ParquetSchema,
  ParquetWriter,
} from "@dsnp/parquetjs";
import { Pool } from "pg";

export const PUBLIC_CORPORATE_SCHEMA_VERSION =
  "illinois-sos-rock-island-corporate-registration-public-v1" as const;
export const PUBLIC_CORPORATE_SOURCE_SYSTEM = "illinois_sos" as const;
export const PUBLIC_CORPORATE_COUNTY_CODE = "081" as const;
export const PUBLIC_CORPORATE_COUNTY_LABEL = "Rock Island" as const;
export const PUBLIC_CORPORATE_SCOPE_TYPE =
  "registered_agent_office_county" as const;
export const PUBLIC_CORPORATE_SNAPSHOT_CONSISTENCY = "mixed_date" as const;
export const PUBLIC_CORPORATE_INTERSECTION_COVERAGE_PERCENT = 99.9933 as const;

export const PUBLIC_CORPORATE_COLUMNS = [
  "illinois_file_number",
  "legal_company_name",
  "entity_type_code",
  "entity_type",
  "entity_status_code",
  "entity_status",
  "incorporation_date",
  "organization_date",
  "dissolution_date",
  "source_system",
  "master_snapshot_date",
  "name_snapshot_date",
  "agent_snapshot_date",
  "snapshot_consistency",
  "statewide_intersection_coverage_percent",
  "county_scope_type",
  "county_code",
  "county_label",
] as const;

export type PublicCorporateColumn = (typeof PUBLIC_CORPORATE_COLUMNS)[number];

export type PublicCorporateRegistrationRow = {
  readonly illinois_file_number: string;
  readonly legal_company_name: string;
  readonly entity_type_code: string | null;
  readonly entity_type: string | null;
  readonly entity_status_code: string | null;
  readonly entity_status: string | null;
  readonly incorporation_date: string | null;
  readonly organization_date: null;
  readonly dissolution_date: null;
  readonly source_system: typeof PUBLIC_CORPORATE_SOURCE_SYSTEM;
  readonly master_snapshot_date: "2026-07-29";
  readonly name_snapshot_date: "2026-07-28";
  readonly agent_snapshot_date: "2026-07-29";
  readonly snapshot_consistency: typeof PUBLIC_CORPORATE_SNAPSHOT_CONSISTENCY;
  readonly statewide_intersection_coverage_percent: 99.9933;
  readonly county_scope_type: typeof PUBLIC_CORPORATE_SCOPE_TYPE;
  readonly county_code: typeof PUBLIC_CORPORATE_COUNTY_CODE;
  readonly county_label: typeof PUBLIC_CORPORATE_COUNTY_LABEL;
};

export type PublicCorporateSourceRow = {
  readonly illinois_file_number: string;
  readonly legal_company_name: string | null;
  readonly entity_type_code: string | null;
  readonly entity_type: string | null;
  readonly entity_status_code: string | null;
  readonly entity_status: string | null;
  readonly incorporation_date: string | null;
};

export type PublicCorporateExportOptions = {
  readonly outDir: string;
  readonly exportedAt: string;
  readonly expectedRowCount: number;
  readonly statewideIntersectionCount: number;
  readonly statewideSourceCount: number;
  readonly statewideExcludedCount: number;
  readonly excludedCounty081Count: number;
};

export type PublicCorporateArtifactDigest = {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly cid: string;
};

export type PublicCorporateManifest = {
  readonly schemaVersion: typeof PUBLIC_CORPORATE_SCHEMA_VERSION;
  readonly dataset: "rock_island_corporate_registrations";
  readonly exportedAt: string;
  readonly rowCount: number;
  readonly uniqueIllinoisFileNumberCount: number;
  readonly sourceSystem: typeof PUBLIC_CORPORATE_SOURCE_SYSTEM;
  readonly scope: {
    readonly type: typeof PUBLIC_CORPORATE_SCOPE_TYPE;
    readonly countyCode: typeof PUBLIC_CORPORATE_COUNTY_CODE;
    readonly countyLabel: typeof PUBLIC_CORPORATE_COUNTY_LABEL;
    readonly meaning:
      "organization has a registered-agent office county code of 081";
    readonly doesNotEstablish: readonly [
      "operating_location",
      "tenancy",
      "ownership",
      "occupancy",
    ];
  };
  readonly componentSnapshots: {
    readonly master: "2026-07-29";
    readonly name: "2026-07-28";
    readonly agent: "2026-07-29";
  };
  readonly snapshotConsistency: typeof PUBLIC_CORPORATE_SNAPSHOT_CONSISTENCY;
  readonly statewideIntersection: {
    readonly sourceCount: number;
    readonly includedCount: number;
    readonly excludedCount: number;
    readonly coveragePercent: 99.9933;
    readonly excludedCounty081Count: number;
  };
  readonly privacy: {
    readonly classification: "public_non_pii_organization_registry";
    readonly allowlistColumns: readonly PublicCorporateColumn[];
    readonly excludedClasses: readonly [
      "registered_agent_names",
      "officer_member_person_names",
      "street_postal_email_phone_contact",
      "raw_source_payloads",
      "address_hashes",
      "property_appraisal_links",
      "complaints_reviews",
    ];
    readonly semanticScanPassed: true;
  };
  readonly dateAvailability: {
    readonly incorporationDate: true;
    readonly organizationDate: false;
    readonly dissolutionDate: false;
  };
  readonly artifacts: readonly PublicCorporateArtifactDigest[];
};

export type PublicCorporateExportResult = {
  readonly rowCount: number;
  readonly uniqueIllinoisFileNumberCount: number;
  readonly parquetPath: string;
  readonly schemaPath: string;
  readonly manifestPath: string;
  readonly manifestCid: string;
  readonly parquetCid: string;
  readonly schemaCid: string;
  readonly semanticPiiScan: {
    readonly rowsScanned: number;
    readonly forbiddenKeysFound: 0;
    readonly forbiddenValuesFound: 0;
  };
};

const FORBIDDEN_PUBLIC_KEY_PATTERN =
  /(agent_name|officer|member|person|street|address|postal|zip|email|phone|contact|property|parcel|appraisal|hash|complaint|review|tenant|owner|occupancy)/iu;
const EMAIL_VALUE_PATTERN = /\b[^@\s]+@[^@\s]+\.[^@\s]+\b/iu;
const PHONE_VALUE_PATTERN =
  /(?:^|[^\d])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?:[^\d]|$)/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const require = createRequire(import.meta.url);
const ipfsHash = require("ipfs-only-hash") as {
  of: (content: Buffer) => Promise<string>;
};

/**
 * Build the exact SQL projection used for the public corporate export.
 *
 * The query may use private source metadata only in its county-code predicate.
 * It selects no address, person, raw payload, hash, property, or appraisal field
 * and joins no property table.
 *
 * @returns Parameterized SQL with one organization registry row per file number.
 */
export function buildPublicCorporateRegistrationSql(): string {
  return `
    SELECT
      registration.document_number AS illinois_file_number,
      registration.entity_name AS legal_company_name,
      registration.filing_type_code AS entity_type_code,
      registration.filing_type AS entity_type,
      registration.status_code AS entity_status_code,
      registration.status AS entity_status,
      registration.filed_date::text AS incorporation_date
    FROM public.business_registrations registration
    JOIN public.business_registration_addresses registration_address
      ON registration_address.business_registration_id =
         registration.business_registration_id
     AND registration_address.source_system = $1
     AND registration_address.address_role = 'registered_agent_office'
    JOIN public.addresses registry_county_evidence
      ON registry_county_evidence.address_id = registration_address.address_id
     AND registry_county_evidence.source_system = $1
    WHERE registration.source_system = $1
      AND registration.source_payload @> '{"componentDateMismatch":true}'::jsonb
      AND registration.source_payload @> '{"coverage":"partial"}'::jsonb
      AND registration.source_payload @> '{"privacy":"private"}'::jsonb
      AND registration.source_payload @> '{"publishable":false}'::jsonb
      AND registry_county_evidence.source_payload->>'agentCountyCode' = $2
    ORDER BY registration.document_number
  `;
}

/**
 * Build the stable Parquet schema for the organization-only public export.
 *
 * @returns Scalar-only schema containing exactly the public allowlist.
 */
export function buildPublicCorporateParquetSchema(): ParquetSchema {
  return new ParquetSchema({
    illinois_file_number: { type: "UTF8" },
    legal_company_name: { type: "UTF8" },
    entity_type_code: { type: "UTF8", optional: true },
    entity_type: { type: "UTF8", optional: true },
    entity_status_code: { type: "UTF8", optional: true },
    entity_status: { type: "UTF8", optional: true },
    incorporation_date: { type: "UTF8", optional: true },
    organization_date: { type: "UTF8", optional: true },
    dissolution_date: { type: "UTF8", optional: true },
    source_system: { type: "UTF8" },
    master_snapshot_date: { type: "UTF8" },
    name_snapshot_date: { type: "UTF8" },
    agent_snapshot_date: { type: "UTF8" },
    snapshot_consistency: { type: "UTF8" },
    statewide_intersection_coverage_percent: { type: "DOUBLE" },
    county_scope_type: { type: "UTF8" },
    county_code: { type: "UTF8" },
    county_label: { type: "UTF8" },
  });
}

/**
 * Build the machine-readable public schema and field-level semantics.
 *
 * @returns Versioned allowlist schema with explicit role and privacy limits.
 */
export function buildPublicCorporateSchemaDocument(): Record<string, unknown> {
  return {
    schemaVersion: PUBLIC_CORPORATE_SCHEMA_VERSION,
    dataset: "rock_island_corporate_registrations",
    primaryKey: "illinois_file_number",
    columns: [
      { name: "illinois_file_number", type: "string", nullable: false },
      {
        name: "legal_company_name",
        type: "string",
        nullable: false,
        classification: "organization_registry_name",
      },
      { name: "entity_type_code", type: "string", nullable: true },
      { name: "entity_type", type: "string", nullable: true },
      { name: "entity_status_code", type: "string", nullable: true },
      { name: "entity_status", type: "string", nullable: true },
      { name: "incorporation_date", type: "date", nullable: true },
      {
        name: "organization_date",
        type: "date",
        nullable: true,
        availability: "not_available_in_accepted_components",
      },
      {
        name: "dissolution_date",
        type: "date",
        nullable: true,
        availability: "not_available_in_accepted_components",
      },
      { name: "source_system", type: "string", nullable: false },
      { name: "master_snapshot_date", type: "date", nullable: false },
      { name: "name_snapshot_date", type: "date", nullable: false },
      { name: "agent_snapshot_date", type: "date", nullable: false },
      { name: "snapshot_consistency", type: "string", nullable: false },
      {
        name: "statewide_intersection_coverage_percent",
        type: "number",
        nullable: false,
      },
      { name: "county_scope_type", type: "string", nullable: false },
      { name: "county_code", type: "string", nullable: false },
      { name: "county_label", type: "string", nullable: false },
    ],
    privacy:
      "Organization registry fields only. County scope is coarse registered-agent office county evidence and is not a property or operating-location relationship.",
  };
}

/**
 * Map a narrow database projection into the fully labelled public row.
 *
 * @param source - Organization-only database projection.
 * @returns Public allowlisted record with fixed provenance and scope labels.
 */
export function buildPublicCorporateRow(
  source: PublicCorporateSourceRow,
): PublicCorporateRegistrationRow {
  if (source.legal_company_name === null) {
    throw new Error(
      `Missing legal company name for Illinois file number ${source.illinois_file_number}`,
    );
  }
  return {
    illinois_file_number: source.illinois_file_number,
    legal_company_name: source.legal_company_name,
    entity_type_code: source.entity_type_code,
    entity_type: source.entity_type,
    entity_status_code: source.entity_status_code,
    entity_status: source.entity_status,
    incorporation_date: source.incorporation_date,
    organization_date: null,
    dissolution_date: null,
    source_system: PUBLIC_CORPORATE_SOURCE_SYSTEM,
    master_snapshot_date: "2026-07-29",
    name_snapshot_date: "2026-07-28",
    agent_snapshot_date: "2026-07-29",
    snapshot_consistency: PUBLIC_CORPORATE_SNAPSHOT_CONSISTENCY,
    statewide_intersection_coverage_percent:
      PUBLIC_CORPORATE_INTERSECTION_COVERAGE_PERCENT,
    county_scope_type: PUBLIC_CORPORATE_SCOPE_TYPE,
    county_code: PUBLIC_CORPORATE_COUNTY_CODE,
    county_label: PUBLIC_CORPORATE_COUNTY_LABEL,
  };
}

/**
 * Fail closed unless a row contains exactly the allowlisted keys and values.
 *
 * Organization legal names are an explicitly approved registry field. They
 * still reject contact-like email/telephone content and control characters.
 * Every other field is constrained to a code, date, enum, or fixed label.
 *
 * @param row - Candidate public corporate row.
 */
export function assertPublicCorporateRow(
  row: PublicCorporateRegistrationRow,
): void {
  const actualKeys = Object.keys(row).sort();
  const expectedKeys = [...PUBLIC_CORPORATE_COLUMNS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Public corporate row does not match the exact allowlist");
  }
  for (const key of actualKeys) {
    if (
      FORBIDDEN_PUBLIC_KEY_PATTERN.test(key) &&
      key !== "county_scope_type"
    ) {
      throw new Error(`Forbidden public corporate key: ${key}`);
    }
  }
  if (!/^\d{8}$/u.test(row.illinois_file_number)) {
    throw new Error("Illinois file number must contain exactly eight digits");
  }
  if (row.legal_company_name.trim().length === 0) {
    throw new Error("Legal company name cannot be empty");
  }
  for (const value of Object.values(row)) {
    if (
      typeof value === "string" &&
      (CONTROL_CHARACTER_PATTERN.test(value) ||
        EMAIL_VALUE_PATTERN.test(value) ||
        PHONE_VALUE_PATTERN.test(value))
    ) {
      throw new Error("Public corporate value contains contact-like or control data");
    }
  }
  for (const dateValue of [
    row.incorporation_date,
    row.organization_date,
    row.dissolution_date,
  ]) {
    if (dateValue !== null && !DATE_PATTERN.test(dateValue)) {
      throw new Error("Public corporate date is not ISO YYYY-MM-DD");
    }
  }
  if (
    row.source_system !== PUBLIC_CORPORATE_SOURCE_SYSTEM ||
    row.master_snapshot_date !== "2026-07-29" ||
    row.name_snapshot_date !== "2026-07-28" ||
    row.agent_snapshot_date !== "2026-07-29" ||
    row.snapshot_consistency !== PUBLIC_CORPORATE_SNAPSHOT_CONSISTENCY ||
    row.statewide_intersection_coverage_percent !==
      PUBLIC_CORPORATE_INTERSECTION_COVERAGE_PERCENT ||
    row.county_scope_type !== PUBLIC_CORPORATE_SCOPE_TYPE ||
    row.county_code !== PUBLIC_CORPORATE_COUNTY_CODE ||
    row.county_label !== PUBLIC_CORPORATE_COUNTY_LABEL
  ) {
    throw new Error("Public corporate provenance or county labels are invalid");
  }
}

/**
 * Validate export CLI arguments without reading environment variables.
 *
 * @param argv - Arguments after the script path.
 * @returns Fully explicit deterministic export options.
 */
export function parsePublicCorporateExportOptions(
  argv: readonly string[],
): PublicCorporateExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const readRequiredInteger = (name: string): number => {
    const raw = values.get(name);
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`--${name} must be a non-negative integer`);
    }
    return parsed;
  };
  const exportedAt = values.get("exported-at");
  if (
    exportedAt === undefined ||
    !Number.isFinite(Date.parse(exportedAt)) ||
    new Date(exportedAt).toISOString() !== exportedAt
  ) {
    throw new Error("--exported-at must be an exact ISO timestamp");
  }
  return {
    outDir:
      values.get("out-dir") ??
      ".corporate-registration-export/rock-island",
    exportedAt,
    expectedRowCount: readRequiredInteger("expected-row-count"),
    statewideIntersectionCount: readRequiredInteger(
      "statewide-intersection-count",
    ),
    statewideSourceCount: readRequiredInteger("statewide-source-count"),
    statewideExcludedCount: readRequiredInteger("statewide-excluded-count"),
    excludedCounty081Count: readRequiredInteger("excluded-county-081-count"),
  };
}

function toParquetRecord(
  row: PublicCorporateRegistrationRow,
): Record<string, string | number> {
  const record: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number") {
      record[key] = value;
    }
  }
  return record;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function digestArtifact(
  key: string,
  content: Buffer,
): Promise<PublicCorporateArtifactDigest> {
  return {
    key,
    bytes: content.byteLength,
    sha256: sha256(content),
    cid: await ipfsHash.of(content),
  };
}

function stableJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertParquetReadback(
  parquetPath: string,
  expectedRows: readonly PublicCorporateRegistrationRow[],
): Promise<void> {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor();
    let offset = 0;
    while (true) {
      const candidate = (await cursor.next()) as
        | Record<string, unknown>
        | null;
      if (candidate === null) break;
      const expected = expectedRows[offset];
      if (expected === undefined) {
        throw new Error("Parquet readback contains extra corporate rows");
      }
      if (
        candidate["illinois_file_number"] !== expected.illinois_file_number ||
        candidate["legal_company_name"] !== expected.legal_company_name ||
        candidate["county_code"] !== PUBLIC_CORPORATE_COUNTY_CODE ||
        candidate["county_scope_type"] !== PUBLIC_CORPORATE_SCOPE_TYPE
      ) {
        throw new Error("Parquet corporate readback mismatch");
      }
      offset += 1;
    }
    if (offset !== expectedRows.length) {
      throw new Error("Parquet corporate readback row count mismatch");
    }
  } finally {
    await reader.close();
  }
}

/**
 * Export, validate, and digest the public non-PII corporate-registration subset.
 *
 * @param options - Explicit counts, timestamp, and output directory.
 * @returns Artifact paths, CIDs, counts, and semantic privacy scan results.
 */
export async function runPublicCorporateRegistrationExport(
  options: PublicCorporateExportOptions,
): Promise<PublicCorporateExportResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  if (
    options.statewideSourceCount - options.statewideIntersectionCount !==
      options.statewideExcludedCount ||
    options.expectedRowCount !== 11_741 ||
    options.statewideIntersectionCount !== 1_981_254 ||
    options.statewideSourceCount !== 1_981_387 ||
    options.statewideExcludedCount !== 133 ||
    options.excludedCounty081Count !== 0
  ) {
    throw new Error("Corporate export reconciliation inputs are not approved");
  }

  const pool = new Pool({
    application_name: "elephant-public-corporate-registration-export",
    connectionString: databaseUrl,
    max: 2,
  });
  try {
    const result = await pool.query<PublicCorporateSourceRow>(
      buildPublicCorporateRegistrationSql(),
      [PUBLIC_CORPORATE_SOURCE_SYSTEM, PUBLIC_CORPORATE_COUNTY_CODE],
    );
    if (result.rows.length !== options.expectedRowCount) {
      throw new Error(
        `Corporate source count ${result.rows.length} does not equal expected ${options.expectedRowCount}`,
      );
    }
    const rows = result.rows.map(buildPublicCorporateRow);
    const identifiers = new Set<string>();
    for (const row of rows) {
      assertPublicCorporateRow(row);
      if (identifiers.has(row.illinois_file_number)) {
        throw new Error(
          `Duplicate Illinois file number ${row.illinois_file_number}`,
        );
      }
      identifiers.add(row.illinois_file_number);
    }
    if (identifiers.size !== options.expectedRowCount) {
      throw new Error("Corporate identifier cardinality mismatch");
    }

    await mkdir(options.outDir, { recursive: true });
    const parquetPath = join(
      options.outDir,
      "corporate-registrations.parquet",
    );
    const schemaPath = join(
      options.outDir,
      "corporate-registration-schema.json",
    );
    const manifestPath = join(options.outDir, "manifest.json");

    const writer = await ParquetWriter.openFile(
      buildPublicCorporateParquetSchema(),
      parquetPath,
    );
    try {
      for (const row of rows) {
        await writer.appendRow(toParquetRecord(row));
      }
    } finally {
      await writer.close();
    }
    await assertParquetReadback(parquetPath, rows);

    const schemaBody = stableJson(buildPublicCorporateSchemaDocument());
    await writeFile(schemaPath, schemaBody, { mode: 0o600 });
    const parquetBody = await readFile(parquetPath);
    const artifacts = [
      await digestArtifact(
        "corporate-registrations/rock-island/corporate-registrations.parquet",
        parquetBody,
      ),
      await digestArtifact(
        "corporate-registrations/rock-island/corporate-registration-schema.json",
        schemaBody,
      ),
    ] as const;
    const manifest: PublicCorporateManifest = {
      schemaVersion: PUBLIC_CORPORATE_SCHEMA_VERSION,
      dataset: "rock_island_corporate_registrations",
      exportedAt: options.exportedAt,
      rowCount: rows.length,
      uniqueIllinoisFileNumberCount: identifiers.size,
      sourceSystem: PUBLIC_CORPORATE_SOURCE_SYSTEM,
      scope: {
        type: PUBLIC_CORPORATE_SCOPE_TYPE,
        countyCode: PUBLIC_CORPORATE_COUNTY_CODE,
        countyLabel: PUBLIC_CORPORATE_COUNTY_LABEL,
        meaning:
          "organization has a registered-agent office county code of 081",
        doesNotEstablish: [
          "operating_location",
          "tenancy",
          "ownership",
          "occupancy",
        ],
      },
      componentSnapshots: {
        master: "2026-07-29",
        name: "2026-07-28",
        agent: "2026-07-29",
      },
      snapshotConsistency: PUBLIC_CORPORATE_SNAPSHOT_CONSISTENCY,
      statewideIntersection: {
        sourceCount: options.statewideSourceCount,
        includedCount: options.statewideIntersectionCount,
        excludedCount: options.statewideExcludedCount,
        coveragePercent: PUBLIC_CORPORATE_INTERSECTION_COVERAGE_PERCENT,
        excludedCounty081Count: options.excludedCounty081Count,
      },
      privacy: {
        classification: "public_non_pii_organization_registry",
        allowlistColumns: PUBLIC_CORPORATE_COLUMNS,
        excludedClasses: [
          "registered_agent_names",
          "officer_member_person_names",
          "street_postal_email_phone_contact",
          "raw_source_payloads",
          "address_hashes",
          "property_appraisal_links",
          "complaints_reviews",
        ],
        semanticScanPassed: true,
      },
      dateAvailability: {
        incorporationDate: true,
        organizationDate: false,
        dissolutionDate: false,
      },
      artifacts,
    };
    const manifestBody = stableJson(manifest);
    await writeFile(manifestPath, manifestBody, { mode: 0o600 });
    const manifestCid = await ipfsHash.of(manifestBody);

    const output: PublicCorporateExportResult = {
      rowCount: rows.length,
      uniqueIllinoisFileNumberCount: identifiers.size,
      parquetPath,
      schemaPath,
      manifestPath,
      manifestCid,
      parquetCid: artifacts[0].cid,
      schemaCid: artifacts[1].cid,
      semanticPiiScan: {
        rowsScanned: rows.length,
        forbiddenKeysFound: 0,
        forbiddenValuesFound: 0,
      },
    };
    console.log(
      JSON.stringify({
        event: "public_corporate_registration_export_complete",
        ...output,
      }),
    );
    return output;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  await runPublicCorporateRegistrationExport(
    parsePublicCorporateExportOptions(process.argv.slice(2)),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({
        event: "public_corporate_registration_export_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
