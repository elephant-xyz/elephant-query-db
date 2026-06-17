import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { put } from "@vercel/blob";
import AdmZip from "adm-zip";

import {
  buildAppraisalMediaBlobPathname,
  buildAppraisalMediaFileRecord,
  extractLeeAppraisalMediaLinks,
  inferMediaExtension,
  isJsonObject,
  parseS3Uri,
  type LeeAppraisalMediaLink,
} from "../src/loader/index.js";

type MediaEnrichmentOptions = {
  readonly detailStatePath: string;
  readonly transformStatePath: string;
  readonly mediaStatePath: string;
  readonly outputS3Prefix: string;
  readonly envFile: string;
  readonly profile: string;
  readonly region: string;
  readonly concurrency: number;
  readonly limit: number | null;
  readonly continueOnError: boolean;
  readonly linkOnly: boolean;
};

type DetailStateRecord = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly outputS3Uri: string;
};

type TransformStateRecord = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly outputS3Uri: string;
};

type MediaStateRecord = {
  readonly event: "media_enrichment_completed" | "media_enrichment_failed";
  readonly completedAt: string;
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly detailOutputS3Uri: string;
  readonly transformOutputS3Uri: string;
  readonly outputS3Uri: string | null;
  readonly discoveredMediaCount: number | null;
  readonly uploadedMediaCount: number | null;
  readonly failedMediaCount: number | null;
  readonly error: string | null;
};

type DetailAndTransformPair = {
  readonly detail: DetailStateRecord;
  readonly transform: TransformStateRecord;
};

type BodyWithTransformToByteArray = {
  readonly transformToByteArray: () => Promise<Uint8Array>;
};

type UploadedMediaFile = {
  readonly link: LeeAppraisalMediaLink;
  readonly blobUrl: string | null;
  readonly contentSha256: string | null;
  readonly contentType: string | null;
  readonly uploadedAt: string | null;
  readonly error: string | null;
};

const DEFAULT_DETAIL_STATE_PATH = ".loader-runs/curated-commercial-appraisal/detail-prepare-2000-state.jsonl";
const DEFAULT_TRANSFORM_STATE_PATH = ".loader-runs/curated-commercial-appraisal/transform-data-only-2000-state.jsonl";
const DEFAULT_MEDIA_STATE_PATH = ".loader-runs/curated-commercial-appraisal/media-enrichment-2000-state.jsonl";
const DEFAULT_OUTPUT_S3_PREFIX =
  "s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/curated-commercial-2000-20260528/appraisal/transformed-data-with-media";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Add Vercel-Blob-backed appraisal media file records to transformed Lee appraisal ZIPs.
 *
 * The oracle transform already produces logical `data/*.json` rows but does not
 * download the parcel photos/floor plans referenced in the captured HTML. This
 * runner extracts those media URLs from the corresponding detail HTML, uploads
 * successful downloads to Vercel Blob, appends `data/file_appraisal_media_*.json`
 * records to a copy of the transformed ZIP, and writes the enriched ZIP to a
 * separate S3 prefix for the final query-db load.
 *
 * @returns Promise that resolves after selected transformed outputs are enriched.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);
  process.env.AWS_PROFILE = options.profile;
  process.env.AWS_REGION = options.region;

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken === undefined || blobToken.trim().length === 0) {
    throw new Error(`BLOB_READ_WRITE_TOKEN is required; expected it in ${options.envFile}`);
  }

  const pairs = buildPairs({
    details: await readDetailStateRecords(options.detailStatePath),
    transforms: await readTransformStateRecords(options.transformStatePath),
  });
  const completedInputs = await readCompletedMediaInputs(options.mediaStatePath);
  const pendingPairs = pairs
    .filter((pair) => completedInputs.has(pair.transform.outputS3Uri) === false)
    .slice(0, options.limit ?? undefined);
  const s3 = new S3Client({ region: options.region });
  let nextIndex = 0;
  let shouldStop = false;
  const failures: string[] = [];

  console.log(JSON.stringify({
    event: "appraisal_media_enrichment_started",
    detailStatePath: options.detailStatePath,
    transformStatePath: options.transformStatePath,
    mediaStatePath: options.mediaStatePath,
    outputS3Prefix: options.outputS3Prefix,
    selectedPendingRecords: pendingPairs.length,
    alreadyCompletedRecords: completedInputs.size,
    concurrency: options.concurrency,
  }));

  const workers = Array.from({ length: options.concurrency }, async (_unused, workerIndex) => {
    while (shouldStop === false) {
      const recordIndex = nextIndex;
      nextIndex += 1;
      const pair = pendingPairs[recordIndex];
      if (pair === undefined) return;
      try {
        const stateRecord = await enrichPair({ blobToken, options, pair, s3 });
        await appendStateRecord(options.mediaStatePath, stateRecord);
        console.log(JSON.stringify({
          event: "appraisal_media_enrichment_completed",
          workerIndex,
          rank: pair.transform.rank,
          parcelIdentifier: pair.transform.parcelIdentifier,
          outputS3Uri: stateRecord.outputS3Uri,
          discoveredMediaCount: stateRecord.discoveredMediaCount,
          uploadedMediaCount: stateRecord.uploadedMediaCount,
          failedMediaCount: stateRecord.failedMediaCount,
          completedCount: recordIndex + 1,
          selectedPendingRecords: pendingPairs.length,
        }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        failures.push(message);
        await appendStateRecord(options.mediaStatePath, {
          event: "media_enrichment_failed",
          completedAt: new Date().toISOString(),
          rank: pair.transform.rank,
          parcelIdentifier: pair.transform.parcelIdentifier,
          detailOutputS3Uri: pair.detail.outputS3Uri,
          transformOutputS3Uri: pair.transform.outputS3Uri,
          outputS3Uri: null,
          discoveredMediaCount: null,
          uploadedMediaCount: null,
          failedMediaCount: null,
          error: message,
        });
        console.error(JSON.stringify({
          event: "appraisal_media_enrichment_failed_record",
          workerIndex,
          rank: pair.transform.rank,
          parcelIdentifier: pair.transform.parcelIdentifier,
          error: message,
        }));
        if (options.continueOnError === false) shouldStop = true;
      }
    }
  });

  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(`${failures.length} media enrichment record(s) failed; see ${options.mediaStatePath}`);
  }
}

async function enrichPair(params: {
  readonly blobToken: string;
  readonly options: MediaEnrichmentOptions;
  readonly pair: DetailAndTransformPair;
  readonly s3: S3Client;
}): Promise<MediaStateRecord> {
  const detailZip = new AdmZip(await readS3ObjectBuffer(params.s3, params.pair.detail.outputS3Uri));
  const transformZip = new AdmZip(await readS3ObjectBuffer(params.s3, params.pair.transform.outputS3Uri));
  const html = readFirstZipText(detailZip, ".html");
  const propertySeed = readJsonZipEntry(detailZip, "property_seed.json");
  const sourceHttpRequest = isJsonObject(propertySeed.source_http_request)
    ? propertySeed.source_http_request
    : null;
  const requestIdentifier = readStringField(propertySeed.request_identifier)
    ?? readStringField(propertySeed.folio_id)
    ?? params.pair.detail.parcelIdentifier;
  const mediaLinks = extractLeeAppraisalMediaLinks(html, "https://www.leepa.org/Display/DisplayParcel.aspx");
  const uploadedFiles: UploadedMediaFile[] = [];
  let failedMediaCount = 0;

  for (const link of mediaLinks) {
    if (params.options.linkOnly) {
      uploadedFiles.push({
        link,
        blobUrl: null,
        contentSha256: null,
        contentType: null,
        uploadedAt: null,
        error: "link-only mode: media download skipped",
      });
      continue;
    }
    try {
      uploadedFiles.push(await uploadMediaLink({
        blobToken: params.blobToken,
        link,
        requestIdentifier,
      }));
    } catch (caught) {
      failedMediaCount += 1;
      const message = caught instanceof Error ? caught.message : String(caught);
      console.warn(JSON.stringify({
        event: "appraisal_media_upload_failed",
        rank: params.pair.transform.rank,
        parcelIdentifier: params.pair.transform.parcelIdentifier,
        mediaUrl: link.url,
        error: message,
      }));
      uploadedFiles.push({
        link,
        blobUrl: null,
        contentSha256: null,
        contentType: null,
        uploadedAt: null,
        error: message,
      });
    }
  }

  uploadedFiles.forEach((uploaded, index) => {
    const record = uploaded.blobUrl === null || uploaded.contentSha256 === null || uploaded.uploadedAt === null
      ? buildAppraisalMediaFallbackFileRecord({
          error: uploaded.error,
          index: index + 1,
          link: uploaded.link,
          requestIdentifier,
          sourceHttpRequest,
        })
      : buildAppraisalMediaFileRecord({
          blobUrl: uploaded.blobUrl,
          contentSha256: uploaded.contentSha256,
          contentType: uploaded.contentType,
          index: index + 1,
          link: uploaded.link,
          requestIdentifier,
          sourceHttpRequest,
          uploadedAt: uploaded.uploadedAt,
        });
    transformZip.addFile(
      `data/file_appraisal_media_${String(index + 1).padStart(3, "0")}.json`,
      Buffer.from(JSON.stringify(record), "utf8"),
    );
  });

  const outputS3Uri = buildOutputS3Uri(params.options.outputS3Prefix, params.pair.transform.outputS3Uri);
  await writeS3ObjectBuffer(params.s3, outputS3Uri, transformZip.toBuffer());
  const uploadedMediaCount = uploadedFiles.filter((uploaded) => uploaded.blobUrl !== null).length;
  return {
    event: "media_enrichment_completed",
    completedAt: new Date().toISOString(),
    rank: params.pair.transform.rank,
    parcelIdentifier: params.pair.transform.parcelIdentifier,
    detailOutputS3Uri: params.pair.detail.outputS3Uri,
    transformOutputS3Uri: params.pair.transform.outputS3Uri,
    outputS3Uri,
    discoveredMediaCount: mediaLinks.length,
    uploadedMediaCount,
    failedMediaCount: mediaLinks.length - uploadedMediaCount,
    error: null,
  };
}

async function uploadMediaLink(params: {
  readonly blobToken: string;
  readonly link: LeeAppraisalMediaLink;
  readonly requestIdentifier: string;
}): Promise<UploadedMediaFile> {
  const response = await fetchWithTimeout(params.link.url);
  if (response.ok === false) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type");
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const pathname = buildAppraisalMediaBlobPathname({
    extension: inferMediaExtension({ contentType, url: params.link.url }),
    link: params.link,
    requestIdentifier: params.requestIdentifier,
  });
  const blob = await put(
    pathname,
    bytes,
    contentType === null
      ? {
          access: "public",
          allowOverwrite: true,
          cacheControlMaxAge: 31_536_000,
          token: params.blobToken,
        }
      : {
          access: "public",
          allowOverwrite: true,
          cacheControlMaxAge: 31_536_000,
          contentType,
          token: params.blobToken,
        },
  );
  return {
    link: params.link,
    blobUrl: blob.url,
    contentSha256,
    contentType,
    uploadedAt: new Date().toISOString(),
    error: null,
  };
}

/**
 * Build a `files` row payload for appraisal media that was discovered in the
 * county HTML but could not be downloaded from this execution environment.
 *
 * @param input - Source media link and error context.
 * @returns JSON object compatible with the appraisal `file_*.json` mapper.
 */
function buildAppraisalMediaFallbackFileRecord(input: {
  readonly error: string | null;
  readonly index: number;
  readonly link: LeeAppraisalMediaLink;
  readonly requestIdentifier: string;
  readonly sourceHttpRequest: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    request_identifier: input.requestIdentifier,
    document_type: input.link.kind,
    file_format: null,
    name: input.link.label,
    original_url: input.link.url,
    source_http_request: input.sourceHttpRequest,
    source_payload: {
      download_error: input.error,
      media_identity_key: input.link.identityKey,
      media_kind: input.link.kind,
      original_url: input.link.url,
      storage_provider: null,
      storage_uri: null,
    },
  };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        "user-agent": "elephant-query-db-media-loader/0.1",
      },
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readS3ObjectBuffer(s3: S3Client, artifactUri: string): Promise<Buffer> {
  const { bucket, key } = parseS3Uri(artifactUri);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body: unknown = response.Body;
  if (body === undefined || isBodyWithTransformToByteArray(body) === false) {
    throw new Error(`S3 object had no readable body: ${artifactUri}`);
  }
  return Buffer.from(await body.transformToByteArray());
}

async function writeS3ObjectBuffer(s3: S3Client, artifactUri: string, body: Buffer): Promise<void> {
  const { bucket, key } = parseS3Uri(artifactUri);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

function buildOutputS3Uri(outputS3Prefix: string, transformOutputS3Uri: string): string {
  const parentName = basename(dirname(transformOutputS3Uri));
  return `${outputS3Prefix.replace(/\/+$/, "")}/${parentName}/transformed_output.zip`;
}

function readFirstZipText(zip: AdmZip, suffix: string): string {
  const entry = zip.getEntries().find((candidate) => candidate.isDirectory === false && candidate.entryName.endsWith(suffix));
  if (entry === undefined) throw new Error(`ZIP is missing ${suffix} entry`);
  return entry.getData().toString("utf8");
}

function readJsonZipEntry(zip: AdmZip, entryName: string): Record<string, unknown> {
  const entry = zip.getEntry(entryName);
  if (entry === null) throw new Error(`ZIP is missing ${entryName}`);
  const parsed: unknown = JSON.parse(entry.getData().toString("utf8"));
  if (isJsonObject(parsed) === false) throw new Error(`${entryName} is not a JSON object`);
  return parsed;
}

function buildPairs(params: {
  readonly details: readonly DetailStateRecord[];
  readonly transforms: readonly TransformStateRecord[];
}): readonly DetailAndTransformPair[] {
  const detailsByKey = new Map(params.details.map((detail) => [stateKey(detail), detail]));
  const pairs: DetailAndTransformPair[] = [];
  for (const transform of params.transforms) {
    const detail = detailsByKey.get(stateKey(transform));
    if (detail !== undefined) pairs.push({ detail, transform });
  }
  return pairs;
}

async function readDetailStateRecords(path: string): Promise<readonly DetailStateRecord[]> {
  const records = await readJsonlState(path);
  return records
    .filter((record) => record.event === "prepare_completed")
    .map((record, index) => ({
      rank: readRequiredNumber(record, "rank", `${path}:${String(index + 1)}`),
      parcelIdentifier: readRequiredString(record, "parcelIdentifier", `${path}:${String(index + 1)}`),
      outputS3Uri: readRequiredString(record, "outputS3Uri", `${path}:${String(index + 1)}`),
    }));
}

async function readTransformStateRecords(path: string): Promise<readonly TransformStateRecord[]> {
  const records = await readJsonlState(path);
  return records
    .filter((record) => record.event === "transform_completed")
    .map((record, index) => ({
      rank: readRequiredNumber(record, "rank", `${path}:${String(index + 1)}`),
      parcelIdentifier: readRequiredString(record, "parcelIdentifier", `${path}:${String(index + 1)}`),
      outputS3Uri: readRequiredString(record, "outputS3Uri", `${path}:${String(index + 1)}`),
    }));
}

async function readCompletedMediaInputs(path: string): Promise<ReadonlySet<string>> {
  let records: readonly Record<string, unknown>[] = [];
  try {
    records = await readJsonlState(path);
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return new Set();
    throw caught;
  }
  const completed = new Set<string>();
  for (const record of records) {
    if (record.event === "media_enrichment_completed") {
      const transformOutputS3Uri = readStringField(record.transformOutputS3Uri);
      if (transformOutputS3Uri !== null) completed.add(transformOutputS3Uri);
    }
  }
  return completed;
}

async function readJsonlState(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (isJsonObject(parsed) === false) throw new Error(`State line is not a JSON object in ${path}`);
      return parsed;
    });
}

async function appendStateRecord(path: string, record: MediaStateRecord): Promise<void> {
  await appendFile(path, JSON.stringify(record).concat("\n"), "utf8");
}

function parseOptions(args: readonly string[]): MediaEnrichmentOptions {
  const values = readCliValues(args);
  return {
    detailStatePath: values.get("detail-state") ?? DEFAULT_DETAIL_STATE_PATH,
    transformStatePath: values.get("transform-state") ?? DEFAULT_TRANSFORM_STATE_PATH,
    mediaStatePath: values.get("state") ?? DEFAULT_MEDIA_STATE_PATH,
    outputS3Prefix: values.get("output-s3-prefix") ?? DEFAULT_OUTPUT_S3_PREFIX,
    envFile: values.get("env-file") ?? ".env.local",
    profile: values.get("profile") ?? process.env.AWS_PROFILE ?? "elephant-oracle-node",
    region: values.get("region") ?? process.env.AWS_REGION ?? "us-east-1",
    concurrency: parsePositiveInteger(values.get("concurrency"), 4, "concurrency"),
    limit: parseOptionalPositiveInteger(values.get("limit"), "limit"),
    continueOnError: values.get("continue-on-error") === "true",
    linkOnly: values.get("link-only") === "true",
  };
}

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

function loadEnvFile(path: string): void {
  const text = readFileSync(path, "utf8");
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

function stateKey(record: { readonly rank: number; readonly parcelIdentifier: string }): string {
  return `${String(record.rank)}:${record.parcelIdentifier}`;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, fieldName: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${fieldName}: ${value}`);
  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, fieldName: string): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  return parsePositiveInteger(value, 1, fieldName);
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRequiredString(value: Record<string, unknown>, key: string, source: string): string {
  const field = readStringField(value[key]);
  if (field === null) throw new Error(`State line is missing string field ${key}: ${source}`);
  return field;
}

function readRequiredNumber(value: Record<string, unknown>, key: string, source: string): number {
  const field = value[key];
  if (typeof field !== "number" || Number.isFinite(field) === false) {
    throw new Error(`State line is missing number field ${key}: ${source}`);
  }
  return field;
}

function isBodyWithTransformToByteArray(value: unknown): value is BodyWithTransformToByteArray {
  return isJsonObject(value) && typeof value.transformToByteArray === "function";
}

await main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  console.error(JSON.stringify({ event: "appraisal_media_enrichment_failed", error: message }));
  process.exitCode = 1;
});
