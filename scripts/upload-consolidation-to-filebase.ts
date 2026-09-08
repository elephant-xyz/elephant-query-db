import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PutObjectCommand,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  DeserializeHandler,
  DeserializeHandlerArguments,
  DeserializeHandlerOutput,
  DeserializeMiddleware,
  HandlerExecutionContext,
} from "@smithy/types";

import { computeIpfsCid } from "./run-property-consolidation-export.js";
import type { IndexFile, ManifestEntry, ManifestSummary } from "./run-property-consolidation-export.js";
import {
  CheckpointJournal,
  compactUploadCheckpoint,
  createUploadProgress,
  DEFAULT_UPLOAD_RUNS_DIR,
  readUploadCheckpoint,
  recordUploadFailure,
  recordUploadSkipped,
  recordUploadSuccess,
  runBoundedWorkerPool,
  snapshotUploadProgress,
  uploadCheckpointPathsForBucket,
  type CheckpointRecord,
  type UploadProgressState,
  type UploadRetryInfo,
} from "./filebase-upload-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadOptions = {
  readonly exportDir: string;
  readonly concurrency: number;
  readonly dryRun: boolean;
  readonly limit: number | null;
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly filebaseApiToken: string | null;
  readonly filebaseIpnsLabel: string | null;
  readonly forceIndex: boolean;
};

/**
 * Reject a stale property checkpoint instead of silently skipping changed bytes.
 *
 * @param existing - Persisted upload checkpoint for the property key.
 * @param currentCid - CID from the current immutable manifest.
 * @param key - Stable property object key.
 * @returns Nothing when the checkpoint is absent or exactly current.
 */
export function assertPropertyCheckpointCid(
  existing: CheckpointRecord | undefined,
  currentCid: string,
  key: string,
): void {
  if (existing !== undefined && existing.cid !== currentCid) {
    throw new Error(
      `Stale property checkpoint CID mismatch for ${key}: refusing changed content`,
    );
  }
}

// Fixed-key files (index.json, manifest.json, shards/shard-*.json) share stable keys
// across runs, so a plain skip-by-key would re-point IPNS at a STALE index whenever a
// bucket still holds an older checkpoint (e.g. a sample export). These files must be
// re-uploaded when their freshly-computed local CID differs from the checkpoint's.
export type FixedKeyUploadDecision =
  | { readonly reupload: false }
  | {
      readonly reupload: true;
      readonly reason: "new" | "content_changed" | "cid_unverifiable" | "forced";
    };

/**
 * Decide whether a fixed-key file must be (re-)uploaded. Property files stay
 * content-addressed and skip-by-key; only the fixed-key pointer files use this.
 *
 * - not in checkpoint            -> upload ("new")
 * - --force-index                -> re-upload ("forced")
 * - local CID could not be hashed -> re-upload defensively ("cid_unverifiable")
 * - local CID != checkpoint CID   -> re-upload ("content_changed")
 * - local CID == checkpoint CID   -> skip
 */
export function decideFixedKeyUpload(
  existing: CheckpointRecord | undefined,
  localCid: string | null,
  forceIndex: boolean,
): FixedKeyUploadDecision {
  if (existing === undefined) return { reupload: true, reason: "new" };
  if (forceIndex) return { reupload: true, reason: "forced" };
  if (localCid === null) return { reupload: true, reason: "cid_unverifiable" };
  if (localCid !== existing.cid) return { reupload: true, reason: "content_changed" };
  return { reupload: false };
}

type FilebaseIpnsItem = {
  readonly label: string;
  readonly network_key: string;
  readonly cid?: string;
  readonly sequence?: number;
  readonly enabled?: boolean;
};

// ---------------------------------------------------------------------------
// Raw HTTP response type (AWS SDK v3 internals)
// ---------------------------------------------------------------------------

interface RawHttpResponse {
  headers: Record<string, string>;
  statusCode: number;
}

function isRawHttpResponse(value: unknown): value is RawHttpResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "headers" in value &&
    typeof (value as RawHttpResponse).headers === "object"
  );
}

// ---------------------------------------------------------------------------
// S3 client factory
// ---------------------------------------------------------------------------

function buildS3Client(options: UploadOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

// ---------------------------------------------------------------------------
// CID capture via deserialize middleware (mirrors s3-compatible-storage.service.ts)
// ---------------------------------------------------------------------------

type PutObjectResult = {
  readonly cid: string | undefined;
  readonly retry: UploadRetryInfo;
};

/**
 * Upload bytes and capture Filebase's CID plus AWS SDK retry metadata.
 *
 * The CID middleware is attached to the individual command so concurrent
 * uploads cannot collide on the shared S3 client middleware stack.
 *
 * @param client - Shared Filebase-compatible S3 client.
 * @param params - Bucket, key, bytes, and content type for one object.
 * @returns Filebase CID and retry metadata from the completed SDK request.
 */
async function putObjectAndCaptureCid(
  client: S3Client,
  params: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  }
): Promise<PutObjectResult> {
  let capturedHeaders: Record<string, string> | undefined;

  const captureMiddleware: DeserializeMiddleware<PutObjectCommandInput, PutObjectCommandOutput> =
    (
      next: DeserializeHandler<PutObjectCommandInput, PutObjectCommandOutput>,
      _context: HandlerExecutionContext
    ) =>
    async (
      args: DeserializeHandlerArguments<PutObjectCommandInput>
    ): Promise<DeserializeHandlerOutput<PutObjectCommandOutput>> => {
      const result = await next(args);
      if (isRawHttpResponse(result.response)) {
        capturedHeaders = result.response.headers;
      }
      return result;
    };

  const command = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
  });

  // Attach the capture middleware to THIS command's stack, not the shared client's.
  // Each command instance has its own stack, so concurrent uploads (concurrency > 1)
  // don't collide on the fixed middleware name (was: "Duplicate middleware name").
  command.middlewareStack.add(captureMiddleware, {
    step: "deserialize",
    name: "captureFilebaseCidHeader",
    priority: "low",
  });

  const output = await client.send(command);

  return {
    cid: capturedHeaders?.["x-amz-meta-cid"],
    retry: {
      attempts: output.$metadata.attempts ?? 1,
      retryDelayMs: output.$metadata.totalRetryDelay ?? 0,
      throttled: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Upload a single file
// ---------------------------------------------------------------------------

type UploadResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly cid: string;
      readonly retry: UploadRetryInfo;
    }
  | {
      readonly ok: false;
      readonly key: string;
      readonly error: string;
      readonly retry: UploadRetryInfo;
      readonly fatal: boolean;
    };

/**
 * Read retry and throttle details from an AWS SDK failure without weakening
 * the unknown-error boundary.
 *
 * @param error - Unknown failure thrown by file I/O or the AWS SDK.
 * @returns Normalized attempt, delay, and throttle information.
 */
function retryInfoFromError(error: unknown): UploadRetryInfo {
  let attempts = 1;
  let retryDelayMs = 0;
  let statusCode: number | undefined;
  let errorName = "";

  if (typeof error === "object" && error !== null) {
    if ("name" in error && typeof error.name === "string") {
      errorName = error.name;
    }
    if (
      "$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null
    ) {
      const metadata = error.$metadata;
      if ("attempts" in metadata && typeof metadata.attempts === "number") {
        attempts = metadata.attempts;
      }
      if (
        "totalRetryDelay" in metadata &&
        typeof metadata.totalRetryDelay === "number"
      ) {
        retryDelayMs = metadata.totalRetryDelay;
      }
      if (
        "httpStatusCode" in metadata &&
        typeof metadata.httpStatusCode === "number"
      ) {
        statusCode = metadata.httpStatusCode;
      }
    }
  }

  return {
    attempts,
    retryDelayMs,
    throttled:
      statusCode === 429 ||
      statusCode === 503 ||
      /throttl|slowdown|too.?many/iu.test(errorName),
  };
}

/**
 * Upload one JSON file and return a non-throwing per-object result.
 *
 * Failed reads and exhausted SDK retries become explicit failed results so the
 * worker pool can finish active work and preserve every successful journal entry.
 *
 * @param client - Shared Filebase-compatible S3 client.
 * @param options - Validated upload session options.
 * @param key - Stable Filebase object key.
 * @param absolutePath - Local JSON file path.
 * @param expectedCid - Immutable local CID, or null when unavailable.
 * @returns Success with CID/retries, or failure with error/retry visibility.
 */
async function uploadFile(
  client: S3Client,
  options: UploadOptions,
  key: string,
  absolutePath: string,
  expectedCid: string | null
): Promise<UploadResult> {
  try {
    const body = await readFile(absolutePath);
    const upload = await putObjectAndCaptureCid(client, {
      bucket: options.bucket,
      key,
      body,
      contentType: "application/json",
    });

    if (upload.cid === undefined) {
      return {
        ok: false,
        key,
        error: "Filebase did not return x-amz-meta-cid header",
        retry: upload.retry,
        fatal: false,
      };
    }

    if (expectedCid !== null && upload.cid !== expectedCid) {
      console.error(
        JSON.stringify({
          event: "cid_mismatch",
          key,
          expectedCid,
          filebaseCid: upload.cid,
          message: "Pre-computed CID is authoritative — Filebase CID differs. Investigate before trusting the upload.",
        })
      );
    }

    return { ok: true, key, cid: upload.cid, retry: upload.retry };
  } catch (error: unknown) {
    return {
      ok: false,
      key,
      error: error instanceof Error ? error.message : String(error),
      retry: retryInfoFromError(error),
      fatal: true,
    };
  }
}

/**
 * Emit current-plan totals, 60-second throughput, and SDK retry visibility.
 *
 * @param state - Mutable progress state for the current uploader session.
 * @returns Nothing.
 */
function logProgress(state: UploadProgressState): void {
  const snapshot = snapshotUploadProgress(state);
  console.log(
    JSON.stringify({
      event: "progress",
      uploaded: snapshot.uploaded,
      failed: snapshot.failed,
      skipped: snapshot.skipped,
      total: snapshot.total,
      done: snapshot.done,
      rolling_window_sec: snapshot.rollingWindowSec,
      rolling_rate_per_sec: Number(snapshot.rollingRatePerSec.toFixed(1)),
      retried_uploads: snapshot.retriedUploads,
      retry_attempts: snapshot.retryAttempts,
      retry_delay_ms: snapshot.retryDelayMs,
      throttled_failures: snapshot.throttledFailures,
    })
  );
}

// ---------------------------------------------------------------------------
// Filebase IPNS REST API helpers
// ---------------------------------------------------------------------------

// Filebase mutable IPNS pointers live under the Names API: /v1/names, keyed by
// label in the URL path (NOT /v1/ipns with an _id — that path 404s). The IPNS
// name consumers resolve is the record's `network_key` (k51q…).
const FILEBASE_NAMES_API = "https://api.filebase.io/v1/names";

async function getIpnsName(apiToken: string, label: string): Promise<FilebaseIpnsItem | null> {
  const response = await fetch(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Filebase IPNS get failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as FilebaseIpnsItem;
}

async function createIpnsName(apiToken: string, label: string, cid: string): Promise<void> {
  const response = await fetch(FILEBASE_NAMES_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label, cid, enabled: true }),
  });
  if (!response.ok) {
    throw new Error(`Filebase IPNS create failed: ${response.status} ${response.statusText}`);
  }
}

async function updateIpnsName(apiToken: string, label: string, cid: string): Promise<void> {
  const response = await fetch(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cid }),
  });
  if (!response.ok) {
    throw new Error(`Filebase IPNS update failed: ${response.status} ${response.statusText}`);
  }
}

async function upsertIpnsPointer(apiToken: string, label: string, indexCid: string): Promise<string> {
  const existing = await getIpnsName(apiToken, label);

  if (existing === null) {
    console.log(JSON.stringify({ event: "ipns_creating", label }));
    await createIpnsName(apiToken, label, indexCid);
  } else {
    await updateIpnsName(apiToken, label, indexCid);
  }

  // Re-read to get the resolved IPNS name (network_key, e.g. k51q…) and confirm the pointer.
  const record = await getIpnsName(apiToken, label);
  if (
    record === null ||
    record.label !== label ||
    record.cid !== indexCid ||
    record.network_key.trim().length === 0
  ) {
    throw new Error("Filebase IPNS readback did not match label and index CID");
  }
  const ipnsName = record.network_key;

  console.log(JSON.stringify({ event: "ipns_updated", label, ipnsName, indexCid }));
  return ipnsName;
}

/**
 * Verify the remotely retrievable index bytes, CID, and property count.
 *
 * @param indexCid - CID returned for the uploaded index object.
 * @param expectedPropertyCount - Count from the approved local manifest.
 * @returns Nothing after a matching gateway readback.
 */
export async function verifyRemoteIndex(
  indexCid: string,
  expectedPropertyCount: number,
): Promise<void> {
  const response = await fetch(`https://ipfs.filebase.io/ipfs/${indexCid}`);
  if (!response.ok) {
    throw new Error(
      `Filebase index readback failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  await assertRemoteIndexAgreement(body, indexCid, expectedPropertyCount);
}

/**
 * Assert remote index bytes agree with their CID and expected count.
 *
 * @param body - Remotely read index bytes.
 * @param indexCid - Expected immutable CID.
 * @param expectedPropertyCount - Approved manifest count.
 * @returns Nothing when both checks agree.
 */
export async function assertRemoteIndexAgreement(
  body: Buffer,
  indexCid: string,
  expectedPropertyCount: number,
): Promise<void> {
  const remoteCid = await computeIpfsCid(body);
  const parsed = JSON.parse(body.toString("utf8")) as {
    readonly propertyCount?: unknown;
  };
  if (
    remoteCid !== indexCid ||
    parsed.propertyCount !== expectedPropertyCount
  ) {
    throw new Error("Remote index CID/propertyCount agreement failed");
  }
}

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

function resolveEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set. Export it from vault credentials before running.`);
  }
  return value.trim();
}

function resolveOptionalEnvVar(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return null;
  return value.trim();
}

function parseOptions(argv: readonly string[]): UploadOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      i += 1;
    } else {
      values.set(key, "true");
    }
  }

  const concurrencyRaw = values.get("concurrency");
  const parsedConcurrency = concurrencyRaw !== undefined ? Number.parseInt(concurrencyRaw, 10) : null;
  const concurrency =
    parsedConcurrency !== null && Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
      ? parsedConcurrency
      : 32;

  const limitRaw = values.get("limit");
  const parsedLimit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : null;
  const limit = parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;

  const accessKeyId = resolveEnvVar("S3_ACCESS_KEY_ID");
  const secretAccessKey = resolveEnvVar("S3_SECRET_ACCESS_KEY");

  // The Filebase Names (IPNS) API bearer is base64("ACCESS_KEY:SECRET_KEY"). Derive it
  // from the S3 keys when FILEBASE_API_TOKEN is unset so IPNS publishing needs only the
  // S3 keys + a label — otherwise the run silently skips the IPNS pointer update and
  // consumers keep resolving the previous CID.
  const filebaseApiToken =
    resolveOptionalEnvVar("FILEBASE_API_TOKEN") ??
    Buffer.from(`${accessKeyId}:${secretAccessKey}`).toString("base64");
  const filebaseIpnsLabel = resolveEnvVar("FILEBASE_IPNS_LABEL");
  const endpoint = resolveEnvVar("S3_ENDPOINT");
  if (endpoint !== "https://s3.filebase.com") {
    throw new Error("S3_ENDPOINT must use the supported Filebase endpoint");
  }

  return {
    exportDir: values.get("export-dir") ?? ".property-consolidation-export",
    concurrency,
    dryRun: values.get("dry-run") === "true",
    limit,
    endpoint,
    bucket: resolveEnvVar("S3_BUCKET"),
    accessKeyId,
    secretAccessKey,
    filebaseApiToken,
    filebaseIpnsLabel,
    forceIndex: values.get("force-index") === "true",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const manifestPath = join(options.exportDir, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8").catch(() => {
    throw new Error(
      `manifest.json not found at ${manifestPath}. Run export:property-consolidation first.`
    );
  });

  const manifest = JSON.parse(manifestText) as ManifestSummary;
  let entries = manifest.entries as ManifestEntry[];

  if (options.limit !== null) {
    entries = entries.slice(0, options.limit);
  }

  // Detect whether a sharded index.json exists (produced by new export)
  const indexPath = join(options.exportDir, "index.json");
  const indexText = await readFile(indexPath, "utf8").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  });

  const indexFile: IndexFile | null = indexText !== null ? (JSON.parse(indexText) as IndexFile) : null;
  const hasShardedIndex = indexFile !== null;

  // Read shard filenames from disk (if sharded index exists)
  let shardFileNames: string[] = [];
  if (hasShardedIndex) {
    const shardsDir = join(options.exportDir, "shards");
    const allFiles = await readdir(shardsDir).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [] as string[];
      }
      throw err;
    });
    shardFileNames = allFiles.filter((f) => f.startsWith("shard-") && f.endsWith(".json")).sort();
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.fileSizeBytes, 0);

  // Count total upload items for progress reporting
  // property files + shard files (if any) + index.json (if any) + manifest.json
  const totalUploadCount =
    entries.length +
    (hasShardedIndex ? shardFileNames.length + 1 : 0) + // +1 for index.json
    1; // manifest.json

  console.log(
    JSON.stringify({
      event: "upload_session_started",
      exportDir: options.exportDir,
      propertyCount: manifest.propertyCount,
      entriesToUpload: entries.length,
      shardCount: shardFileNames.length,
      hasShardedIndex,
      totalBytes,
      concurrency: options.concurrency,
      dryRun: options.dryRun,
      endpoint: options.endpoint,
      bucket: options.bucket,
    })
  );

  // --dry-run: just list what would be uploaded and exit
  if (options.dryRun) {
    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    console.log(
      JSON.stringify({
        event: "dry_run_summary",
        wouldUpload: totalUploadCount,
        totalBytes,
        totalMb: mb,
        firstEntry: entries[0]?.propertyId ?? null,
        lastEntry: entries[entries.length - 1]?.propertyId ?? null,
      })
    );
    const extraFiles = hasShardedIndex ? `+ ${shardFileNames.length} shard files + index.json + manifest.json` : `+ manifest.json`;
    console.log(`[dry-run] Would upload ${entries.length} property files ${extraFiles} (${mb} MB total). No uploads performed.`);
    return;
  }

  await mkdir(DEFAULT_UPLOAD_RUNS_DIR, { recursive: true });
  const checkpointPaths = uploadCheckpointPathsForBucket(options.bucket);
  const recovery = await readUploadCheckpoint(checkpointPaths);
  const startedAt = new Date().toISOString();

  if (recovery.partialJournalTailIgnored) {
    console.warn(
      JSON.stringify({
        event: "checkpoint_partial_tail_ignored",
        journalPath: checkpointPaths.journalPath,
        message: "Ignored one incomplete final journal line; its fixed-content object is safe to re-upload.",
      }),
    );
  }
  console.log(
    JSON.stringify({
      event: "checkpoint_recovered",
      snapshotEntries: recovery.legacyEntryCount,
      journalEntries: recovery.journalEntryCount,
      uniqueEntries: recovery.uploaded.size,
    }),
  );

  const alreadyUploaded = new Map<string, CheckpointRecord>(recovery.uploaded);
  for (const entry of entries) {
    const key = `properties/${entry.propertyId}.json`;
    if (entry.cid === null) {
      throw new Error(`Property manifest CID is required for ${key}`);
    }
    assertPropertyCheckpointCid(alreadyUploaded.get(key), entry.cid, key);
  }
  const client = buildS3Client(options);

  const progress = createUploadProgress(totalUploadCount);
  const failures: string[] = [];
  let journal = new CheckpointJournal(checkpointPaths.journalPath);
  const progressTimer = setInterval(() => logProgress(progress), 30_000);
  progressTimer.unref();

  // Log on volume in addition to the 30-second rolling-throughput timer.
  let lastLogAt = 0;

  /**
   * Persist one per-object result before exposing it as completed progress.
   *
   * @param result - Upload outcome including CID or error and SDK retry details.
   * @returns Promise resolved after successful uploads are journaled.
   */
  const handleResult = async (result: UploadResult): Promise<void> => {
    if (!result.ok) {
      failures.push(result.key);
      recordUploadFailure(progress, result.retry);
      console.error(
        JSON.stringify({
          event: "upload_failed",
          key: result.key,
          error: result.error,
          attempts: result.retry.attempts,
          retryDelayMs: result.retry.retryDelayMs,
          throttled: result.retry.throttled,
        }),
      );
      if (result.fatal) {
        throw new Error(`Upload operation failed for ${result.key}: ${result.error}`);
      }
      return;
    }

    const record: CheckpointRecord = {
      key: result.key,
      cid: result.cid,
      uploadedAt: new Date().toISOString(),
    };
    await journal.append(record);
    alreadyUploaded.set(result.key, record);
    recordUploadSuccess(progress, result.retry);

    if (result.retry.attempts > 1) {
      console.warn(
        JSON.stringify({
          event: "upload_retried",
          key: result.key,
          attempts: result.retry.attempts,
          retryDelayMs: result.retry.retryDelayMs,
        }),
      );
    }

    if (progress.uploaded - lastLogAt >= 500) {
      lastLogAt = progress.uploaded;
      logProgress(progress);
    }
  };

  // 1. Upload property files with only O(concurrency) active/pending workers.
  await runBoundedWorkerPool(entries, options.concurrency, async (entry) => {
    const key = `properties/${entry.propertyId}.json`;
    // Use the relative key, not entry.filePath: the manifest stores filePath WITH the
    // export-dir prefix already, so join(exportDir, filePath) would double it
    // (".property-consolidation-export/.property-consolidation-export/...").
    const absolutePath = join(options.exportDir, key);

    if (alreadyUploaded.has(key)) {
      recordUploadSkipped(progress);
      return;
    }

    const result = await uploadFile(client, options, key, absolutePath, entry.cid);
    await handleResult(result);
  });

  // One atomic O(n) compaction at the large phase boundary replaces the former
  // full-map rewrite every 500 records. The old journal remains recoverable
  // until the compatible snapshot rename has completed.
  await journal.close();
  await compactUploadCheckpoint(checkpointPaths, startedAt, alreadyUploaded);
  journal = new CheckpointJournal(checkpointPaths.journalPath);
  console.log(
    JSON.stringify({
      event: "checkpoint_compacted",
      phase: "properties",
      entries: alreadyUploaded.size,
    }),
  );

  // 2. Upload shard files (if sharded index exists), before index.json
  if (hasShardedIndex && indexFile !== null) {
    // Build a map of shard filename → expected CID from the index
    const shardCidMap = new Map<string, string | null>();
    for (const shardRef of indexFile.shards) {
      const paddedIndex = String(shardRef.shardIndex).padStart(4, "0");
      shardCidMap.set(`shard-${paddedIndex}.json`, shardRef.shardCid);
    }

    if (failures.length > 0) {
      console.error(
        JSON.stringify({
          event: "shard_upload_skipped",
          reason: "property_file_failures_present",
          failureCount: failures.length,
          message: "Fix property file failures before uploading shard files.",
        })
      );
    } else {
      await runBoundedWorkerPool(
        shardFileNames,
        options.concurrency,
        async (fileName) => {
          const s3Key = `shards/${fileName}`;
          const absolutePath = join(options.exportDir, "shards", fileName);
          // The index carries each shard's freshly-computed local CID; use it to
          // decide whether the checkpointed copy is stale.
          const expectedCid = shardCidMap.get(fileName) ?? null;
          const existing = alreadyUploaded.get(s3Key);
          const decision = decideFixedKeyUpload(existing, expectedCid, options.forceIndex);

          if (!decision.reupload) {
            recordUploadSkipped(progress);
            return;
          }

          if (decision.reason !== "new") {
            console.log(
              JSON.stringify({
                event: "fixed_key_reupload",
                key: s3Key,
                reason: decision.reason,
                previousCid: existing?.cid ?? null,
                localCid: expectedCid,
              })
            );
          }

          const result = await uploadFile(client, options, s3Key, absolutePath, expectedCid);
          await handleResult(result);
        },
      );
    }
  }

  // 3. Upload index.json AFTER all shards succeed (only if sharded index exists)
  const indexKey = "index.json";
  let indexCid: string | undefined;

  if (hasShardedIndex) {
    if (failures.length > 0) {
      console.error(
        JSON.stringify({
          event: "index_upload_skipped",
          reason: "prior_upload_failures_present",
          failureCount: failures.length,
          message: "Fix failures and resume before uploading index.json.",
        })
      );
    } else {
      const indexBody = await readFile(indexPath);
      const localIndexCid = await computeIpfsCid(indexBody);
      const existingIndex = alreadyUploaded.get(indexKey);
      const decision = decideFixedKeyUpload(existingIndex, localIndexCid, options.forceIndex);

      if (!decision.reupload) {
        indexCid = existingIndex?.cid;
        recordUploadSkipped(progress);
        console.log(JSON.stringify({ event: "index_already_uploaded", cid: indexCid }));
      } else {
        if (decision.reason !== "new") {
          console.log(
            JSON.stringify({
              event: "fixed_key_reupload",
              key: indexKey,
              reason: decision.reason,
              previousCid: existingIndex?.cid ?? null,
              localCid: localIndexCid,
            })
          );
        }

        const result = await uploadFile(
          client,
          options,
          indexKey,
          indexPath,
          localIndexCid,
        );
        await handleResult(result);
        if (result.ok) {
          indexCid = result.cid;
        }
      }
    }
  }

  // 4. Upload manifest.json LAST (after index.json, only after all prior uploads succeed)
  const manifestKey = "manifest.json";
  let manifestCid: string | undefined;

  if (failures.length > 0) {
    console.error(
      JSON.stringify({
        event: "manifest_upload_skipped",
        reason: "property_file_failures_present",
        failureCount: failures.length,
        message: "Fix failures and resume before uploading manifest.",
      })
    );
  } else {
    const manifestBody = await readFile(manifestPath);
    const localManifestCid = await computeIpfsCid(manifestBody);
    const existingManifest = alreadyUploaded.get(manifestKey);
    const decision = decideFixedKeyUpload(existingManifest, localManifestCid, options.forceIndex);

    if (!decision.reupload) {
      manifestCid = existingManifest?.cid;
      recordUploadSkipped(progress);
      console.log(JSON.stringify({ event: "manifest_already_uploaded", cid: manifestCid }));
    } else {
      if (decision.reason !== "new") {
        console.log(
          JSON.stringify({
            event: "fixed_key_reupload",
            key: manifestKey,
            reason: decision.reason,
            previousCid: existingManifest?.cid ?? null,
            localCid: localManifestCid,
          })
        );
      }

      const result = await uploadFile(
        client,
        options,
        manifestKey,
        manifestPath,
        localManifestCid,
      );
      await handleResult(result);
      if (result.ok) {
        manifestCid = result.cid;
      }
    }
  }

  // Final serialized flush + atomic compaction. At no point is a valid snapshot
  // or journal truncated in place.
  await journal.close();
  await compactUploadCheckpoint(checkpointPaths, startedAt, alreadyUploaded);
  clearInterval(progressTimer);
  console.log(
    JSON.stringify({
      event: "checkpoint_compacted",
      phase: "final",
      entries: alreadyUploaded.size,
    }),
  );

  // 5. IPNS upsert (if API token is set and index was uploaded)
  let ipnsName: string | undefined;
  if (hasShardedIndex && indexCid !== undefined) {
    if (options.filebaseApiToken === null || options.filebaseIpnsLabel === null) {
      throw new Error("Filebase API token and IPNS label are required");
    }
    ipnsName = await upsertIpnsPointer(
      options.filebaseApiToken,
      options.filebaseIpnsLabel,
      indexCid,
    );
    await verifyRemoteIndex(indexCid, manifest.propertyCount);
  }

  // Final summary
  logProgress(progress);
  const finalProgress = snapshotUploadProgress(progress);

  console.log(
    JSON.stringify({
      event: "upload_session_complete",
      uploaded: finalProgress.uploaded,
      skipped: finalProgress.skipped,
      failed: finalProgress.failed,
      total: finalProgress.total,
      done: finalProgress.done,
      rollingRatePerSec: Number(finalProgress.rollingRatePerSec.toFixed(1)),
      retriedUploads: finalProgress.retriedUploads,
      retryAttempts: finalProgress.retryAttempts,
      retryDelayMs: finalProgress.retryDelayMs,
      throttledFailures: finalProgress.throttledFailures,
      indexCid: indexCid ?? null,
      manifestCid: manifestCid ?? null,
      ipnsName: ipnsName ?? null,
    })
  );

  if (indexCid !== undefined) {
    console.log(`\n=== INDEX CID ===`);
    console.log(`${indexCid}`);
    console.log(`Set ORACLE_OPEN_DATA_INDEX_CID=${indexCid} in your MCP/NEO environment.\n`);
  }

  if (manifestCid !== undefined) {
    console.log(`\n=== MANIFEST CID ===`);
    console.log(`${manifestCid}`);
    console.log(`Set ORACLE_OPEN_DATA_MANIFEST_CID=${manifestCid} in your MCP/NEO environment.\n`);
  }

  if (ipnsName !== undefined) {
    console.log(`\n=== IPNS ===`);
    console.log(`IPNS name: ${ipnsName}`);
    console.log(`Set ORACLE_OPEN_DATA_IPNS=${ipnsName} in your MCP/NEO environment.\n`);
  } else if (hasShardedIndex && indexCid !== undefined && options.filebaseApiToken === null) {
    console.log(`\n=== IPNS ===`);
    console.log(`IPNS update skipped: FILEBASE_API_TOKEN not set.\n`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} upload(s) failed. Re-run the same command to resume — already-uploaded files will be skipped.\n`);
    process.exit(1);
  }
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "upload_failed_fatal", error: message }));
    process.exit(1);
  });
}
