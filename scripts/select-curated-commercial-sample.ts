import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Pool } from "pg";

import {
  buildCuratedCommercialCandidates,
  buildStreetAddressBase,
  leeAreaCityNames,
  leeAreaPostalCodes,
  readString,
  type CuratedCommercialCandidate,
  type PermitEvidenceRow,
  type SunbizAddressEvidenceRow,
} from "../src/loader/index.js";

type SelectionOptions = {
  readonly envFile: string;
  readonly limit: number;
  readonly output: string;
  readonly seedCsvOutput: string;
};

type PermitQueryRow = {
  readonly parcel_identifier: string | null;
  readonly permit_number: string | null;
  readonly record_type: string | null;
  readonly source_record_type: string | null;
  readonly record_status: string | null;
  readonly source_status: string | null;
  readonly improvement_status: string | null;
  readonly work_location: string | null;
  readonly source_search_address: string | null;
  readonly normalized_address_key: string | null;
  readonly unnormalized_address: string | null;
  readonly comm_res: string | null;
  readonly project_description: string | null;
  readonly description: string | null;
  readonly source_url: string | null;
  readonly permit_link_count: number;
  readonly storable_document_link_count: number;
  readonly inspection_count: number;
  readonly contact_count: number;
};

type SunbizAddressQueryRow = {
  readonly normalized_address_key: string | null;
  readonly unnormalized_address: string | null;
  readonly city_name: string | null;
  readonly postal_code: string | null;
};

type CuratedManifest = {
  readonly manifestVersion: "curated-commercial-sample.v1";
  readonly generatedAt: string;
  readonly sourceDatabase: string;
  readonly selectionRules: readonly string[];
  readonly counts: {
    readonly permitRows: number;
    readonly sunbizAddressRows: number;
    readonly parcelGroupCount: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly permitRowsWithUsableParcel: number;
    readonly permitRowsWithUsableAddress: number;
    readonly sunbizAddressRowsWithUsableBase: number;
  };
  readonly candidates: readonly CuratedCommercialCandidate[];
};

const DEFAULT_OUTPUT = ".loader-runs/curated-commercial-sample/curated-commercial-1000-manifest.json";
const DEFAULT_SEED_CSV_OUTPUT = ".loader-runs/curated-commercial-sample/curated-commercial-1000-appraisal-seed.csv";

/**
 * Select a ranked 1000-parcel commercial sample from the current Neon permit and
 * Sunbiz evidence and write both a JSON manifest and appraisal seed CSV.
 *
 * @returns Promise that resolves after manifest files are written.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await loadEnvFile(options.envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile} or the environment`);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "curated-commercial-sample",
    connectionTimeoutMillis: 15_000,
    max: 2,
    query_timeout: 180_000,
    statement_timeout: 180_000,
  });

  try {
    console.log(JSON.stringify({ event: "curated_selection_started", options }));
    const permitRows = await readPermitEvidence(pool);
    const permitStreetNumbers = extractPermitStreetNumbers(permitRows);
    const sunbizAddressRows = await readSunbizAddressEvidence(pool, permitStreetNumbers);
    console.log(
      JSON.stringify({
        event: "curated_selection_evidence_loaded",
        permitRows: permitRows.length,
        permitStreetNumbers: permitStreetNumbers.length,
        sunbizAddressRows: sunbizAddressRows.length,
      }),
    );

    const result = buildCuratedCommercialCandidates({
      permitRows,
      requireCommercialPermit: false,
      sunbizAddressRows,
      limit: options.limit,
    });

    const manifest: CuratedManifest = {
      manifestVersion: "curated-commercial-sample.v1",
      generatedAt: new Date().toISOString(),
      sourceDatabase: redactDatabaseUrl(databaseUrl),
      selectionRules: [
        "Lee Accela permit row must have a usable parcel identifier.",
        "Permit work-location/source-search address must reduce to a street-number/street-name base.",
        "Commercial-coded permits, commercial-typed permits, and COM permit numbers increase rank but are not a hard gate because appraisal verification is the next hard commercial-property filter.",
        "At least one non-void/non-test permit must be present.",
        "At least one Lee-area Sunbiz address must match the permit address base.",
        "Candidates are ranked by commercial permit depth, non-void permit depth, inspections, contacts, document links, Sunbiz address depth, then parcel id.",
      ],
      counts: {
        permitRows: permitRows.length,
        sunbizAddressRows: sunbizAddressRows.length,
        parcelGroupCount: result.parcelGroupCount,
        candidateCount: result.candidateCount,
        selectedCount: result.selected.length,
        permitRowsWithUsableParcel: result.permitRowsWithUsableParcel,
        permitRowsWithUsableAddress: result.permitRowsWithUsableAddress,
        sunbizAddressRowsWithUsableBase: result.sunbizAddressRowsWithUsableBase,
      },
      candidates: result.selected,
    };

    await writeJson(options.output, manifest);
    await writeCsv(options.seedCsvOutput, serializeAppraisalSeedCsv(result.selected));

    console.log(
      JSON.stringify({
        event: "curated_selection_finished",
        output: options.output,
        seedCsvOutput: options.seedCsvOutput,
        counts: manifest.counts,
      }),
    );
  } finally {
    await pool.end();
  }
}

/**
 * Read current Lee Accela permit evidence from the query database.
 *
 * @param pool - PostgreSQL pool connected to the query database.
 * @returns Permit rows with precomputed child-row counts.
 */
async function readPermitEvidence(pool: Pool): Promise<readonly PermitEvidenceRow[]> {
  const result = await pool.query<PermitQueryRow>(`
    with link_counts as (
      select
        property_improvement_id,
        count(*)::int as permit_link_count,
        count(*) filter (
          where url ilike 'http%'
            and url not ilike 'javascript:%'
            and (
              url ilike '%.pdf%'
              or url ilike '%urlrouting.ashx%'
              or url ilike '%digitalprojects%'
              or url ilike '%/Documents/%'
            )
        )::int as storable_document_link_count
      from permit_links
      group by property_improvement_id
    ),
    inspection_counts as (
      select property_improvement_id, count(*)::int as inspection_count
      from inspections
      group by property_improvement_id
    ),
    contact_counts as (
      select property_improvement_id, count(*)::int as contact_count
      from permit_contacts
      group by property_improvement_id
    )
    select
      p.parcel_identifier,
      p.permit_number,
      p.record_type,
      p.source_record_type,
      p.record_status,
      p.source_status,
      p.improvement_status,
      p.work_location,
      p.source_search_result->>'address' as source_search_address,
      a.normalized_address_key,
      a.unnormalized_address,
      p.comm_res,
      p.project_description,
      p.description,
      p.source_url,
      coalesce(l.permit_link_count, 0)::int as permit_link_count,
      coalesce(l.storable_document_link_count, 0)::int as storable_document_link_count,
      coalesce(i.inspection_count, 0)::int as inspection_count,
      coalesce(c.contact_count, 0)::int as contact_count
    from property_improvements p
    left join addresses a on a.address_id = p.address_id
    left join link_counts l on l.property_improvement_id = p.property_improvement_id
    left join inspection_counts i on i.property_improvement_id = p.property_improvement_id
    left join contact_counts c on c.property_improvement_id = p.property_improvement_id
    where p.source_system = 'lee_accela'
      and p.parcel_identifier is not null
  `);

  return result.rows.map((row) => ({
    parcelIdentifier: row.parcel_identifier,
    permitNumber: row.permit_number,
    recordType: row.record_type,
    sourceRecordType: row.source_record_type,
    recordStatus: row.record_status,
    sourceStatus: row.source_status,
    improvementStatus: row.improvement_status,
    workLocation: row.work_location,
    sourceSearchAddress: row.source_search_address,
    normalizedAddressKey: row.normalized_address_key,
    unnormalizedAddress: row.unnormalized_address,
    commRes: row.comm_res,
    projectDescription: row.project_description,
    description: row.description,
    sourceUrl: row.source_url,
    permitLinkCount: row.permit_link_count,
    storableDocumentLinkCount: row.storable_document_link_count,
    inspectionCount: row.inspection_count,
    contactCount: row.contact_count,
  }));
}

/**
 * Read Lee-area Sunbiz addresses from the query database.
 *
 * @param pool - PostgreSQL pool connected to the query database.
 * @returns Sunbiz address evidence rows scoped by Lee-area city/ZIP guards.
 */
async function readSunbizAddressEvidence(
  pool: Pool,
  permitStreetNumbers: readonly string[],
): Promise<readonly SunbizAddressEvidenceRow[]> {
  if (permitStreetNumbers.length === 0) return [];
  const result = await pool.query<SunbizAddressQueryRow>(
    `
      select
        normalized_address_key,
        unnormalized_address,
        city_name,
        postal_code
      from addresses
      where source_system = 'sunbiz'
        and normalized_address_key is not null
        and (
          upper(coalesce(city_name, '')) = any($1::text[])
          or postal_code = any($2::text[])
        )
        and split_part(normalized_address_key, ' ', 1) = any($3::text[])
    `,
    [leeAreaCityNames(), leeAreaPostalCodes(), permitStreetNumbers],
  );

  return result.rows.map((row) => ({
    normalizedAddressKey: row.normalized_address_key,
    unnormalizedAddress: row.unnormalized_address,
    cityName: row.city_name,
    postalCode: row.postal_code,
  }));
}

function extractPermitStreetNumbers(rows: readonly PermitEvidenceRow[]): readonly string[] {
  const streetNumbers = new Set<string>();
  for (const row of rows) {
    const addressText =
      readString(row.sourceSearchAddress) ??
      readString(row.workLocation) ??
      readString(row.normalizedAddressKey) ??
      readString(row.unnormalizedAddress);
    const base = buildStreetAddressBase(addressText);
    if (base === null) continue;
    const streetNumber = base.split(" ")[0];
    if (streetNumber !== undefined && streetNumber.length > 0) {
      streetNumbers.add(streetNumber);
    }
  }
  return [...streetNumbers].sort();
}

function parseOptions(args: readonly string[]): SelectionOptions {
  let envFile = ".env.local";
  let limit = 1_000;
  let output = DEFAULT_OUTPUT;
  let seedCsvOutput = DEFAULT_SEED_CSV_OUTPUT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const next = args[index + 1];
    if (arg === "--env-file" && next !== undefined) {
      envFile = next;
      index += 1;
    } else if (arg === "--limit" && next !== undefined) {
      limit = parsePositiveInteger(next, "--limit");
      index += 1;
    } else if (arg === "--output" && next !== undefined) {
      output = next;
      index += 1;
    } else if (arg === "--seed-csv-output" && next !== undefined) {
      seedCsvOutput = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }

  return { envFile, limit, output, seedCsvOutput };
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) === false || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

/**
 * Load KEY=VALUE environment variables from a dotenv-like file without printing secrets.
 *
 * @param envFile - Path to the env file.
 * @returns Promise that resolves after values have been merged into `process.env`.
 */
async function loadEnvFile(envFile: string): Promise<void> {
  const text = await readFile(envFile, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex);
    let value = trimmed.slice(equalsIndex + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

async function writeJson(path: string, value: CuratedManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCsv(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

function serializeAppraisalSeedCsv(candidates: readonly CuratedCommercialCandidate[]): string {
  const header = [
    "selection_rank",
    "parcel_identifier",
    "permit_address_base",
    "best_permit_address",
    "permit_count",
    "commercial_permit_count",
    "sunbiz_address_count",
    "sample_permit_numbers",
  ];
  const rows = candidates.map((candidate) =>
    [
      candidate.rank.toString(),
      candidate.parcelIdentifier,
      candidate.addressBase,
      candidate.bestPermitAddress,
      candidate.permitCount.toString(),
      candidate.commercialPermitCount.toString(),
      candidate.sunbizAddressCount.toString(),
      candidate.samplePermits.map((permit) => permit.permitNumber).join("|"),
    ]
      .map(escapeCsvCell)
      .join(","),
  );
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

function escapeCsvCell(value: string): string {
  if (/["\n,]/.test(value) === false) return value;
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    parsed.username = parsed.username.length > 0 ? "redacted" : "";
    parsed.password = parsed.password.length > 0 ? "redacted" : "";
    return parsed.toString();
  } catch {
    return "redacted";
  }
}

await main();
