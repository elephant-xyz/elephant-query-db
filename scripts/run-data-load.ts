import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";

import {
  assertAppraisalPrefixIsScoped,
  createS3ArtifactReader,
  mapAppraisalTransformedFile,
  mapLeePermitDetail,
  mapSunbizAnnualReportsFromRegistration,
  mapSunbizClassRecord,
  parseS3Uri,
  readJsonArtifactRecords,
  upsertPreparedRows,
  type JsonObject,
  type LogicalTableName,
  type PreparedRow,
  type QueryClient,
  type QueryRowsResult,
  type SunbizClassType,
} from "../src/loader/index.js";

type TrackName = "appraisal" | "permits" | "sunbiz";

type LoaderOptions = {
  readonly appraisalPrefix: string;
  readonly bucket: string;
  readonly envFile: string;
  readonly limit: number | null;
  readonly permitPrefix: string;
  readonly stateFile: string;
  readonly sunbizPrefix: string;
  readonly tracks: readonly TrackName[];
};

type LoaderState = {
  readonly completedArtifacts: Record<string, true>;
  readonly failedArtifacts: Record<string, string>;
  readonly startedAt: string;
  readonly updatedAt: string;
};

type MutableCounters = {
  inputRecords: number;
  preparedRows: number;
  skippedRecords: number;
  changedRows: number;
  unchangedRows: number;
  failedArtifacts: number;
  completedArtifacts: number;
};

type S3ObjectListing = {
  readonly uri: string;
  readonly size: number;
};

type S3BodyWithByteArray = {
  readonly transformToByteArray: () => Promise<Uint8Array>;
};

export type DatabaseQueryRunner = {
  readonly query: <Row extends JsonObject = JsonObject>(
    text: string,
    values: readonly unknown[],
  ) => Promise<QueryRowsResult<Row>>;
};

const DEFAULT_BUCKET = "elephant-oracle-node-environmentbucket-mmsoo3xbdi80";
const DEFAULT_APPRAISAL_PREFIX = "outputs/";
const DEFAULT_PERMIT_PREFIX =
  "permit-harvest/lee-permit-backfill-20260525/lee/extracted/permits/";
const DEFAULT_SUNBIZ_PREFIX =
  "permit-harvest/sunbiz-lee-corporate-quarterly-2026q2-expanded/lexicon-transform/business-registration-v1/classes/";

const APPRAISAL_TABLE_ORDER: readonly LogicalTableName[] = [
  "unnormalized_addresses",
  "addresses",
  "parcels",
  "properties",
  "property_improvements",
  "people",
  "companies",
  "deeds",
  "fact_sheets",
  "geometries",
  "sales_histories",
  "taxes",
  "property_valuations",
  "structures",
  "utilities",
  "layouts",
  "lots",
  "flood_storm_information",
  "files",
  "ownerships",
];

const PERMIT_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "people",
  "companies",
  "property_improvements",
  "permit_contacts",
  "inspections",
  "permit_events",
  "permit_fees",
  "permit_links",
  "permit_custom_fields",
  "permit_list_windows",
];

const SUNBIZ_CLASS_ORDER: readonly SunbizClassType[] = [
  "address",
  "company",
  "business_registration",
  "business_registration_address",
  "business_registration_party",
];

const SUNBIZ_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "companies",
  "business_registrations",
  "business_registration_annual_reports",
  "business_registration_addresses",
  "business_registration_parties",
];

/**
 * Run the query database loader from S3 artifacts into Postgres.
 *
 * @returns Promise that resolves after selected tracks finish or rejects on unrecoverable configuration errors.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile} or the environment`);
  }

  const state = await readState(options.stateFile);
  const counters = emptyCounters();
  const s3 = new S3Client({});
  const pg = new Pool({
    application_name: "elephant-query-loader",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 2,
  });
  pg.on("error", (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "database_pool_error", error: message }));
  });
  const queryClient = createQueryClient(pg);

  try {
    console.log(JSON.stringify({ event: "loader_started", options: redactedOptions(options) }));
    if (options.tracks.includes("appraisal")) {
      await loadAppraisal({ counters, options, queryClient, s3, state });
    }
    if (options.tracks.includes("permits")) {
      await loadPermits({ counters, options, queryClient, s3, state });
    }
    if (options.tracks.includes("sunbiz")) {
      await loadSunbiz({ counters, options, queryClient, s3, state });
    }
    console.log(JSON.stringify({ event: "loader_finished", counters }));
  } finally {
    await pg.end();
    await writeState(options.stateFile, state);
  }
}

/**
 * Load all selected appraisal ZIP artifacts from S3 into logical appraisal tables.
 *
 * @param params - Shared clients, options, mutable state, and counters.
 * @returns Promise that resolves after appraisal artifact processing completes.
 */
async function loadAppraisal(params: {
  readonly counters: MutableCounters;
  readonly options: LoaderOptions;
  readonly queryClient: QueryClient;
  readonly s3: S3Client;
  readonly state: LoaderState;
}): Promise<void> {
  assertAppraisalPrefixIsScoped(params.options.appraisalPrefix);
  console.log(JSON.stringify({ event: "track_started", track: "appraisal", artifactCount: null }));
  let artifactCount = 0;
  for await (const artifact of listAppraisalArtifacts({
    bucket: params.options.bucket,
    limit: params.options.limit,
    prefix: params.options.appraisalPrefix,
    s3: params.s3,
  })) {
    artifactCount += 1;
    if (params.state.completedArtifacts[artifact.uri]) continue;
    await runArtifact(params, artifact.uri, async () => {
      const buffer = await readS3ObjectBuffer(params.s3, artifact.uri);
      const zip = new AdmZip(buffer);
      const rows: PreparedRow[] = [];
      let skippedRecords = 0;
      const entries = zip
        .getEntries()
        .filter((entry) => entry.isDirectory === false && /^data\/.+\.json$/.test(entry.entryName))
        .sort((left, right) => left.entryName.localeCompare(right.entryName));

      for (const entry of entries) {
        const text = entry.getData().toString("utf8");
        const record: unknown = JSON.parse(text);
        const bundle = mapAppraisalTransformedFile({
          artifactUri: artifact.uri,
          filePath: entry.entryName,
          record,
        });
        rows.push(...bundle.rows);
        skippedRecords += bundle.skippedRecords.length;
        params.counters.inputRecords += 1;
      }

      await writePreparedRows(params.queryClient, sortRows(rows, APPRAISAL_TABLE_ORDER), params.counters);
      params.counters.preparedRows += rows.length;
      params.counters.skippedRecords += skippedRecords;
      return { inputRecords: entries.length, preparedRows: rows.length, skippedRecords };
    });
  }
  console.log(JSON.stringify({ event: "track_finished", track: "appraisal", artifactCount }));
}

/**
 * Load Lee Accela permit detail JSON artifacts from S3.
 *
 * @param params - Shared clients, options, mutable state, and counters.
 * @returns Promise that resolves after permit artifact processing completes.
 */
async function loadPermits(params: {
  readonly counters: MutableCounters;
  readonly options: LoaderOptions;
  readonly queryClient: QueryClient;
  readonly s3: S3Client;
  readonly state: LoaderState;
}): Promise<void> {
  const reader = createS3ArtifactReader({ client: params.s3 });
  const artifacts = await listS3Objects({
    bucket: params.options.bucket,
    limit: params.options.limit,
    prefix: params.options.permitPrefix,
    s3: params.s3,
    suffix: ".json",
  });
  console.log(JSON.stringify({ event: "track_started", track: "permits", artifactCount: artifacts.length }));

  for (const artifact of artifacts) {
    if (params.state.completedArtifacts[artifact.uri]) continue;
    await runArtifact(params, artifact.uri, async () => {
      const records = await readJsonArtifactRecords(reader, artifact.uri, "json");
      const rows: PreparedRow[] = [];
      let skippedRecords = 0;
      for (const record of records) {
        const bundle = mapLeePermitDetail({ artifactUri: artifact.uri, record: record.record });
        rows.push(...bundle.rows);
        skippedRecords += bundle.skippedRecords.length;
      }
      await writePreparedRows(params.queryClient, sortRows(rows, PERMIT_TABLE_ORDER), params.counters);
      params.counters.inputRecords += records.length;
      params.counters.preparedRows += rows.length;
      params.counters.skippedRecords += skippedRecords;
      return { inputRecords: records.length, preparedRows: rows.length, skippedRecords };
    });
  }
}

/**
 * Load Sunbiz lexicon transform class JSONL artifacts from S3.
 *
 * @param params - Shared clients, options, mutable state, and counters.
 * @returns Promise that resolves after Sunbiz class artifact processing completes.
 */
async function loadSunbiz(params: {
  readonly counters: MutableCounters;
  readonly options: LoaderOptions;
  readonly queryClient: QueryClient;
  readonly s3: S3Client;
  readonly state: LoaderState;
}): Promise<void> {
  const reader = createS3ArtifactReader({ client: params.s3 });

  for (const classType of SUNBIZ_CLASS_ORDER) {
    const artifacts = await listS3Objects({
      bucket: params.options.bucket,
      limit: params.options.limit,
      prefix: `${params.options.sunbizPrefix}classes/${classType}/`,
      s3: params.s3,
      suffix: ".jsonl",
    });
    console.log(JSON.stringify({ event: "class_started", track: "sunbiz", classType, artifactCount: artifacts.length }));

    for (const artifact of artifacts) {
      if (params.state.completedArtifacts[artifact.uri]) continue;
      await runArtifact(params, artifact.uri, async () => {
        const records = await readJsonArtifactRecords(reader, artifact.uri, "jsonl");
        let preparedRows = 0;
        let skippedRecords = 0;
        for (const record of records) {
          const classBundle = mapSunbizClassRecord({
            artifactUri: artifact.uri,
            classType,
            record: record.record,
          });
          const annualReportBundle =
            classType === "business_registration"
              ? mapSunbizAnnualReportsFromRegistration({
                  artifactUri: artifact.uri,
                  record: record.record,
                })
              : { rows: [], skippedRecords: [] };
          const rows = sortRows(
            [...classBundle.rows, ...annualReportBundle.rows],
            SUNBIZ_TABLE_ORDER,
          );
          await writePreparedRows(params.queryClient, rows, params.counters);
          preparedRows += rows.length;
          skippedRecords += classBundle.skippedRecords.length + annualReportBundle.skippedRecords.length;
        }
        params.counters.inputRecords += records.length;
        params.counters.preparedRows += preparedRows;
        params.counters.skippedRecords += skippedRecords;
        return { inputRecords: records.length, preparedRows, skippedRecords };
      });
    }
  }
}

/**
 * Execute one artifact with durable completion/failure bookkeeping.
 *
 * @param params - Shared loader state and counters.
 * @param artifactUri - Artifact URI being processed.
 * @param callback - Artifact-specific loader callback.
 * @returns Promise that resolves after state is written for the artifact.
 */
async function runArtifact(
  params: {
    readonly counters: MutableCounters;
    readonly options: LoaderOptions;
    readonly state: LoaderState;
  },
  artifactUri: string,
  callback: () => Promise<JsonObject>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await callback();
    params.state.completedArtifacts[artifactUri] = true;
    delete params.state.failedArtifacts[artifactUri];
    params.counters.completedArtifacts += 1;
    await writeState(params.options.stateFile, params.state);
    console.log(JSON.stringify({
      event: "artifact_completed",
      artifactUri,
      elapsedMs: Date.now() - startedAt,
      ...result,
    }));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    params.state.failedArtifacts[artifactUri] = message;
    params.counters.failedArtifacts += 1;
    await writeState(params.options.stateFile, params.state);
    console.error(JSON.stringify({ event: "artifact_failed", artifactUri, error: message }));
  }
}

/**
 * Upsert prepared rows and accumulate changed/unchanged counters.
 *
 * @param queryClient - Postgres query client wrapper.
 * @param rows - Prepared rows already sorted by dependency order.
 * @param counters - Mutable run counters to update.
 * @returns Promise that resolves after all rows have been written.
 */
async function writePreparedRows(
  queryClient: QueryClient,
  rows: readonly PreparedRow[],
  counters: MutableCounters,
): Promise<void> {
  if (rows.length === 0) return;
  const result = await upsertPreparedRows(queryClient, rows, {
    missingReferenceBehavior: "omit",
  });
  counters.changedRows += result.changedRows;
  counters.unchangedRows += result.unchangedRows;
}

/**
 * List S3 object URIs under a prefix, optionally filtering by suffix and maximum result count.
 *
 * @param params - S3 client, bucket, prefix, suffix, and optional limit.
 * @returns S3 object URI listings sorted by key order.
 */
async function listS3Objects(params: {
  readonly bucket: string;
  readonly limit: number | null;
  readonly prefix: string;
  readonly s3: S3Client;
  readonly suffix: string;
}): Promise<readonly S3ObjectListing[]> {
  const objects: S3ObjectListing[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await params.s3.send(
      new ListObjectsV2Command({
        Bucket: params.bucket,
        ContinuationToken: continuationToken,
        Prefix: params.prefix,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key === undefined || object.Key.endsWith(params.suffix) === false) continue;
      objects.push({
        uri: `s3://${params.bucket}/${object.Key}`,
        size: object.Size ?? 0,
      });
      if (params.limit !== null && objects.length >= params.limit) return objects;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  return objects;
}

/**
 * List transformed appraisal artifact URIs from immediate `.csv/` child prefixes.
 *
 * Appraisal output folders that contain query-db-ready transformed artifacts use
 * `<parcel>.csv/transformed_output.zip`. Older folders use other ZIP names and are
 * intentionally ignored by this loader.
 *
 * @param params - S3 client, bucket, parent prefix, and optional prefix limit.
 * @yields Appraisal transformed artifact URI listings in S3 listing order.
 */
async function* listAppraisalArtifacts(params: {
  readonly bucket: string;
  readonly limit: number | null;
  readonly prefix: string;
  readonly s3: S3Client;
}): AsyncGenerator<S3ObjectListing> {
  let yieldedArtifacts = 0;
  let continuationToken: string | undefined;
  do {
    const response = await params.s3.send(
      new ListObjectsV2Command({
        Bucket: params.bucket,
        ContinuationToken: continuationToken,
        Delimiter: "/",
        Prefix: params.prefix,
      }),
    );
    for (const prefix of response.CommonPrefixes ?? []) {
      if (prefix.Prefix === undefined) continue;
      if (prefix.Prefix.endsWith(".csv/") === false) continue;
      const key = `${prefix.Prefix}transformed_output.zip`;
      if ((await s3ObjectExists(params.s3, params.bucket, key)) === false) continue;
      yield {
        uri: `s3://${params.bucket}/${key}`,
        size: 0,
      };
      yieldedArtifacts += 1;
      if (params.limit !== null && yieldedArtifacts >= params.limit) return;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
}

/**
 * Check whether an S3 object exists without downloading its body.
 *
 * @param s3 - AWS S3 client.
 * @param bucket - Bucket name.
 * @param key - Object key to test.
 * @returns True when the object exists; false for S3 404/NotFound responses.
 */
async function s3ObjectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (caught) {
    if (isS3NotFoundError(caught)) return false;
    throw caught;
  }
}

/**
 * Read one S3 object into a buffer for ZIP processing.
 *
 * @param s3 - AWS S3 client.
 * @param artifactUri - S3 URI of the object to read.
 * @returns Object body as a Node.js Buffer.
 */
async function readS3ObjectBuffer(s3: S3Client, artifactUri: string): Promise<Buffer> {
  const { bucket, key } = parseS3Uri(artifactUri);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body: unknown = response.Body;
  if (body === undefined) throw new Error(`S3 object had no body: ${artifactUri}`);
  if (hasTransformToByteArray(body)) {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error(`Unsupported S3 body type for ${artifactUri}`);
}

/**
 * Create the minimal query interface expected by the loader package from a lazy query runner.
 *
 * @param client - Postgres query runner, usually a `pg.Pool`.
 * @returns Query client wrapper with readonly row arrays.
 */
export function createQueryClient(client: DatabaseQueryRunner): QueryClient {
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ): Promise<QueryRowsResult<Row>> {
      const result = await client.query<Row>(text, [...values]);
      return { rows: result.rows };
    },
  };
}

/**
 * Sort prepared rows by dependency order while keeping stable order inside each table.
 *
 * @param rows - Prepared rows to sort.
 * @param tableOrder - Table order for the current source track.
 * @returns Sorted row array.
 */
function sortRows(
  rows: readonly PreparedRow[],
  tableOrder: readonly LogicalTableName[],
): readonly PreparedRow[] {
  const order = new Map(tableOrder.map((tableName, index) => [tableName, index]));
  return [...rows].sort((left, right) => {
    const leftOrder = order.get(left.tableName) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.tableName) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

/**
 * Read or initialize the resumable loader state file.
 *
 * @param stateFile - Local JSON state file path.
 * @returns Existing or initialized state object.
 */
async function readState(stateFile: string): Promise<LoaderState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile, "utf8"));
    if (isLoaderState(parsed)) return parsed;
    throw new Error(`Invalid loader state file: ${stateFile}`);
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
      const now = new Date().toISOString();
      return { completedArtifacts: {}, failedArtifacts: {}, startedAt: now, updatedAt: now };
    }
    throw caught;
  }
}

/**
 * Persist loader state atomically enough for local resumable runs.
 *
 * @param stateFile - Local JSON state path.
 * @param state - State object to persist.
 * @returns Promise that resolves after state is written.
 */
async function writeState(stateFile: string, state: LoaderState): Promise<void> {
  const nextState: LoaderState = { ...state, updatedAt: new Date().toISOString() };
  await mkdir(dirname(stateFile), { recursive: true });
  const temporaryFile = `${stateFile}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(nextState, null, 2)}\n`);
  await rename(temporaryFile, stateFile);
  Object.assign(state.completedArtifacts, nextState.completedArtifacts);
  Object.assign(state.failedArtifacts, nextState.failedArtifacts);
}

/**
 * Load key-value pairs from a dotenv-style file without echoing secrets.
 *
 * @param envFile - File path containing `KEY=value` pairs.
 * @returns void.
 */
function loadEnvFile(envFile: string): void {
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex);
      const value = trimmed.slice(equalsIndex + 1);
      if (process.env[key] === undefined) process.env[key] = unquoteEnvValue(value);
    }
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return;
    throw caught;
  }
}

/**
 * Parse CLI arguments into loader options.
 *
 * @param argv - Raw command-line argument list after the script path.
 * @returns Normalized loader options.
 */
function parseOptions(argv: readonly string[]): LoaderOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.startsWith("--") === false) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && next.startsWith("--") === false) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  return {
    appraisalPrefix: values.get("appraisal-prefix") ?? DEFAULT_APPRAISAL_PREFIX,
    bucket: values.get("bucket") ?? DEFAULT_BUCKET,
    envFile: values.get("env-file") ?? ".env.local",
    limit: parseOptionalPositiveInteger(values.get("limit")),
    permitPrefix: values.get("permit-prefix") ?? DEFAULT_PERMIT_PREFIX,
    stateFile: values.get("state-file") ?? ".loader-runs/query-db-load-state.json",
    sunbizPrefix: values.get("sunbiz-prefix") ?? DEFAULT_SUNBIZ_PREFIX,
    tracks: parseTracks(values.get("tracks") ?? "appraisal,permits,sunbiz"),
  };
}

/**
 * Parse comma-separated track names.
 *
 * @param value - Comma-separated track value from CLI options.
 * @returns Validated track array.
 */
function parseTracks(value: string): readonly TrackName[] {
  const tracks = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  for (const track of tracks) {
    if (track !== "appraisal" && track !== "permits" && track !== "sunbiz") {
      throw new Error(`Unknown track: ${track}`);
    }
  }
  return tracks as readonly TrackName[];
}

/**
 * Parse an optional positive integer CLI value.
 *
 * @param value - Raw CLI value or undefined.
 * @returns Positive integer, or null when no value was supplied.
 */
function parseOptionalPositiveInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) === false || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

/**
 * Create an empty mutable counter set for one loader run.
 *
 * @returns Zero-filled mutable counters.
 */
function emptyCounters(): MutableCounters {
  return {
    changedRows: 0,
    completedArtifacts: 0,
    failedArtifacts: 0,
    inputRecords: 0,
    preparedRows: 0,
    skippedRecords: 0,
    unchangedRows: 0,
  };
}

/**
 * Return non-sensitive options for startup logging.
 *
 * @param options - Loader options to report.
 * @returns Options without database credentials.
 */
function redactedOptions(options: LoaderOptions): JsonObject {
  return {
    appraisalPrefix: options.appraisalPrefix,
    bucket: options.bucket,
    envFile: options.envFile,
    limit: options.limit,
    permitPrefix: options.permitPrefix,
    stateFile: options.stateFile,
    sunbizPrefix: options.sunbizPrefix,
    tracks: options.tracks,
  };
}

/**
 * Check whether an unknown value is a persisted loader state object.
 *
 * @param value - Unknown parsed JSON value.
 * @returns True when the value matches the loader state contract.
 */
function isLoaderState(value: unknown): value is LoaderState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.completedArtifacts === "object" &&
    candidate.completedArtifacts !== null &&
    Array.isArray(candidate.completedArtifacts) === false &&
    typeof candidate.failedArtifacts === "object" &&
    candidate.failedArtifacts !== null &&
    Array.isArray(candidate.failedArtifacts) === false &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

/**
 * Check whether an S3 response body supports direct byte-array conversion.
 *
 * @param value - Unknown S3 response body.
 * @returns True when `transformToByteArray` can be called.
 */
function hasTransformToByteArray(value: unknown): value is S3BodyWithByteArray {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly transformToByteArray?: unknown };
  return typeof candidate.transformToByteArray === "function";
}

/**
 * Check whether an AWS SDK error represents a missing S3 object.
 *
 * @param value - Unknown error thrown by the AWS SDK.
 * @returns True for `NoSuchKey`, `NotFound`, or HTTP 404 errors.
 */
function isS3NotFoundError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly name?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

/**
 * Remove simple shell quotes from dotenv values.
 *
 * @param value - Raw value text after the first equals sign.
 * @returns Unquoted environment value.
 */
function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
