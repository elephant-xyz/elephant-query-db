import { readFile } from "node:fs/promises";
import { Pool } from "pg";

import { isJsonObject, normalizeParcelIdentifier, readString } from "../src/loader/index.js";

type LinkOptions = {
  readonly envFile: string;
  readonly manifestPath: string;
};

type ManifestCandidate = {
  readonly parcelIdentifier: string;
  readonly rawParcelIdentifiers: readonly string[];
  readonly appraisalOutputS3Uri: string;
};

type LinkMapping = {
  readonly permitParcelIdentifier: string;
  readonly appraisalOutputS3Uri: string;
  readonly appraisalRequestIdentifier: string | null;
};

type LinkSummaryRow = {
  readonly permit_parcel_identifier: string;
  readonly appraisal_output_s3_uri: string;
  readonly appraisal_parcel_identifier: string;
  readonly matched_permit_rows: string;
  readonly linked_permit_rows: string;
};

const DEFAULT_ENV_FILE = ".env.local";

/**
 * Link scoped Lee Accela permit-detail rows to already-loaded Lee Appraiser properties.
 *
 * The incremental industrial workflow discovers Appraiser parcels from Accela
 * permit parcels, but the two systems sometimes format parcel identifiers
 * differently. The scoped manifest is the durable evidence connecting an
 * Accela parcel candidate to an exact media-enriched Appraiser artifact. This
 * script uses that manifest-level mapping to fill `property_improvements` direct
 * `property_id` and `parcel_id` foreign keys after the Appraiser artifact has
 * been loaded into Neon.
 *
 * @returns Promise that resolves after all manifest mappings have been applied.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await loadEnvFile(options.envFile);
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile} or the environment`);
  }

  const candidates = await readManifestCandidates(options.manifestPath);
  const mappings = buildMappings(candidates);
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "link-scoped-permits-to-appraisals",
    connectionTimeoutMillis: 15_000,
    max: 2,
    query_timeout: 180_000,
    statement_timeout: 180_000,
  });

  try {
    console.log(JSON.stringify({
      event: "scoped_permit_appraisal_link_started",
      manifestPath: options.manifestPath,
      candidateCount: candidates.length,
      mappingCount: mappings.length,
    }));
    const result = await pool.query<LinkSummaryRow>(
      `
        with mapping as (
          select distinct
            permit_parcel_identifier,
            appraisal_output_s3_uri,
            appraisal_request_identifier
          from jsonb_to_recordset($1::jsonb) as item(
            permit_parcel_identifier text,
            appraisal_output_s3_uri text,
            appraisal_request_identifier text
          )
        ),
        property_map as (
          select
            mapping.permit_parcel_identifier,
            mapping.appraisal_output_s3_uri,
            property.property_id,
            property.parcel_id,
            property.parcel_identifier as appraisal_parcel_identifier
          from mapping
          join properties property
            on property.source_system = 'lee_appraiser'
           and (
             property.source_artifact_uri = mapping.appraisal_output_s3_uri
             or property.request_identifier = mapping.appraisal_request_identifier
           )
        ),
        matched as (
          select
            property_map.permit_parcel_identifier,
            property_map.appraisal_output_s3_uri,
            property_map.appraisal_parcel_identifier,
            count(permit.*)::bigint as matched_permit_rows
          from property_map
          left join property_improvements permit
            on permit.source_system = 'lee_accela'
           and regexp_replace(permit.parcel_identifier, '[^0-9]', '', 'g') = property_map.permit_parcel_identifier
          group by
            property_map.permit_parcel_identifier,
            property_map.appraisal_output_s3_uri,
            property_map.appraisal_parcel_identifier
        ),
        updated as (
          update property_improvements permit
             set property_id = property_map.property_id,
                 parcel_id = property_map.parcel_id,
                 property_match_method = 'scoped_manifest_appraisal_artifact',
                 property_match_confidence = 'high',
                 updated_at = now()
          from property_map
          where permit.source_system = 'lee_accela'
            and regexp_replace(permit.parcel_identifier, '[^0-9]', '', 'g') = property_map.permit_parcel_identifier
            and (
              permit.property_id is distinct from property_map.property_id
              or permit.parcel_id is distinct from property_map.parcel_id
              or permit.property_match_method is distinct from 'scoped_manifest_appraisal_artifact'
              or permit.property_match_confidence is distinct from 'high'
            )
          returning
            property_map.permit_parcel_identifier,
            property_map.appraisal_output_s3_uri,
            property_map.appraisal_parcel_identifier,
            permit.property_improvement_id
        )
        select
          matched.permit_parcel_identifier,
          matched.appraisal_output_s3_uri,
          matched.appraisal_parcel_identifier,
          matched.matched_permit_rows::text,
          count(updated.property_improvement_id)::text as linked_permit_rows
        from matched
        left join updated
          on updated.permit_parcel_identifier = matched.permit_parcel_identifier
         and updated.appraisal_output_s3_uri = matched.appraisal_output_s3_uri
        group by
          matched.permit_parcel_identifier,
          matched.appraisal_output_s3_uri,
          matched.appraisal_parcel_identifier,
          matched.matched_permit_rows
        order by matched.permit_parcel_identifier
      `,
      [JSON.stringify(mappings.map((mapping) => ({
        permit_parcel_identifier: mapping.permitParcelIdentifier,
        appraisal_output_s3_uri: mapping.appraisalOutputS3Uri,
        appraisal_request_identifier: mapping.appraisalRequestIdentifier,
      })))],
    );
    console.log(JSON.stringify({
      event: "scoped_permit_appraisal_link_finished",
      rows: result.rows.map((row) => ({
        permitParcelIdentifier: row.permit_parcel_identifier,
        appraisalOutputS3Uri: row.appraisal_output_s3_uri,
        appraisalParcelIdentifier: row.appraisal_parcel_identifier,
        matchedPermitRows: Number(row.matched_permit_rows),
        linkedPermitRows: Number(row.linked_permit_rows),
      })),
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Convert manifest candidates into deduplicated permit/appraisal mapping rows.
 *
 * @param candidates - Validated manifest candidates.
 * @returns Unique mapping rows keyed by normalized Accela permit parcel and Appraiser artifact URI.
 */
function buildMappings(candidates: readonly ManifestCandidate[]): readonly LinkMapping[] {
  const mappings = new Map<string, LinkMapping>();
  for (const candidate of candidates) {
    for (const rawIdentifier of [candidate.parcelIdentifier, ...candidate.rawParcelIdentifiers]) {
      const permitParcelIdentifier = normalizeParcelIdentifier(rawIdentifier);
      if (permitParcelIdentifier === null) continue;
      const key = `${permitParcelIdentifier}\n${candidate.appraisalOutputS3Uri}`;
      mappings.set(key, {
        permitParcelIdentifier,
        appraisalOutputS3Uri: candidate.appraisalOutputS3Uri,
        appraisalRequestIdentifier: extractAppraisalRequestIdentifier(candidate.appraisalOutputS3Uri),
      });
    }
  }
  return [...mappings.values()].sort((left, right) => {
    const parcelOrder = left.permitParcelIdentifier.localeCompare(right.permitParcelIdentifier);
    return parcelOrder === 0 ? left.appraisalOutputS3Uri.localeCompare(right.appraisalOutputS3Uri) : parcelOrder;
  });
}

/**
 * Extract the Lee Appraiser Folio ID from a transformed artifact URI.
 *
 * Appraisal artifacts generated by the incremental workflow include a stable
 * `folio-<id>` segment. That Folio ID is the same value stored as
 * `properties.request_identifier`, so it lets the linker find properties that
 * were inserted by an older enriched artifact path before the current manifest
 * artifact was replayed.
 *
 * @param appraisalOutputS3Uri - Media-enriched appraisal transformed ZIP URI.
 * @returns Folio/request identifier, or `null` when the URI does not expose one.
 */
function extractAppraisalRequestIdentifier(appraisalOutputS3Uri: string): string | null {
  const match = /folio-(\d+)/i.exec(appraisalOutputS3Uri);
  return match?.[1] ?? null;
}

/**
 * Read candidate mappings from a scoped load manifest.
 *
 * @param manifestPath - Local JSON manifest path.
 * @returns Validated candidates with Accela parcel identifiers and exact Appraiser artifact URIs.
 */
async function readManifestCandidates(manifestPath: string): Promise<readonly ManifestCandidate[]> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isJsonObject(parsed) || !Array.isArray(parsed.candidates)) {
    throw new Error(`Scoped manifest is missing candidates array: ${manifestPath}`);
  }
  return parsed.candidates.map((candidate, index) => readManifestCandidate(candidate, `${manifestPath}:candidate:${String(index)}`));
}

/**
 * Validate one scoped manifest candidate.
 *
 * @param value - Unknown candidate JSON value.
 * @param source - Human-readable source label for diagnostics.
 * @returns Candidate fields required for permit/appraisal linking.
 */
function readManifestCandidate(value: unknown, source: string): ManifestCandidate {
  if (!isJsonObject(value)) throw new Error(`Manifest candidate must be an object: ${source}`);
  const parcelIdentifier = readString(value.parcelIdentifier);
  const appraisalOutputS3Uri = readString(value.appraisalOutputS3Uri);
  if (parcelIdentifier === null) throw new Error(`Manifest candidate is missing parcelIdentifier: ${source}`);
  if (appraisalOutputS3Uri === null) throw new Error(`Manifest candidate is missing appraisalOutputS3Uri: ${source}`);
  const rawParcelIdentifiers = Array.isArray(value.rawParcelIdentifiers)
    ? value.rawParcelIdentifiers.flatMap((item) => {
        const text = readString(item);
        return text === null ? [] : [text];
      })
    : [];
  return { parcelIdentifier, rawParcelIdentifiers, appraisalOutputS3Uri };
}

/**
 * Load KEY=VALUE pairs from a dotenv-style file into `process.env`.
 *
 * @param path - Environment file path.
 * @returns Promise that resolves after variables have been loaded.
 */
async function loadEnvFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
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

/**
 * Parse command-line options.
 *
 * @param args - Raw command-line arguments after the script name.
 * @returns Linker options.
 */
function parseOptions(args: readonly string[]): LinkOptions {
  let envFile = DEFAULT_ENV_FILE;
  let manifestPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--env-file" && next !== undefined) {
      envFile = next;
      index += 1;
    } else if (arg === "--manifest" && next !== undefined) {
      manifestPath = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg ?? ""}`);
    }
  }
  if (manifestPath === null) throw new Error("--manifest is required");
  return { envFile, manifestPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "scoped_permit_appraisal_link_failed", error: message }));
    process.exitCode = 1;
  });
}
