import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Pool } from "pg";

import { buildStreetAddressBase, normalizeParcelIdentifier, readString } from "../src/loader/index.js";

type SelectionOptions = {
  readonly envFile: string;
  readonly includeLinkedPermits: boolean;
  readonly limit: number;
  readonly output: string;
  readonly seedCsvOutput: string;
};

type AppraisalPropertyQueryRow = {
  readonly property_id: string;
  readonly request_identifier: string | null;
  readonly parcel_identifier: string | null;
  readonly source_artifact_uri: string | null;
  readonly property_usage_type: string | null;
  readonly property_type: string | null;
  readonly unnormalized_address: string | null;
  readonly normalized_address_key: string | null;
  readonly linked_permit_count: number;
};

type AppraisalFirstIndustrialCandidate = {
  readonly rank: number;
  readonly propertyId: string;
  readonly parcelIdentifier: string;
  readonly rawParcelIdentifiers: readonly string[];
  readonly requestIdentifier: string | null;
  readonly appraisalOutputS3Uri: string;
  readonly score: number;
  readonly addressBase: string;
  readonly bestPermitAddress: string;
  readonly permitCount: number;
  readonly commercialPermitCount: number;
  readonly nonVoidPermitCount: number;
  readonly inspectionCount: number;
  readonly contactCount: number;
  readonly permitLinkCount: number;
  readonly storableDocumentLinkCount: number;
  readonly sunbizAddressCount: number;
  readonly sunbizCities: readonly string[];
  readonly sunbizPostalCodes: readonly string[];
  readonly samplePermits: readonly [];
  readonly appraisalGate: {
    readonly requiredAppraisalArtifact: true;
    readonly propertyUsageType: string;
    readonly propertyType: string | null;
    readonly linkedPermitCountAtSelection: number;
  };
};

type AppraisalFirstIndustrialManifest = {
  readonly manifestVersion: "appraisal-first-industrial-scope.v1";
  readonly generatedAt: string;
  readonly sourceDatabase: string;
  readonly selectionRules: readonly string[];
  readonly recommendedLoadOrder: readonly string[];
  readonly counts: {
    readonly industrialAppraisalRows: number;
    readonly selectedCount: number;
    readonly skippedMissingParcel: number;
    readonly skippedMissingAddressBase: number;
    readonly skippedMissingArtifact: number;
  };
  readonly candidates: readonly AppraisalFirstIndustrialCandidate[];
};

const DEFAULT_OUTPUT = ".loader-runs/property-first-industrial/appraisal-first-industrial-scope-manifest.json";
const DEFAULT_SEED_CSV_OUTPUT = ".loader-runs/property-first-industrial/appraisal-first-industrial-seed.csv";
const INDUSTRIAL_USAGE_TYPES = ["Industrial", "LightManufacturing"] as const;

/**
 * Select industrial properties from appraisal rows that already completed the
 * property-appraiser extraction, so the next step can harvest Accela permits for
 * these specific parcels instead of waiting for the countywide permit backfill.
 *
 * The manifest is intentionally compatible with the existing scoped bulk loader
 * and the oracle-node `harvest-lee-permits-by-parcel.mjs` runner: it contains
 * appraiser artifact URIs, normalized parcel identifiers, and address bases.
 *
 * @returns Promise that resolves once the JSON scope manifest and CSV summary are written.
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
    application_name: "appraisal-first-industrial-scope-selection",
    connectionTimeoutMillis: 15_000,
    max: 2,
    query_timeout: 180_000,
    statement_timeout: 180_000,
  });

  try {
    console.log(JSON.stringify({ event: "appraisal_first_industrial_selection_started", options }));
    const rows = await readIndustrialAppraisalRows(pool, options.includeLinkedPermits);
    const buildResult = buildCandidates(rows, options.limit);
    const manifest: AppraisalFirstIndustrialManifest = {
      manifestVersion: "appraisal-first-industrial-scope.v1",
      generatedAt: new Date().toISOString(),
      sourceDatabase: redactDatabaseUrl(databaseUrl),
      selectionRules: [
        "Only Lee Appraiser property rows already loaded into Neon are considered.",
        "The appraiser property_usage_type must be Industrial or LightManufacturing.",
        "Each selected row must have a transformed appraisal artifact URI so scoped loads can replay the property when needed.",
        "Each selected row must have a usable parcel identifier for Accela Parcel No. search.",
        "Rows already linked to Lee Accela permits are excluded unless --include-linked-permits is set.",
      ],
      recommendedLoadOrder: [
        "1. Harvest permits for this manifest: node ../oracle-node/scripts/harvest-lee-permits-by-parcel.mjs --manifest <manifest> --job-id <job>",
        "2. Load the property-first permit artifacts immediately: npm run load:bulk -- --tracks permits --permit-prefix permit-harvest/<job>/lee/extracted/permits/ --env-file .env.local",
        "3. Re-link the selected permits to appraisals: npm run load:link-scoped-permits -- --manifest <manifest> --env-file .env.local",
        "4. Optionally replay scoped appraisal and Sunbiz rows: npm run load:bulk -- --scope-manifest <manifest> --tracks appraisal,sunbiz --env-file .env.local --appraisal-prefix <scoped-appraisal-prefix>",
      ],
      counts: {
        industrialAppraisalRows: rows.length,
        selectedCount: buildResult.candidates.length,
        skippedMissingParcel: buildResult.skippedMissingParcel,
        skippedMissingAddressBase: buildResult.skippedMissingAddressBase,
        skippedMissingArtifact: buildResult.skippedMissingArtifact,
      },
      candidates: buildResult.candidates,
    };

    await writeJson(options.output, manifest);
    await writeCsv(options.seedCsvOutput, serializeSeedCsv(manifest.candidates));
    console.log(JSON.stringify({
      event: "appraisal_first_industrial_selection_finished",
      output: options.output,
      seedCsvOutput: options.seedCsvOutput,
      counts: manifest.counts,
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Read appraiser rows that are already known to be industrial-class properties.
 *
 * @param pool - PostgreSQL pool connected to Neon.
 * @param includeLinkedPermits - Whether to include rows already linked to Accela permits.
 * @returns Industrial appraiser property rows with address and linked-permit counts.
 */
async function readIndustrialAppraisalRows(
  pool: Pool,
  includeLinkedPermits: boolean,
): Promise<readonly AppraisalPropertyQueryRow[]> {
  const result = await pool.query<AppraisalPropertyQueryRow>(
    `
      with linked_counts as (
        select property_id, count(*)::int as linked_permit_count
        from property_improvements
        where source_system = 'lee_accela'
          and property_id is not null
        group by property_id
      )
      select
        property.property_id::text,
        property.request_identifier,
        property.parcel_identifier,
        property.source_artifact_uri,
        property.source_payload->>'property_usage_type' as property_usage_type,
        property.property_type,
        address.unnormalized_address,
        address.normalized_address_key,
        coalesce(linked.linked_permit_count, 0)::int as linked_permit_count
      from properties property
      left join addresses address on address.address_id = property.address_id
      left join linked_counts linked on linked.property_id = property.property_id
      where property.source_system = 'lee_appraiser'
        and property.source_payload->>'property_usage_type' = any($1::text[])
        and ($2::boolean or coalesce(linked.linked_permit_count, 0) = 0)
      order by property.updated_at desc nulls last, property.request_identifier nulls last
    `,
    [INDUSTRIAL_USAGE_TYPES, includeLinkedPermits],
  );
  return result.rows;
}

type CandidateBuildResult = {
  readonly candidates: readonly AppraisalFirstIndustrialCandidate[];
  readonly skippedMissingParcel: number;
  readonly skippedMissingAddressBase: number;
  readonly skippedMissingArtifact: number;
};

/**
 * Convert raw appraiser DB rows into scoped-load candidates.
 *
 * @param rows - Industrial appraiser rows read from Neon.
 * @param limit - Maximum selected candidates.
 * @returns Candidate list and skip counters.
 */
function buildCandidates(rows: readonly AppraisalPropertyQueryRow[], limit: number): CandidateBuildResult {
  const candidates: AppraisalFirstIndustrialCandidate[] = [];
  let skippedMissingParcel = 0;
  let skippedMissingAddressBase = 0;
  let skippedMissingArtifact = 0;

  for (const row of rows) {
    if (candidates.length >= limit) break;
    const parcelIdentifier = normalizeParcelIdentifier(row.parcel_identifier);
    if (parcelIdentifier === null) {
      skippedMissingParcel += 1;
      continue;
    }
    const addressBase = buildStreetAddressBase(row.normalized_address_key ?? row.unnormalized_address);
    if (addressBase === null) {
      skippedMissingAddressBase += 1;
      continue;
    }
    const appraisalOutputS3Uri = readString(row.source_artifact_uri);
    if (appraisalOutputS3Uri === null) {
      skippedMissingArtifact += 1;
      continue;
    }
    const propertyUsageType = readString(row.property_usage_type) ?? "Industrial";
    const rank = candidates.length + 1;
    candidates.push({
      rank,
      propertyId: row.property_id,
      parcelIdentifier,
      rawParcelIdentifiers: [row.parcel_identifier ?? parcelIdentifier],
      requestIdentifier: readString(row.request_identifier),
      appraisalOutputS3Uri,
      score: industrialUsageScore(propertyUsageType, row.linked_permit_count),
      addressBase,
      bestPermitAddress: row.unnormalized_address ?? addressBase,
      permitCount: row.linked_permit_count,
      commercialPermitCount: row.linked_permit_count,
      nonVoidPermitCount: row.linked_permit_count,
      inspectionCount: 0,
      contactCount: 0,
      permitLinkCount: 0,
      storableDocumentLinkCount: 0,
      sunbizAddressCount: 0,
      sunbizCities: [],
      sunbizPostalCodes: [],
      samplePermits: [],
      appraisalGate: {
        requiredAppraisalArtifact: true,
        propertyUsageType,
        propertyType: row.property_type,
        linkedPermitCountAtSelection: row.linked_permit_count,
      },
    });
  }

  return {
    candidates,
    skippedMissingParcel,
    skippedMissingAddressBase,
    skippedMissingArtifact,
  };
}

/**
 * Score appraiser-selected industrial properties for deterministic ordering.
 *
 * @param propertyUsageType - Appraiser usage type.
 * @param linkedPermitCount - Already linked Accela permits at selection time.
 * @returns Numeric score kept for compatibility with existing manifests.
 */
function industrialUsageScore(propertyUsageType: string, linkedPermitCount: number): number {
  const usageScore = propertyUsageType === "LightManufacturing" ? 120 : 100;
  return usageScore + linkedPermitCount;
}

/**
 * Parse CLI options.
 *
 * @param args - Raw process args after script name.
 * @returns Normalized options.
 */
function parseOptions(args: readonly string[]): SelectionOptions {
  const values = readCliValues(args);
  return {
    envFile: values.get("env-file") ?? ".env.local",
    includeLinkedPermits: values.has("include-linked-permits"),
    limit: parsePositiveInteger(values.get("limit"), "limit") ?? 25,
    output: values.get("output") ?? DEFAULT_OUTPUT,
    seedCsvOutput: values.get("seed-output") ?? DEFAULT_SEED_CSV_OUTPUT,
  };
}

/**
 * Convert CLI `--key value` and `--key=value` args into a map.
 *
 * @param args - Raw CLI args.
 * @returns Parsed key/value map.
 */
function readCliValues(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === undefined || raw.startsWith("--") === false) continue;
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex > 2) {
      values.set(raw.slice(2, equalsIndex), raw.slice(equalsIndex + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = args[index + 1];
    if (next !== undefined && next.startsWith("--") === false) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }
  return values;
}

/**
 * Parse an optional positive integer option.
 *
 * @param value - Raw value.
 * @param fieldName - Field name for errors.
 * @returns Positive integer or null when omitted.
 */
function parsePositiveInteger(value: string | undefined, fieldName: string): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${fieldName}: ${value}`);
  return parsed;
}

/**
 * Load a dotenv-style env file without overriding existing environment values.
 *
 * @param path - Env file path.
 * @returns Promise that resolves once variables have been merged into process.env.
 */
async function loadEnvFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

/**
 * Write a JSON manifest file.
 *
 * @param path - Output path.
 * @param value - Manifest value.
 */
async function writeJson(path: string, value: AppraisalFirstIndustrialManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Write a CSV summary file.
 *
 * @param path - Output path.
 * @param text - CSV text.
 */
async function writeCsv(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/**
 * Serialize selected candidates as a compact CSV summary.
 *
 * @param candidates - Selected appraiser-first industrial candidates.
 * @returns CSV text.
 */
function serializeSeedCsv(candidates: readonly AppraisalFirstIndustrialCandidate[]): string {
  const header = [
    "selection_rank",
    "parcel_identifier",
    "folio_id",
    "address_base",
    "best_property_address",
    "property_usage_type",
    "linked_permit_count_at_selection",
    "appraisal_output_s3_uri",
  ];
  const rows = candidates.map((candidate) =>
    [
      candidate.rank.toString(),
      candidate.parcelIdentifier,
      candidate.requestIdentifier ?? "",
      candidate.addressBase,
      candidate.bestPermitAddress,
      candidate.appraisalGate.propertyUsageType,
      candidate.appraisalGate.linkedPermitCountAtSelection.toString(),
      candidate.appraisalOutputS3Uri,
    ]
      .map(escapeCsvCell)
      .join(","),
  );
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

/**
 * Escape one CSV cell when needed.
 *
 * @param value - Raw cell text.
 * @returns CSV-safe cell text.
 */
function escapeCsvCell(value: string): string {
  if (/["\n,]/.test(value) === false) return value;
  return `"${value.replace(/"/g, "\"\"")}"`;
}

/**
 * Redact username/password from a database URL for logs/manifests.
 *
 * @param databaseUrl - Full database URL.
 * @returns Redacted URL string.
 */
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "appraisal_first_industrial_selection_failed", error: message }));
    process.exitCode = 1;
  });
}
