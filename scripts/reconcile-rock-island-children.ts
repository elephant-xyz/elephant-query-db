import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { ParquetReader } from "@dsnp/parquetjs";
import AdmZip from "adm-zip";
import { Pool } from "pg";

import {
  mapAppraisalTransformedFile,
  parseAppraisalSourcePayloadSidecar,
  type JsonObject,
} from "../src/loader/index.js";
import { artifactPathOnEbs } from "./repair-rock-island-geometry-source-payload.js";

const SOURCE_SYSTEM = "rock_island_appraiser";
const EXPECTED_FOLIOS = 65_806;
const FOLIO_PATTERN = /^[0-9]{10}$/u;

export type ReconciliationOptions = {
  readonly seedPath: string;
  readonly hashIndexRoot: string;
  readonly publicQueryTablePath: string;
  readonly outputDirectory: string;
  readonly concurrency: number;
};

export type ChildFailureClass =
  | "ok"
  | "genuine_source_null"
  | "missing_or_invalid_transform_output"
  | "schema_validation_failure"
  | "loader_mapper_rejection"
  | "loader_not_merged"
  | "parent_fk_resolution_failure"
  | "conflict_or_deduplication"
  | "other";

type DbParcelRow = {
  readonly request_identifier: string;
  readonly source_artifact_uri: string;
};

type DbPropertyRow = {
  readonly request_identifier: string;
  readonly parcel_id: string | null;
  readonly address_id: string | null;
};

type DbAddressRow = {
  readonly request_identifier: string;
};

type DbLotRow = {
  readonly request_identifier: string;
  readonly property_id: string | null;
};

type DuplicateRow = {
  readonly request_identifier: string;
  readonly row_count: string;
};

type ArtifactEvidence = {
  readonly folio: string;
  readonly artifactUri: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly preparedCapturePresent: boolean;
  readonly readyMarkerPresent: boolean;
  readonly validationReportPresent: boolean;
  readonly validationIssueCount: number;
  readonly parcelOutputPresent: boolean;
  readonly propertyOutputPresent: boolean;
  readonly addressOutputPresent: boolean;
  readonly lotOutputPresent: boolean;
  readonly propertyMapped: boolean;
  readonly addressMapped: boolean;
  readonly lotMapped: boolean;
  readonly sourceHasDefensibleSiteAddress: boolean;
  readonly sourceHasPositiveLotArea: boolean;
  readonly sourceSiteAddress: string | null;
  readonly sourceSiteCityStateZip: string | null;
  readonly requestIdentifierMismatch: boolean;
};

export type FolioEvidence = {
  readonly folio: string;
  readonly inSeed: boolean;
  readonly inPreparedArtifacts: boolean;
  readonly inTransformedArtifacts: boolean;
  readonly inLoaderHashIndex: boolean;
  readonly inDbParcel: boolean;
  readonly inDbProperty: boolean;
  readonly inDbAddress: boolean;
  readonly inDbLot: boolean;
  readonly inPublicQueryTable: boolean;
  readonly propertyParcelIdPresent: boolean;
  readonly propertyAddressIdPresent: boolean;
  readonly lotPropertyIdPresent: boolean;
  readonly artifactUri: string | null;
  readonly artifactSha256: string | null;
  readonly validationReportPresent: boolean;
  readonly validationIssueCount: number;
  readonly propertyOutputPresent: boolean;
  readonly addressOutputPresent: boolean;
  readonly lotOutputPresent: boolean;
  readonly propertyMapped: boolean;
  readonly addressMapped: boolean;
  readonly lotMapped: boolean;
  readonly sourceHasDefensibleSiteAddress: boolean;
  readonly sourceHasPositiveLotArea: boolean;
  readonly sourceSiteAddress: string | null;
  readonly sourceSiteCityStateZip: string | null;
  readonly requestIdentifierMismatch: boolean;
  readonly propertyClass: ChildFailureClass;
  readonly addressClass: ChildFailureClass;
  readonly lotClass: ChildFailureClass;
};

type HashIndex = {
  readonly version: number;
  readonly artifacts: Readonly<Record<string, unknown>>;
};

type PublicQueryInventory = {
  readonly rowCount: number;
  readonly nullFolioCount: number;
  readonly folios: ReadonlySet<string>;
  readonly duplicateFolios: readonly string[];
};

type DbInventory = {
  readonly parcels: ReadonlyMap<string, DbParcelRow>;
  readonly properties: ReadonlyMap<string, DbPropertyRow>;
  readonly addresses: ReadonlySet<string>;
  readonly lots: ReadonlyMap<string, DbLotRow>;
  readonly duplicates: Readonly<Record<string, readonly DuplicateRow[]>>;
};

type ReconciliationResult = {
  readonly report: Readonly<Record<string, unknown>>;
  readonly evidence: readonly FolioEvidence[];
  readonly backfillFolios: readonly string[];
};

/**
 * Return true only when a value is a plain JSON object.
 *
 * @param value - Candidate parsed JSON value.
 * @returns Whether the candidate is a JSON object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a non-empty source value as trimmed text.
 *
 * @param value - Source value from the retained ArcGIS response.
 * @returns Trimmed source text or null.
 */
function readText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

/**
 * Read a finite source number without inventing a fallback.
 *
 * @param value - Source numeric value.
 * @returns Finite number or null.
 */
function readNumber(value: unknown): number | null {
  const text = readText(value);
  if (text === null) return null;
  const parsed = Number(text.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Check whether a local file exists without following missing-path errors.
 *
 * @param path - Absolute local file path.
 * @returns Whether the file can be accessed.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse command-line options for the exact Rock Island reconciliation.
 *
 * @param argv - Command-line arguments after the script path.
 * @returns Validated local evidence paths and bounded concurrency.
 */
export function parseReconciliationOptions(
  argv: readonly string[],
): ReconciliationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (
      token?.startsWith("--") === true &&
      next !== undefined &&
      !next.startsWith("--")
    ) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const seedPath = values.get("seed");
  const hashIndexRoot = values.get("hash-index-root");
  const publicQueryTablePath = values.get("public-query-table");
  const outputDirectory = values.get("output-dir");
  if (
    seedPath === undefined ||
    hashIndexRoot === undefined ||
    publicQueryTablePath === undefined ||
    outputDirectory === undefined
  ) {
    throw new Error(
      "--seed, --hash-index-root, --public-query-table, and --output-dir are required",
    );
  }
  const concurrency = Number.parseInt(values.get("concurrency") ?? "12", 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("--concurrency must be between 1 and 32");
  }
  return {
    seedPath,
    hashIndexRoot,
    publicQueryTablePath,
    outputDirectory,
    concurrency,
  };
}

/**
 * Read canonical request identifiers from the generated seed CSV.
 *
 * Rock Island's first CSV column is the unquoted ten-digit `parcel_id`. Reading
 * only that column avoids materializing the 100+ MB GeoJSON and source payload
 * columns while still using the exact canonical seed artifact.
 *
 * @param seedPath - Exact seed CSV used by the completed county run.
 * @returns Ordered canonical folios plus any duplicate identifiers.
 */
export async function readCanonicalSeedFolios(seedPath: string): Promise<{
  readonly folios: readonly string[];
  readonly duplicateFolios: readonly string[];
}> {
  const input = createReadStream(seedPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const folios: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      if (!line.startsWith("parcel_id,")) {
        throw new Error("Rock Island seed does not start with parcel_id");
      }
      continue;
    }
    if (line.trim().length === 0) continue;
    const commaIndex = line.indexOf(",");
    const folio = commaIndex < 0 ? line : line.slice(0, commaIndex);
    if (!FOLIO_PATTERN.test(folio)) {
      throw new Error(`Invalid seed folio at line ${lineNumber}: ${folio}`);
    }
    if (seen.has(folio)) duplicates.add(folio);
    else seen.add(folio);
    folios.push(folio);
  }
  return {
    folios,
    duplicateFolios: [...duplicates].sort(),
  };
}

/**
 * Read every job-scoped loader hash index below the county staging root.
 *
 * @param root - County loader staging directory containing job subdirectories.
 * @returns Set keyed as `<jobId>/<folio>` for successfully merged artifacts.
 */
export async function readLoaderIndexedFolios(
  root: string,
): Promise<ReadonlySet<string>> {
  const indexed = new Set<string>();
  const jobs = await readdir(root, { withFileTypes: true });
  for (const job of jobs) {
    if (!job.isDirectory()) continue;
    const indexPath = join(root, job.name, "appraisal-hashes.json");
    if (!(await exists(indexPath))) continue;
    const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
    if (
      !isJsonObject(parsed) ||
      parsed.version !== 1 ||
      !isJsonObject(parsed.artifacts)
    ) {
      throw new Error(`Invalid loader hash index: ${indexPath}`);
    }
    const index = /** @type {HashIndex} */ (parsed) as HashIndex;
    for (const [relativePath, hash] of Object.entries(index.artifacts)) {
      const folio = relativePath.split("/")[0];
      if (!FOLIO_PATTERN.test(folio ?? "") || typeof hash !== "string") {
        throw new Error(`Invalid loader hash entry: ${indexPath}:${relativePath}`);
      }
      indexed.add(`${job.name}/${folio}`);
    }
  }
  return indexed;
}

/**
 * Read exact request identifiers from the current public query-table Parquet.
 *
 * @param parquetPath - Current dry-run/public query-table artifact.
 * @returns Row, null, distinct, and duplicate folio evidence.
 */
export async function readPublicQueryInventory(
  parquetPath: string,
): Promise<PublicQueryInventory> {
  const reader = await ParquetReader.openFile(parquetPath);
  const counts = new Map<string, number>();
  let rowCount = 0;
  let nullFolioCount = 0;
  try {
    const cursor = reader.getCursor([["request_identifier"]]);
    let record = (await cursor.next()) as
      | { readonly request_identifier?: unknown }
      | null;
    while (record !== null) {
      rowCount += 1;
      const folio = readText(record.request_identifier);
      if (folio === null) nullFolioCount += 1;
      else counts.set(folio, (counts.get(folio) ?? 0) + 1);
      record = (await cursor.next()) as
        | { readonly request_identifier?: unknown }
        | null;
    }
  } finally {
    await reader.close();
  }
  return {
    rowCount,
    nullFolioCount,
    folios: new Set(counts.keys()),
    duplicateFolios: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([folio]) => folio)
      .sort(),
  };
}

/**
 * Load exact normalized child state and duplicate evidence by folio.
 *
 * @param pool - Connected PostgreSQL pool.
 * @returns Source-scoped parcel/property/address/lot inventory.
 */
async function readDbInventory(pool: Pool): Promise<DbInventory> {
  const [parcels, properties, addresses, lots] = await Promise.all([
    pool.query<DbParcelRow>(
      `SELECT request_identifier, source_artifact_uri
         FROM parcels
        WHERE source_system = $1
          AND request_identifier IS NOT NULL
          AND source_artifact_uri IS NOT NULL
        ORDER BY request_identifier`,
      [SOURCE_SYSTEM],
    ),
    pool.query<DbPropertyRow>(
      `SELECT request_identifier, parcel_id, address_id
         FROM properties
        WHERE source_system = $1
          AND request_identifier IS NOT NULL
        ORDER BY request_identifier`,
      [SOURCE_SYSTEM],
    ),
    pool.query<DbAddressRow>(
      `SELECT request_identifier
         FROM addresses
        WHERE source_system = $1
          AND request_identifier IS NOT NULL
        ORDER BY request_identifier`,
      [SOURCE_SYSTEM],
    ),
    pool.query<DbLotRow>(
      `SELECT request_identifier, property_id
         FROM lots
        WHERE source_system = $1
          AND request_identifier IS NOT NULL
        ORDER BY request_identifier`,
      [SOURCE_SYSTEM],
    ),
  ]);
  const duplicateTables = ["parcels", "properties", "addresses", "lots"] as const;
  const duplicateResults = await Promise.all(
    duplicateTables.map((table) =>
      pool.query<DuplicateRow>(
        `SELECT request_identifier, count(*)::text AS row_count
           FROM ${table}
          WHERE source_system = $1
            AND request_identifier IS NOT NULL
          GROUP BY request_identifier
         HAVING count(*) > 1
          ORDER BY request_identifier`,
        [SOURCE_SYSTEM],
      ),
    ),
  );
  return {
    parcels: new Map(parcels.rows.map((row) => [row.request_identifier, row])),
    properties: new Map(
      properties.rows.map((row) => [row.request_identifier, row]),
    ),
    addresses: new Set(addresses.rows.map((row) => row.request_identifier)),
    lots: new Map(lots.rows.map((row) => [row.request_identifier, row])),
    duplicates: Object.fromEntries(
      duplicateTables.map((table, index) => [
        table,
        duplicateResults[index]?.rows ?? [],
      ]),
    ),
  };
}

/**
 * Resolve the loader-index key represented by a retained artifact path.
 *
 * @param artifactPath - EBS path ending in `<jobId>/<folio>/transformed.zip`.
 * @returns `<jobId>/<folio>` key.
 */
export function loaderIndexKeyForArtifact(artifactPath: string): string {
  const folio = basename(dirname(artifactPath));
  const jobId = basename(dirname(dirname(artifactPath)));
  if (!FOLIO_PATTERN.test(folio) || jobId.length === 0) {
    throw new Error(`Invalid Rock Island artifact path: ${artifactPath}`);
  }
  return `${jobId}/${folio}`;
}

/**
 * Select the same lowest-OBJECTID source feature used by the transform.
 *
 * @param sourcePayload - Parsed retained ArcGIS source sidecar.
 * @returns Primary feature properties.
 */
function readPrimarySourceProperties(sourcePayload: JsonObject): JsonObject {
  const response = sourcePayload.response;
  if (!isJsonObject(response) || !Array.isArray(response.features)) {
    throw new Error("Rock Island source payload has no features");
  }
  const properties = response.features
    .filter(isJsonObject)
    .map((feature) => feature.properties)
    .filter(isJsonObject)
    .sort((left, right) => {
      const leftObjectId = readNumber(left.OBJECTID) ?? Number.MAX_SAFE_INTEGER;
      const rightObjectId =
        readNumber(right.OBJECTID) ?? Number.MAX_SAFE_INTEGER;
      return leftObjectId - rightObjectId;
    });
  const primary = properties[0];
  if (primary === undefined) {
    throw new Error("Rock Island source payload has no valid feature properties");
  }
  return primary;
}

/**
 * Count schema validator findings in the exact adjacent validation CSV.
 *
 * Header-only CSVs represent a successful validation with zero findings.
 *
 * @param validationPath - `transformed.zip.validation.csv` path.
 * @returns Presence and non-empty finding count.
 */
async function readValidationEvidence(validationPath: string): Promise<{
  readonly present: boolean;
  readonly issueCount: number;
}> {
  if (!(await exists(validationPath))) return { present: false, issueCount: 0 };
  const lines = (await readFile(validationPath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (
    lines[0] !==
    "property_cid,data_group_cid,file_path,error_path,error_message,currentValue,timestamp"
  ) {
    throw new Error(`Unexpected validation CSV header: ${validationPath}`);
  }
  return { present: true, issueCount: Math.max(0, lines.length - 1) };
}

/**
 * Inspect one exact transformed artifact and its prepared/validation siblings.
 *
 * @param row - Parcel folio and exact retained source artifact URI.
 * @returns Folio-level source, transform, mapper, and validation evidence.
 */
async function readArtifactEvidence(
  row: DbParcelRow,
): Promise<ArtifactEvidence> {
  const artifactPath = artifactPathOnEbs(row.source_artifact_uri);
  const bytes = await readFile(artifactPath);
  const zip = new AdmZip(bytes);
  const names = new Set(zip.getEntries().map((entry) => entry.entryName));
  const sidecar = zip.getEntry("data/source_payload.ndjson");
  if (sidecar === null) {
    throw new Error(`Missing source payload sidecar for ${row.request_identifier}`);
  }
  const sourcePayload = parseAppraisalSourcePayloadSidecar(
    sidecar.getData().toString("utf8"),
  );
  const sourceProperties = readPrimarySourceProperties(sourcePayload);
  const sourceSiteAddress = readText(sourceProperties.site_address);
  const sourceSiteCityStateZip =
    readText(sourceProperties.site_csz) ??
    readText(
      [
        readText(sourceProperties.Site_City),
        readText(sourceProperties.Site_State),
        readText(sourceProperties.Site_Zip),
      ]
        .filter((value): value is string => value !== null)
        .join(" "),
    );
  const mappedTables = new Set<string>();
  let requestIdentifierMismatch = false;
  for (const entry of zip.getEntries()) {
    if (
      entry.isDirectory ||
      !entry.entryName.startsWith("data/") ||
      !entry.entryName.endsWith(".json")
    ) {
      continue;
    }
    const parsed: unknown = JSON.parse(entry.getData().toString("utf8"));
    if (
      isJsonObject(parsed) &&
      parsed.request_identifier !== undefined &&
      readText(parsed.request_identifier) !== row.request_identifier
    ) {
      requestIdentifierMismatch = true;
    }
    const bundle = mapAppraisalTransformedFile({
      artifactSourcePayload: sourcePayload,
      artifactUri: row.source_artifact_uri,
      countyName: "Rock Island",
      filePath: entry.entryName,
      record: parsed,
      requestIdentifier: row.request_identifier,
      sourceSystem: SOURCE_SYSTEM,
      stateCode: "IL",
    });
    bundle.rows.forEach((mapped) => mappedTables.add(mapped.tableName));
  }
  const validation = await readValidationEvidence(
    `${artifactPath}.validation.csv`,
  );
  const acres =
    readNumber(sourceProperties.GIS_acres_num) ??
    readNumber(sourceProperties.gross_acres);
  return {
    folio: row.request_identifier,
    artifactUri: row.source_artifact_uri,
    artifactPath,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    preparedCapturePresent: await exists(join(dirname(artifactPath), "capture.zip")),
    readyMarkerPresent: await exists(join(dirname(artifactPath), "ready.json")),
    validationReportPresent: validation.present,
    validationIssueCount: validation.issueCount,
    parcelOutputPresent:
      names.has("data/property_seed.json") || names.has("data/parcel.json"),
    propertyOutputPresent: names.has("data/property.json"),
    addressOutputPresent: names.has("data/address.json"),
    lotOutputPresent: names.has("data/lot.json"),
    propertyMapped: mappedTables.has("properties"),
    addressMapped: mappedTables.has("addresses"),
    lotMapped: mappedTables.has("lots"),
    sourceHasDefensibleSiteAddress: sourceSiteAddress !== null,
    sourceHasPositiveLotArea: acres !== null && acres > 0,
    sourceSiteAddress,
    sourceSiteCityStateZip,
    requestIdentifierMismatch,
  };
}

/**
 * Classify one normalized child from direct folio-level evidence.
 *
 * @param evidence - Source, output, schema, mapper, loader, and DB facts.
 * @returns Proven failure class or ok.
 */
export function classifyChildEvidence(evidence: {
  readonly sourceAchievable: boolean;
  readonly outputPresent: boolean;
  readonly validationReportPresent: boolean;
  readonly validationIssueCount: number;
  readonly mapperAccepted: boolean;
  readonly loaderIndexed: boolean;
  readonly dbPresent: boolean;
  readonly requiredForeignKeyPresent: boolean;
  readonly duplicate: boolean;
  readonly requestIdentifierMismatch: boolean;
}): ChildFailureClass {
  if (!evidence.sourceAchievable && !evidence.outputPresent && !evidence.dbPresent) {
    return "genuine_source_null";
  }
  if (
    evidence.requestIdentifierMismatch ||
    (evidence.sourceAchievable && !evidence.outputPresent)
  ) {
    return "missing_or_invalid_transform_output";
  }
  if (
    !evidence.validationReportPresent ||
    evidence.validationIssueCount > 0
  ) {
    return "schema_validation_failure";
  }
  if (evidence.outputPresent && !evidence.mapperAccepted) {
    return "loader_mapper_rejection";
  }
  if (evidence.duplicate) return "conflict_or_deduplication";
  if (evidence.outputPresent && !evidence.dbPresent && !evidence.loaderIndexed) {
    return "loader_not_merged";
  }
  if (evidence.outputPresent && !evidence.dbPresent) return "other";
  if (evidence.dbPresent && !evidence.requiredForeignKeyPresent) {
    return "parent_fk_resolution_failure";
  }
  return "ok";
}

/**
 * Select the exact folios whose normalized children are safe to replay.
 *
 * The result is sorted because the backfill independently verifies that its
 * evidence-owned input is unique and lexical before resolving database rows.
 *
 * @param evidence - Folio-level child classifications from reconciliation.
 * @returns Unique lexical folios with a proven loader/FK repair class.
 */
export function selectBackfillFolios(
  evidence: readonly {
    readonly folio: string;
    readonly propertyClass: ChildFailureClass;
    readonly addressClass: ChildFailureClass;
    readonly lotClass: ChildFailureClass;
  }[],
): readonly string[] {
  return evidence
    .filter(
      (row) =>
        row.propertyClass === "loader_not_merged" ||
        row.addressClass === "loader_not_merged" ||
        row.lotClass === "loader_not_merged" ||
        row.propertyClass === "parent_fk_resolution_failure" ||
        row.addressClass === "parent_fk_resolution_failure" ||
        row.lotClass === "parent_fk_resolution_failure",
    )
    .map((row) => row.folio)
    .sort();
}

/**
 * Run a bounded worker pool without retaining 65,806 artifact buffers.
 *
 * @param rows - Ordered parcel artifact rows.
 * @param concurrency - Maximum simultaneous ZIP readers.
 * @param worker - Artifact evidence reader.
 * @returns Results in the same order as input rows.
 */
async function mapConcurrently<TInput, TOutput>(
  rows: readonly TInput[],
  concurrency: number,
  worker: (row: TInput) => Promise<TOutput>,
): Promise<readonly TOutput[]> {
  const output: TOutput[] = new Array(rows.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index];
        if (row === undefined) return;
        output[index] = await worker(row);
      }
    }),
  );
  return output;
}

/**
 * Count failure classes in stable lexical order.
 *
 * @param values - Classified child values.
 * @returns Count by failure class.
 */
function countClasses(
  values: readonly ChildFailureClass[],
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Return sorted set subtraction.
 *
 * @param left - Candidate folios.
 * @param right - Folios to remove.
 * @returns Folios present only in the left set.
 */
function subtract(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): readonly string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

/**
 * Build a SHA-256 digest for a newline-delimited exact folio list.
 *
 * @param folios - Ordered folios.
 * @returns Hex digest of list bytes.
 */
function hashFolioList(folios: readonly string[]): string {
  return createHash("sha256").update(`${folios.join("\n")}\n`).digest("hex");
}

/**
 * CSV-escape a scalar evidence value.
 *
 * @param value - Evidence scalar.
 * @returns RFC-4180-compatible field.
 */
function csvField(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Serialize complete folio evidence to a stable CSV.
 *
 * @param evidence - Ordered folio evidence.
 * @returns CSV with one row per canonical seed folio.
 */
export function serializeFolioEvidence(
  evidence: readonly FolioEvidence[],
): string {
  const columns = [
    "folio",
    "in_seed",
    "in_prepared_artifacts",
    "in_transformed_artifacts",
    "in_loader_hash_index",
    "in_db_parcel",
    "in_db_property",
    "in_db_address",
    "in_db_lot",
    "in_public_query_table",
    "property_parcel_id_present",
    "property_address_id_present",
    "lot_property_id_present",
    "validation_report_present",
    "validation_issue_count",
    "property_output_present",
    "address_output_present",
    "lot_output_present",
    "property_mapped",
    "address_mapped",
    "lot_mapped",
    "source_has_defensible_site_address",
    "source_has_positive_lot_area",
    "source_site_address",
    "source_site_city_state_zip",
    "request_identifier_mismatch",
    "property_class",
    "address_class",
    "lot_class",
    "artifact_sha256",
    "artifact_uri",
  ] as const;
  const rows = evidence.map((row) =>
    [
      row.folio,
      row.inSeed,
      row.inPreparedArtifacts,
      row.inTransformedArtifacts,
      row.inLoaderHashIndex,
      row.inDbParcel,
      row.inDbProperty,
      row.inDbAddress,
      row.inDbLot,
      row.inPublicQueryTable,
      row.propertyParcelIdPresent,
      row.propertyAddressIdPresent,
      row.lotPropertyIdPresent,
      row.validationReportPresent,
      row.validationIssueCount,
      row.propertyOutputPresent,
      row.addressOutputPresent,
      row.lotOutputPresent,
      row.propertyMapped,
      row.addressMapped,
      row.lotMapped,
      row.sourceHasDefensibleSiteAddress,
      row.sourceHasPositiveLotArea,
      row.sourceSiteAddress,
      row.sourceSiteCityStateZip,
      row.requestIdentifierMismatch,
      row.propertyClass,
      row.addressClass,
      row.lotClass,
      row.artifactSha256,
      row.artifactUri,
    ]
      .map(csvField)
      .join(","),
  );
  return `${columns.join(",")}\n${rows.join("\n")}\n`;
}

/**
 * Reconcile the exact canonical seed, retained artifacts, normalized tables,
 * loader watermark, and current public query table by true folio.
 *
 * @param options - Exact evidence paths and bounded ZIP concurrency.
 * @returns Durable report, folio evidence, and proven backfill scope.
 */
export async function reconcileRockIslandChildren(
  options: ReconciliationOptions,
): Promise<ReconciliationResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({
    application_name: "rock-island-child-reconciliation",
    connectionString: databaseUrl,
    max: 4,
  });
  try {
    const [seed, loaderIndex, publicQuery, db] = await Promise.all([
      readCanonicalSeedFolios(options.seedPath),
      readLoaderIndexedFolios(options.hashIndexRoot),
      readPublicQueryInventory(options.publicQueryTablePath),
      readDbInventory(pool),
    ]);
    if (seed.folios.length !== EXPECTED_FOLIOS) {
      throw new Error(
        `Expected ${EXPECTED_FOLIOS} seed rows; received ${seed.folios.length}`,
      );
    }
    const seedSet = new Set(seed.folios);
    if (seedSet.size !== EXPECTED_FOLIOS || seed.duplicateFolios.length > 0) {
      throw new Error("Canonical Rock Island seed folios are not unique");
    }
    const parcelRows = [...db.parcels.values()];
    const artifacts = await mapConcurrently(
      parcelRows,
      options.concurrency,
      readArtifactEvidence,
    );
    const artifactsByFolio = new Map(
      artifacts.map((artifact) => [artifact.folio, artifact]),
    );
    const duplicateByTable = Object.fromEntries(
      Object.entries(db.duplicates).map(([table, rows]) => [
        table,
        new Set(rows.map((row) => row.request_identifier)),
      ]),
    ) as Readonly<Record<string, ReadonlySet<string>>>;
    const evidence = seed.folios.map((folio): FolioEvidence => {
      const artifact = artifactsByFolio.get(folio);
      const parcel = db.parcels.get(folio);
      const property = db.properties.get(folio);
      const lot = db.lots.get(folio);
      const loaderIndexed =
        artifact === undefined
          ? false
          : loaderIndex.has(loaderIndexKeyForArtifact(artifact.artifactPath));
      const common = {
        validationReportPresent: artifact?.validationReportPresent ?? false,
        validationIssueCount: artifact?.validationIssueCount ?? 0,
        loaderIndexed,
        requestIdentifierMismatch:
          artifact?.requestIdentifierMismatch ?? false,
      };
      const propertyClass = classifyChildEvidence({
        ...common,
        sourceAchievable: true,
        outputPresent: artifact?.propertyOutputPresent ?? false,
        mapperAccepted: artifact?.propertyMapped ?? false,
        dbPresent: property !== undefined,
        requiredForeignKeyPresent: property?.parcel_id !== null,
        duplicate:
          duplicateByTable.properties?.has(folio) === true ||
          duplicateByTable.parcels?.has(folio) === true,
      });
      const addressClass = classifyChildEvidence({
        ...common,
        sourceAchievable:
          artifact?.sourceHasDefensibleSiteAddress ?? false,
        outputPresent: artifact?.addressOutputPresent ?? false,
        mapperAccepted: artifact?.addressMapped ?? false,
        dbPresent: db.addresses.has(folio),
        requiredForeignKeyPresent:
          !(artifact?.addressOutputPresent ?? false) ||
          property?.address_id !== null,
        duplicate: duplicateByTable.addresses?.has(folio) === true,
      });
      const lotClass = classifyChildEvidence({
        ...common,
        sourceAchievable: artifact?.sourceHasPositiveLotArea ?? false,
        outputPresent: artifact?.lotOutputPresent ?? false,
        mapperAccepted: artifact?.lotMapped ?? false,
        dbPresent: lot !== undefined,
        requiredForeignKeyPresent: lot?.property_id !== null,
        duplicate: duplicateByTable.lots?.has(folio) === true,
      });
      return {
        folio,
        inSeed: true,
        inPreparedArtifacts: artifact?.preparedCapturePresent ?? false,
        inTransformedArtifacts: artifact !== undefined,
        inLoaderHashIndex: loaderIndexed,
        inDbParcel: parcel !== undefined,
        inDbProperty: property !== undefined,
        inDbAddress: db.addresses.has(folio),
        inDbLot: lot !== undefined,
        inPublicQueryTable: publicQuery.folios.has(folio),
        propertyParcelIdPresent: property?.parcel_id !== null,
        propertyAddressIdPresent: property?.address_id !== null,
        lotPropertyIdPresent: lot?.property_id !== null,
        artifactUri: artifact?.artifactUri ?? null,
        artifactSha256: artifact?.artifactSha256 ?? null,
        validationReportPresent: artifact?.validationReportPresent ?? false,
        validationIssueCount: artifact?.validationIssueCount ?? 0,
        propertyOutputPresent: artifact?.propertyOutputPresent ?? false,
        addressOutputPresent: artifact?.addressOutputPresent ?? false,
        lotOutputPresent: artifact?.lotOutputPresent ?? false,
        propertyMapped: artifact?.propertyMapped ?? false,
        addressMapped: artifact?.addressMapped ?? false,
        lotMapped: artifact?.lotMapped ?? false,
        sourceHasDefensibleSiteAddress:
          artifact?.sourceHasDefensibleSiteAddress ?? false,
        sourceHasPositiveLotArea:
          artifact?.sourceHasPositiveLotArea ?? false,
        sourceSiteAddress: artifact?.sourceSiteAddress ?? null,
        sourceSiteCityStateZip: artifact?.sourceSiteCityStateZip ?? null,
        requestIdentifierMismatch:
          artifact?.requestIdentifierMismatch ?? false,
        propertyClass,
        addressClass,
        lotClass,
      };
    });
    const missingProperties = evidence
      .filter((row) => !row.inDbProperty)
      .map((row) => row.folio);
    const missingAddresses = evidence
      .filter((row) => !row.inDbAddress)
      .map((row) => row.folio);
    const missingLots = evidence
      .filter((row) => !row.inDbLot)
      .map((row) => row.folio);
    const genuineSourceNullAddresses = evidence
      .filter((row) => row.addressClass === "genuine_source_null")
      .map((row) => row.folio);
    const backfillFolios = selectBackfillFolios(evidence);
    const parcelSet = new Set(db.parcels.keys());
    const propertySet = new Set(db.properties.keys());
    const addressSet = db.addresses;
    const lotSet = new Set(db.lots.keys());
    const prefixCounts = new Map<string, number>();
    db.parcels.forEach((row) => {
      const path = artifactPathOnEbs(row.source_artifact_uri);
      const prefix = dirname(dirname(path));
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    });
    const report = {
      schemaVersion: "1",
      sourceSystem: SOURCE_SYSTEM,
      expectedFolios: EXPECTED_FOLIOS,
      generatedAt: new Date().toISOString(),
      paths: {
        seed: options.seedPath,
        hashIndexRoot: options.hashIndexRoot,
        publicQueryTable: options.publicQueryTablePath,
      },
      counts: {
        seedRows: seed.folios.length,
        seedDistinctFolios: seedSet.size,
        preparedArtifacts: evidence.filter((row) => row.inPreparedArtifacts)
          .length,
        transformedArtifacts: evidence.filter(
          (row) => row.inTransformedArtifacts,
        ).length,
        schemaValidatedArtifacts: evidence.filter(
          (row) =>
            row.validationReportPresent && row.validationIssueCount === 0,
        ).length,
        loaderIndexedArtifacts: evidence.filter(
          (row) => row.inLoaderHashIndex,
        ).length,
        dbParcels: parcelSet.size,
        dbProperties: propertySet.size,
        dbAddresses: addressSet.size,
        dbLots: lotSet.size,
        publicQueryRows: publicQuery.rowCount,
        publicQueryDistinctFolios: publicQuery.folios.size,
        publicQueryNullFolios: publicQuery.nullFolioCount,
        sourceAchievableProperties: evidence.filter(
          (row) => row.propertyOutputPresent,
        ).length,
        sourceAchievableAddresses: evidence.filter(
          (row) => row.addressOutputPresent,
        ).length,
        sourceAchievableLots: evidence.filter((row) => row.lotOutputPresent)
          .length,
        genuineSourceNullAddresses: genuineSourceNullAddresses.length,
      },
      missing: {
        seedMinusParcels: subtract(seedSet, parcelSet).length,
        parcelsMinusSeed: subtract(parcelSet, seedSet).length,
        missingProperties: missingProperties.length,
        missingAddresses: missingAddresses.length,
        missingLots: missingLots.length,
        publicMinusSeed: subtract(publicQuery.folios, seedSet).length,
        seedMinusPublic: subtract(seedSet, publicQuery.folios).length,
      },
      overlaps: {
        missingPropertyAndAddress: missingProperties.filter((folio) =>
          new Set(missingAddresses).has(folio),
        ).length,
        missingPropertyAndLot: missingProperties.filter((folio) =>
          new Set(missingLots).has(folio),
        ).length,
        missingAddressWithoutPropertyGap: missingAddresses.filter(
          (folio) => !new Set(missingProperties).has(folio),
        ).length,
        backfillFolios: backfillFolios.length,
      },
      classes: {
        properties: countClasses(evidence.map((row) => row.propertyClass)),
        addresses: countClasses(evidence.map((row) => row.addressClass)),
        lots: countClasses(evidence.map((row) => row.lotClass)),
      },
      duplicates: {
        seed: seed.duplicateFolios.length,
        publicQuery: publicQuery.duplicateFolios.length,
        db: Object.fromEntries(
          Object.entries(db.duplicates).map(([table, rows]) => [
            table,
            rows.length,
          ]),
        ),
      },
      validation: {
        missingReports: evidence.filter(
          (row) => !row.validationReportPresent,
        ).length,
        failedReports: evidence.filter(
          (row) => row.validationIssueCount > 0,
        ).length,
        requestIdentifierMismatches: evidence.filter(
          (row) => row.requestIdentifierMismatch,
        ).length,
      },
      orphans: {
        propertiesWithoutParcel: evidence.filter(
          (row) => row.inDbProperty && !row.propertyParcelIdPresent,
        ).length,
        sourceBackedAddressesWithoutPropertyLink: evidence.filter(
          (row) =>
            row.addressOutputPresent &&
            row.inDbProperty &&
            !row.propertyAddressIdPresent,
        ).length,
        lotsWithoutProperty: evidence.filter(
          (row) => row.inDbLot && !row.lotPropertyIdPresent,
        ).length,
      },
      artifactPrefixes: Object.fromEntries(
        [...prefixCounts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      listDigests: {
        missingPropertiesSha256: hashFolioList(missingProperties),
        missingAddressesSha256: hashFolioList(missingAddresses),
        missingLotsSha256: hashFolioList(missingLots),
        genuineSourceNullAddressesSha256: hashFolioList(
          genuineSourceNullAddresses,
        ),
        backfillFoliosSha256: hashFolioList(backfillFolios),
      },
    };
    await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
    const outputs = new Map<string, string>([
      ["report.json", `${JSON.stringify(report, null, 2)}\n`],
      ["folio-evidence.csv", serializeFolioEvidence(evidence)],
      ["missing-properties.txt", `${missingProperties.join("\n")}\n`],
      ["missing-addresses.txt", `${missingAddresses.join("\n")}\n`],
      ["missing-lots.txt", `${missingLots.join("\n")}\n`],
      [
        "genuine-source-null-addresses.txt",
        `${genuineSourceNullAddresses.join("\n")}\n`,
      ],
      ["backfill-folios.txt", `${backfillFolios.join("\n")}\n`],
      [
        "seed-minus-parcels.txt",
        `${subtract(seedSet, parcelSet).join("\n")}\n`,
      ],
      [
        "parcels-minus-seed.txt",
        `${subtract(parcelSet, seedSet).join("\n")}\n`,
      ],
      [
        "seed-minus-public.txt",
        `${subtract(seedSet, publicQuery.folios).join("\n")}\n`,
      ],
      [
        "public-minus-seed.txt",
        `${subtract(publicQuery.folios, seedSet).join("\n")}\n`,
      ],
    ]);
    await Promise.all(
      [...outputs.entries()].map(([name, contents]) =>
        writeFile(join(options.outputDirectory, name), contents, {
          mode: 0o600,
        }),
      ),
    );
    return { report, evidence, backfillFolios };
  } finally {
    await pool.end();
  }
}

/**
 * Execute the exact folio reconciliation as a CLI.
 *
 * @returns Promise resolved after durable evidence is written.
 */
async function main(): Promise<void> {
  const result = await reconcileRockIslandChildren(
    parseReconciliationOptions(process.argv.slice(2)),
  );
  console.log(
    JSON.stringify({
      event: "rock_island_child_reconciliation_complete",
      backfillFolios: result.backfillFolios.length,
      report: result.report,
    }),
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
        event: "rock_island_child_reconciliation_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
