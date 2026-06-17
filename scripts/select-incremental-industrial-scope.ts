import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Pool } from "pg";

import {
  buildCuratedCommercialCandidates,
  buildStreetAddressBase,
  classifyIndustrialPermit,
  leeAreaCityNames,
  leeAreaPostalCodes,
  normalizeParcelIdentifier,
  readString,
  type CuratedCommercialCandidate,
  type PermitEvidenceRow,
  type SunbizAddressEvidenceRow,
} from "../src/loader/index.js";

type SelectionOptions = {
  readonly envFile: string;
  readonly includeLoadedProperties: boolean;
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
  readonly source_artifact_uri: string | null;
  readonly permit_link_count: number;
  readonly storable_document_link_count: number;
  readonly inspection_count: number;
  readonly contact_count: number;
};

type DetailedPermitEvidenceRow = PermitEvidenceRow & {
  readonly sourceArtifactUri: string | null;
};

type SunbizAddressQueryRow = {
  readonly normalized_address_key: string | null;
  readonly unnormalized_address: string | null;
  readonly city_name: string | null;
  readonly postal_code: string | null;
};

type IndustrialCandidateStats = {
  readonly industrialPermitCount: number;
  readonly industrialKeywordHits: readonly string[];
};

type MutableIndustrialCandidateStats = {
  industrialPermitCount: number;
  readonly industrialKeywordHits: Set<string>;
};

type IncrementalIndustrialCandidate = CuratedCommercialCandidate & IndustrialCandidateStats & {
  readonly detailGate: {
    readonly permitRowsLoadedFromDetailArtifacts: number;
    readonly requiredPermitDetailArtifact: true;
  };
};

type IncrementalIndustrialManifest = {
  readonly manifestVersion: "incremental-industrial-scope.v1";
  readonly generatedAt: string;
  readonly sourceDatabase: string;
  readonly selectionRules: readonly string[];
  readonly recommendedLoadOrder: readonly string[];
  readonly counts: {
    readonly loadedPermitDetailRows: number;
    readonly industrialPermitDetailRows: number;
    readonly sunbizAddressRows: number;
    readonly parcelGroupCount: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly permitRowsWithUsableParcel: number;
    readonly permitRowsWithUsableAddress: number;
    readonly sunbizAddressRowsWithUsableBase: number;
  };
  readonly candidates: readonly IncrementalIndustrialCandidate[];
};

const DEFAULT_OUTPUT = ".loader-runs/incremental-industrial/incremental-industrial-scope-manifest.json";
const DEFAULT_SEED_CSV_OUTPUT = ".loader-runs/incremental-industrial/incremental-industrial-appraisal-seed.csv";

/**
 * Select the next industrial-priority Lee County property cohort from already-loaded permit details.
 *
 * The output is compatible with `run-bulk-data-load.ts --scope-manifest`: the bulk
 * loader will load every permit detail for the selected parcels, the matching
 * appraisal artifacts, and the matching Sunbiz address/registration graph. This
 * keeps property rows gated on real permit details while allowing small cohorts
 * to be appended to Neon as soon as their appraisal artifacts exist.
 *
 * @returns Promise that resolves once the JSON scope manifest and appraisal seed CSV are written.
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
    application_name: "incremental-industrial-scope-selection",
    connectionTimeoutMillis: 15_000,
    max: 2,
    query_timeout: 180_000,
    statement_timeout: 180_000,
  });

  try {
    console.log(JSON.stringify({ event: "incremental_industrial_selection_started", options }));
    const loadedPermitRows = await readPermitDetailEvidence(pool, options.includeLoadedProperties);
    const industrialPermitRows = loadedPermitRows.filter((row) => classifyIndustrialPermit(row).isIndustrial);
    const permitStreetNumbers = extractPermitStreetNumbers(industrialPermitRows);
    const sunbizAddressRows = await readSunbizAddressEvidence(pool, permitStreetNumbers);
    const result = buildCuratedCommercialCandidates({
      permitRows: industrialPermitRows,
      requireCommercialPermit: false,
      sunbizAddressRows,
      limit: options.limit,
    });
    const industrialStatsByParcel = buildIndustrialStatsByParcel(industrialPermitRows);
    const candidates = result.selected.map((candidate): IncrementalIndustrialCandidate => {
      const stats = industrialStatsByParcel.get(candidate.parcelIdentifier) ?? {
        industrialPermitCount: candidate.permitCount,
        industrialKeywordHits: [],
      };
      return {
        ...candidate,
        ...stats,
        detailGate: {
          permitRowsLoadedFromDetailArtifacts: candidate.permitCount,
          requiredPermitDetailArtifact: true,
        },
      };
    });

    const manifest: IncrementalIndustrialManifest = {
      manifestVersion: "incremental-industrial-scope.v1",
      generatedAt: new Date().toISOString(),
      sourceDatabase: redactDatabaseUrl(databaseUrl),
      selectionRules: [
        "Only Lee Accela permit-detail rows already loaded into Neon are considered.",
        "Each considered permit row must have a source_artifact_uri, so candidate properties are gated on extracted permit-detail JSON rather than permit-list rows.",
        "Permit rows already linked to an Appraiser property are excluded unless --include-loaded-properties is set.",
        "Appraiser properties with exactly matching parcel identifiers are excluded unless --include-loaded-properties is set.",
        "At least one concrete industrial keyword must match permit type, description, project description, address, or related permit text.",
        "At least one non-void/non-test industrial permit row must be present for the parcel.",
        "At least one Lee-area Sunbiz address must match the permit street-number/street-name base so the scoped Sunbiz loader can attach business evidence in the same cohort.",
      ],
      recommendedLoadOrder: [
        "1. Load newly extracted permits globally: npm run load:bulk -- --tracks permits --env-file .env.local",
        "2. Build this manifest with a small --limit batch size.",
        "3. Build/run appraisal search/detail/media/tax artifacts for the manifest parcels.",
        "4. Replay the scoped cohort into Neon: npm run load:bulk -- --scope-manifest <manifest> --tracks appraisal,permits,sunbiz --env-file .env.local --appraisal-prefix <scoped-appraisal-prefix>",
        "5. Re-run the same scoped load after media/tax-backfill artifacts arrive; FK guards repair stable-source rows without waiting for the countywide extraction to finish.",
      ],
      counts: {
        loadedPermitDetailRows: loadedPermitRows.length,
        industrialPermitDetailRows: industrialPermitRows.length,
        sunbizAddressRows: sunbizAddressRows.length,
        parcelGroupCount: result.parcelGroupCount,
        candidateCount: result.candidateCount,
        selectedCount: candidates.length,
        permitRowsWithUsableParcel: result.permitRowsWithUsableParcel,
        permitRowsWithUsableAddress: result.permitRowsWithUsableAddress,
        sunbizAddressRowsWithUsableBase: result.sunbizAddressRowsWithUsableBase,
      },
      candidates,
    };

    await writeJson(options.output, manifest);
    await writeCsv(options.seedCsvOutput, serializeAppraisalSeedCsv(candidates));
    console.log(JSON.stringify({
      event: "incremental_industrial_selection_finished",
      output: options.output,
      seedCsvOutput: options.seedCsvOutput,
      counts: manifest.counts,
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Read permit-detail evidence currently available in Neon.
 *
 * @param pool - PostgreSQL connection pool for the query database.
 * @param includeLoadedProperties - Whether to include parcels whose appraiser property is already present.
 * @returns Permit rows with detail-artifact provenance and child-row counts.
 */
async function readPermitDetailEvidence(
  pool: Pool,
  includeLoadedProperties: boolean,
): Promise<readonly DetailedPermitEvidenceRow[]> {
  const result = await pool.query<PermitQueryRow>(
    `
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
        p.source_artifact_uri,
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
        and p.source_artifact_uri is not null
        and (
          $1::boolean
          or p.property_id is null
        )
        and (
          $1::boolean
          or not exists (
            select 1
            from parcels parcel
            join properties property on property.parcel_id = parcel.parcel_id
            where parcel.jurisdiction_key = 'lee_appraiser'
              and regexp_replace(parcel.parcel_identifier, '[^0-9]', '', 'g') = regexp_replace(p.parcel_identifier, '[^0-9]', '', 'g')
          )
        )
    `,
    [includeLoadedProperties],
  );

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
    sourceArtifactUri: row.source_artifact_uri,
    permitLinkCount: row.permit_link_count,
    storableDocumentLinkCount: row.storable_document_link_count,
    inspectionCount: row.inspection_count,
    contactCount: row.contact_count,
  }));
}

/**
 * Read Lee-area Sunbiz address rows whose street number appears in the selected permit evidence.
 *
 * @param pool - PostgreSQL connection pool for the query database.
 * @param permitStreetNumbers - Street numbers from industrial permit address bases.
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

function buildIndustrialStatsByParcel(
  rows: readonly DetailedPermitEvidenceRow[],
): ReadonlyMap<string, IndustrialCandidateStats> {
  const statsByParcel = new Map<string, MutableIndustrialCandidateStats>();
  for (const row of rows) {
    const parcelIdentifier = normalizeParcelIdentifier(row.parcelIdentifier);
    if (parcelIdentifier === null) continue;
    const classification = classifyIndustrialPermit(row);
    if (classification.isIndustrial === false) continue;
    const stats = statsByParcel.get(parcelIdentifier) ?? {
      industrialPermitCount: 0,
      industrialKeywordHits: new Set<string>(),
    };
    stats.industrialPermitCount += 1;
    for (const keyword of classification.matchedKeywords) stats.industrialKeywordHits.add(keyword);
    statsByParcel.set(parcelIdentifier, stats);
  }
  return new Map(
    [...statsByParcel.entries()].map(([parcelIdentifier, stats]) => [
      parcelIdentifier,
      {
        industrialPermitCount: stats.industrialPermitCount,
        industrialKeywordHits: [...stats.industrialKeywordHits].sort(),
      },
    ]),
  );
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
    if (streetNumber !== undefined && streetNumber.length > 0) streetNumbers.add(streetNumber);
  }
  return [...streetNumbers].sort();
}

function parseOptions(args: readonly string[]): SelectionOptions {
  let envFile = ".env.local";
  let includeLoadedProperties = false;
  let limit = 100;
  let output = DEFAULT_OUTPUT;
  let seedCsvOutput = DEFAULT_SEED_CSV_OUTPUT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const next = args[index + 1];
    if (arg === "--env-file" && next !== undefined) {
      envFile = next;
      index += 1;
    } else if (arg === "--include-loaded-properties") {
      includeLoadedProperties = true;
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

  return { envFile, includeLoadedProperties, limit, output, seedCsvOutput };
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

async function writeJson(path: string, value: IncrementalIndustrialManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCsv(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

function serializeAppraisalSeedCsv(candidates: readonly IncrementalIndustrialCandidate[]): string {
  const header = [
    "selection_rank",
    "parcel_identifier",
    "permit_address_base",
    "best_permit_address",
    "industrial_permit_count",
    "industrial_keyword_hits",
    "sunbiz_address_count",
    "sample_permit_numbers",
  ];
  const rows = candidates.map((candidate) =>
    [
      candidate.rank.toString(),
      candidate.parcelIdentifier,
      candidate.addressBase,
      candidate.bestPermitAddress,
      candidate.industrialPermitCount.toString(),
      candidate.industrialKeywordHits.join("|"),
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
