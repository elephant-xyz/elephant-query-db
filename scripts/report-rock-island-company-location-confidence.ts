import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  aggregateIllinoisSosLocationConfidence,
  type IllinoisSosLocationEvidence,
  type JsonObject,
} from "../src/loader/index.js";

type ConfidenceOptions = {
  readonly outputPath: string | null;
};

type ConfidenceEvidenceRow = JsonObject & {
  readonly address_role: string;
  readonly company_key: string;
  readonly exact_permit_business_corroboration: boolean;
  readonly normalized_address_hash: string;
  readonly normalized_company_name: string | null;
  readonly property_key: string;
};

/**
 * Compute aggregate-only Illinois SOS company/property confidence tiers.
 *
 * Row-level company names, addresses, hashes, and identifiers remain in
 * PostgreSQL. Only privacy-safe counts and evidence-rule descriptions are
 * printed or written to disk.
 */
async function main(): Promise<void> {
  const options = parseConfidenceOptions(process.argv.slice(2));
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({
    application_name: "rock-island-company-location-confidence",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  try {
    const result = await pool.query<ConfidenceEvidenceRow>(
      buildRockIslandCompanyLocationEvidenceSql(),
    );
    const report = aggregateIllinoisSosLocationConfidence(
      result.rows.map(mapEvidenceRow),
    );
    const output = {
      ...report,
      generatedAt: new Date().toISOString(),
      privacy: {
        containsAddresses: false,
        containsCompanyNames: false,
        containsContacts: false,
        containsIdentifiers: false,
        publicationApproved: false,
      },
      rowLevelEvidenceCount: result.rows.length,
      sourceSystem: "illinois_sos",
    };
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (options.outputPath !== null) {
      const absolutePath = resolve(options.outputPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, serialized, "utf8");
    }
    process.stdout.write(serialized);
  } finally {
    await pool.end();
  }
}

/**
 * Build the read-only evidence query used by the aggregate report.
 *
 * Exact address equality is based on the existing normalized-address hash.
 * Permit corroboration requires either an existing company FK or an exact
 * normalized company-name match in contractor/applicant permit evidence for
 * the same property. It does not assert ownership, tenancy, or headquarters.
 *
 * @returns Parameter-free read-only PostgreSQL query.
 */
export function buildRockIslandCompanyLocationEvidenceSql(): string {
  return [
    "WITH sos_property_matches AS (",
    "  SELECT DISTINCT",
    "    c.company_id,",
    "    c.source_record_key AS company_key,",
    "    c.normalized_name AS normalized_company_name,",
    "    p.property_id,",
    "    p.property_id::text AS property_key,",
    "    sos_address.normalized_address_hash,",
    "    bra.address_role",
    "  FROM business_registrations br",
    "  JOIN companies c ON c.company_id = br.company_id",
    "  JOIN business_registration_addresses bra",
    "    ON bra.business_registration_id = br.business_registration_id",
    "  JOIN addresses sos_address ON sos_address.address_id = bra.address_id",
    "  JOIN addresses property_address",
    "    ON property_address.normalized_address_hash = sos_address.normalized_address_hash",
    "  JOIN properties p ON p.address_id = property_address.address_id",
    "  WHERE br.source_system = 'illinois_sos'",
    "    AND p.source_system = 'rock_island_appraiser'",
    "    AND sos_address.normalized_address_hash IS NOT NULL",
    ")",
    "SELECT",
    "  match.company_key,",
    "  match.normalized_company_name,",
    "  match.property_key,",
    "  match.normalized_address_hash,",
    "  match.address_role,",
    "  EXISTS (",
    "    SELECT 1",
    "    FROM property_improvements improvement",
    "    LEFT JOIN permit_contacts contact",
    "      ON contact.property_improvement_id = improvement.property_improvement_id",
    "    WHERE improvement.property_id = match.property_id",
    "      AND (",
    "        improvement.contractor_company_id = match.company_id",
    "        OR contact.company_id = match.company_id",
    "        OR (",
    "          match.normalized_company_name IS NOT NULL",
    "          AND match.normalized_company_name <> ''",
    "          AND (",
    "            btrim(regexp_replace(upper(coalesce(contact.raw_name, '')), '[^A-Z0-9]+', ' ', 'g')) = match.normalized_company_name",
    "            OR btrim(regexp_replace(upper(coalesce(improvement.applicant, '')), '[^A-Z0-9]+', ' ', 'g')) = match.normalized_company_name",
    "            OR btrim(regexp_replace(upper(coalesce(improvement.licensed_professional, '')), '[^A-Z0-9]+', ' ', 'g')) = match.normalized_company_name",
    "          )",
    "        )",
    "      )",
    "  ) AS exact_permit_business_corroboration",
    "FROM sos_property_matches match",
    "ORDER BY match.company_key, match.property_key, match.address_role",
  ].join("\n");
}

/**
 * Parse the aggregate report CLI.
 *
 * @param argv - Arguments after the script name.
 * @returns Optional aggregate-only JSON output path.
 */
export function parseConfidenceOptions(
  argv: readonly string[],
): ConfidenceOptions {
  if (argv.length === 0) return { outputPath: null };
  if (argv.length !== 2 || argv[0] !== "--output" || argv[1] === undefined) {
    throw new Error("Usage: [--output <aggregate-json-path>]");
  }
  return { outputPath: argv[1] };
}

function mapEvidenceRow(
  row: ConfidenceEvidenceRow,
): IllinoisSosLocationEvidence {
  return {
    addressRole: row.address_role,
    companyKey: row.company_key,
    exactPermitBusinessCorroboration:
      row.exact_permit_business_corroboration,
    normalizedAddressHash: row.normalized_address_hash,
    normalizedCompanyName: row.normalized_company_name,
    propertyKey: row.property_key,
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
