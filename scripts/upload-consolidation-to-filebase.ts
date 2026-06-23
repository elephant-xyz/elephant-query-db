import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PutObjectCommand,
  S3Client,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import type {
  DeserializeHandler,
  DeserializeHandlerArguments,
  DeserializeHandlerOutput,
  DeserializeMiddleware,
  HandlerExecutionContext,
} from "@smithy/types";

import type { IndexFile, ManifestEntry, ManifestSummary } from "./run-property-consolidation-export.js";

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
  readonly filebaseApiToken: string;
  readonly filebaseIpnsLabel: string | null;
};

type CheckpointRecord = {
  readonly key: string;
  readonly cid: string;
  readonly uploadedAt: string;
};

type Checkpoint = {
  readonly schemaVersion: "1";
  readonly startedAt: string;
  readonly entries: CheckpointRecord[];
};

type FilebaseIpnsName = {
  readonly label: string;
  readonly network_key: string;
  readonly cid: string;
  readonly sequence: number;
  readonly enabled: boolean;
};

// ---------------------------------------------------------------------------
// Semaphore (no extra dependencies)
// ---------------------------------------------------------------------------

class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.slots = concurrency;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    } else {
      this.slots += 1;
    }
  }
}

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
// Checkpoint helpers
// ---------------------------------------------------------------------------

const UPLOAD_RUNS_DIR = ".upload-runs";
const CHECKPOINT_PATH = join(UPLOAD_RUNS_DIR, "filebase-upload-checkpoint.json");

async function readCheckpoint(): Promise<Map<string, CheckpointRecord>> {
  const text = await readFile(CHECKPOINT_PATH, "utf8").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  });

  if (text === null) return new Map();

  const parsed = JSON.parse(text) as Checkpoint;
  const map = new Map<string, CheckpointRecord>();
  for (const entry of parsed.entries) {
    map.set(entry.key, entry);
  }
  return map;
}

function writeCheckpointSync(startedAt: string, uploaded: Map<string, CheckpointRecord>): void {
  const checkpoint: Checkpoint = {
    schemaVersion: "1",
    startedAt,
    entries: [...uploaded.values()],
  };
  writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8").catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "checkpoint_write_failed", error: message }));
  });
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

async function putObjectAndCaptureCid(
  client: S3Client,
  params: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  }
): Promise<string | undefined> {
  // NOTE: we no longer read Filebase's x-amz-meta-cid per file. Capturing it required a
  // shared-client deserialize middleware that is NOT concurrency-safe — at high --concurrency
  // the same-named middleware is added repeatedly ("Duplicate middleware name") and its closure
  // cross-contaminates across in-flight requests. The pre-computed CID (ipfs-only-hash, the same
  // algorithm Filebase uses) is authoritative and is what the index/IPNS reference, so we trust
  // it instead. (A separate sampled audit can confirm Filebase pins match, if ever needed.)
  const command = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
  });

  await client.send(command);
  return undefined;
}

// Sequential CID capture — for the single index.json + manifest.json uploads only.
// These run one-at-a-time (after all parallel file uploads finish), so the named
// deserialize middleware is safe here (no duplicate-name / cross-request race).
async function putObjectCaptureCidSequential(
  client: S3Client,
  params: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  }
): Promise<string | undefined> {
  let capturedHeaders: Record<string, string> | undefined;
  const captureMiddleware: DeserializeMiddleware<ServiceInputTypes, ServiceOutputTypes> =
    (next: DeserializeHandler<ServiceInputTypes, ServiceOutputTypes>, _context: HandlerExecutionContext) =>
    async (args: DeserializeHandlerArguments<ServiceInputTypes>): Promise<DeserializeHandlerOutput<ServiceOutputTypes>> => {
      const result = await next(args);
      if (isRawHttpResponse(result.response)) capturedHeaders = result.response.headers;
      return result;
    };
  client.middlewareStack.add(captureMiddleware, {
    step: "deserialize",
    name: "captureFilebaseCidHeaderSeq",
    priority: "low",
  });
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      })
    );
  } finally {
    client.middlewareStack.remove("captureFilebaseCidHeaderSeq");
  }
  return capturedHeaders?.["x-amz-meta-cid"];
}

// ---------------------------------------------------------------------------
// Upload a single file
// ---------------------------------------------------------------------------

type UploadResult =
  | { readonly ok: true; readonly key: string; readonly cid: string }
  | { readonly ok: false; readonly key: string; readonly error: string };

async function uploadFile(
  client: S3Client,
  options: UploadOptions,
  key: string,
  absolutePath: string,
  expectedCid: string | null
): Promise<UploadResult> {
  const body = await readFile(absolutePath);
  await putObjectAndCaptureCid(client, {
    bucket: options.bucket,
    key,
    body,
    contentType: "application/json",
  });

  if (expectedCid === null) {
    return { ok: false, key, error: "Missing pre-computed CID for entry" };
  }

  // Pre-computed CID (ipfs-only-hash == Filebase's CID algorithm) is authoritative.
  return { ok: true, key, cid: expectedCid };
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

type ProgressState = {
  total: number;
  uploaded: number;
  failed: number;
  skipped: number;
  startedAt: number;
};

function logProgress(state: ProgressState): void {
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  const rate = elapsedSec > 0 ? (state.uploaded / elapsedSec).toFixed(1) : "0";
  const done = state.uploaded + state.failed + state.skipped;
  console.log(
    JSON.stringify({
      event: "progress",
      uploaded: state.uploaded,
      failed: state.failed,
      skipped: state.skipped,
      total: state.total,
      done,
      rate_per_sec: rate,
    })
  );
}

// ---------------------------------------------------------------------------
// Filebase IPNS REST API helpers (Names API: https://api.filebase.io/v1/names)
//
// Auth: Authorization: Bearer base64(S3_ACCESS_KEY_ID:S3_SECRET_ACCESS_KEY).
// Names are keyed by their `label` in the URL path. The resolvable IPNS name
// is the `network_key` (k51…) returned by every endpoint.
// ---------------------------------------------------------------------------

const FILEBASE_NAMES_API = "https://api.filebase.io/v1/names";

function ipnsHeaders(apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

export async function getIpnsName(apiToken: string, label: string): Promise<FilebaseIpnsName | null> {
  const response = await fetch(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
    method: "GET",
    headers: ipnsHeaders(apiToken),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Filebase IPNS get failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as FilebaseIpnsName;
}

async function createIpnsName(apiToken: string, label: string, cid: string): Promise<FilebaseIpnsName> {
  const response = await fetch(FILEBASE_NAMES_API, {
    method: "POST",
    headers: ipnsHeaders(apiToken),
    body: JSON.stringify({ label, cid }),
  });

  if (!response.ok) {
    throw new Error(`Filebase IPNS create failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as FilebaseIpnsName;
}

async function updateIpnsName(apiToken: string, label: string, cid: string): Promise<FilebaseIpnsName> {
  const response = await fetch(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
    method: "PUT",
    headers: ipnsHeaders(apiToken),
    body: JSON.stringify({ cid }),
  });

  if (!response.ok) {
    throw new Error(`Filebase IPNS update failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as FilebaseIpnsName;
}

export async function upsertIpnsPointer(apiToken: string, label: string, indexCid: string): Promise<string> {
  const existing = await getIpnsName(apiToken, label);

  const name =
    existing === null
      ? (console.log(JSON.stringify({ event: "ipns_creating", label })),
        await createIpnsName(apiToken, label, indexCid))
      : await updateIpnsName(apiToken, label, indexCid);

  console.log(
    JSON.stringify({
      event: "ipns_updated",
      label,
      ipnsName: name.network_key,
      sequence: name.sequence,
      indexCid,
    })
  );
  return name.network_key;
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

  // The Filebase Names (IPNS) API authenticates with the same S3 keys:
  // Authorization: Bearer base64(ACCESS_KEY:SECRET_KEY). Auto-derive the
  // token from the S3 keys so IPNS works with only S3 keys + an IPNS label.
  // FILEBASE_API_TOKEN remains an optional explicit override.
  const filebaseApiToken =
    resolveOptionalEnvVar("FILEBASE_API_TOKEN") ??
    Buffer.from(`${accessKeyId}:${secretAccessKey}`).toString("base64");
  const filebaseIpnsLabel = resolveOptionalEnvVar("FILEBASE_IPNS_LABEL");

  return {
    exportDir: values.get("export-dir") ?? ".property-consolidation-export",
    concurrency,
    dryRun: values.get("dry-run") === "true",
    limit,
    endpoint: process.env["S3_ENDPOINT"] ?? "https://s3.filebase.io",
    bucket: resolveEnvVar("S3_BUCKET"),
    accessKeyId,
    secretAccessKey,
    filebaseApiToken,
    filebaseIpnsLabel,
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

  await mkdir(UPLOAD_RUNS_DIR, { recursive: true });
  const checkpoint = await readCheckpoint();
  const startedAt = new Date().toISOString();

  const alreadyUploaded = new Map<string, CheckpointRecord>(checkpoint);
  const client = buildS3Client(options);

  const progress: ProgressState = {
    total: totalUploadCount,
    uploaded: 0,
    failed: 0,
    skipped: alreadyUploaded.size,
    startedAt: Date.now(),
  };

  const semaphore = new Semaphore(options.concurrency);
  const failures: string[] = [];

  // Log progress every 500 uploaded
  let lastLogAt = 0;

  const handleResult = (result: UploadResult): void => {
    if (!result.ok) {
      failures.push(result.key);
      progress.failed += 1;
      console.error(JSON.stringify({ event: "upload_failed", key: result.key, error: result.error }));
      return;
    }

    alreadyUploaded.set(result.key, {
      key: result.key,
      cid: result.cid,
      uploadedAt: new Date().toISOString(),
    });
    progress.uploaded += 1;

    if (progress.uploaded - lastLogAt >= 500) {
      lastLogAt = progress.uploaded;
      logProgress(progress);
      writeCheckpointSync(startedAt, alreadyUploaded);
    }
  };

  // 1. Upload property files in parallel
  const uploadTasks = entries.map((entry) => {
    const key = `properties/${entry.propertyId}.json`;
    // entry.filePath may already be exportDir-relative-from-cwd (e.g. ".property-consolidation-export/properties/x.json")
    // or relative-to-exportDir ("properties/x.json"); handle both so we don't double the prefix.
    const absolutePath = entry.filePath.startsWith(options.exportDir)
      ? entry.filePath
      : join(options.exportDir, entry.filePath);

    if (alreadyUploaded.has(key)) {
      progress.skipped += 1;
      return Promise.resolve();
    }

    return semaphore.runExclusive(async () => {
      const result = await uploadFile(client, options, key, absolutePath, entry.cid);
      handleResult(result);
    });
  });

  await Promise.all(uploadTasks);

  // Flush checkpoint after all property files
  writeCheckpointSync(startedAt, alreadyUploaded);

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
      const shardTasks = shardFileNames.map((fileName) => {
        const s3Key = `shards/${fileName}`;
        const absolutePath = join(options.exportDir, "shards", fileName);
        const expectedCid = shardCidMap.get(fileName) ?? null;

        if (alreadyUploaded.has(s3Key)) {
          progress.skipped += 1;
          return Promise.resolve();
        }

        return semaphore.runExclusive(async () => {
          const result = await uploadFile(client, options, s3Key, absolutePath, expectedCid);
          handleResult(result);
        });
      });

      await Promise.all(shardTasks);
      writeCheckpointSync(startedAt, alreadyUploaded);
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
    } else if (alreadyUploaded.has(indexKey)) {
      indexCid = alreadyUploaded.get(indexKey)?.cid;
      console.log(JSON.stringify({ event: "index_already_uploaded", cid: indexCid }));
    } else {
      const indexBody = await readFile(indexPath);
      const filebaseCid = await putObjectCaptureCidSequential(client, {
        bucket: options.bucket,
        key: indexKey,
        body: indexBody,
        contentType: "application/json",
      });

      if (filebaseCid === undefined) {
        failures.push(indexKey);
        console.error(JSON.stringify({ event: "index_upload_failed", error: "No CID returned from Filebase" }));
      } else {
        indexCid = filebaseCid;
        alreadyUploaded.set(indexKey, {
          key: indexKey,
          cid: filebaseCid,
          uploadedAt: new Date().toISOString(),
        });
        writeCheckpointSync(startedAt, alreadyUploaded);
        progress.uploaded += 1;
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
  } else if (alreadyUploaded.has(manifestKey)) {
    manifestCid = alreadyUploaded.get(manifestKey)?.cid;
    console.log(JSON.stringify({ event: "manifest_already_uploaded", cid: manifestCid }));
  } else {
    const manifestBody = await readFile(manifestPath);
    const filebaseCid = await putObjectCaptureCidSequential(client, {
      bucket: options.bucket,
      key: manifestKey,
      body: manifestBody,
      contentType: "application/json",
    });

    if (filebaseCid === undefined) {
      failures.push(manifestKey);
      console.error(JSON.stringify({ event: "manifest_upload_failed", error: "No CID returned from Filebase" }));
    } else {
      manifestCid = filebaseCid;
      alreadyUploaded.set(manifestKey, {
        key: manifestKey,
        cid: filebaseCid,
        uploadedAt: new Date().toISOString(),
      });
      writeCheckpointSync(startedAt, alreadyUploaded);
      progress.uploaded += 1;
    }
  }

  // 5. IPNS upsert (token is auto-derived from S3 keys; only needs a label)
  let ipnsName: string | undefined;
  if (hasShardedIndex && indexCid !== undefined) {
    if (options.filebaseIpnsLabel === null) {
      console.warn("[ipns] FILEBASE_IPNS_LABEL is not set — skipping IPNS update. Set it to a label like \"oracle-open-data-lee\".");
    } else {
      try {
        ipnsName = await upsertIpnsPointer(options.filebaseApiToken, options.filebaseIpnsLabel, indexCid);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ event: "ipns_update_failed", error: message }));
      }
    }
  }

  // Final summary
  logProgress(progress);

  console.log(
    JSON.stringify({
      event: "upload_session_complete",
      uploaded: progress.uploaded,
      skipped: progress.skipped,
      failed: progress.failed,
      total: progress.total,
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
  } else if (hasShardedIndex && indexCid !== undefined && options.filebaseIpnsLabel === null) {
    console.log(`\n=== IPNS ===`);
    console.log(`IPNS update skipped: FILEBASE_IPNS_LABEL not set.\n`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} upload(s) failed. Re-run the same command to resume — already-uploaded files will be skipped.\n`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "upload_failed_fatal", error: message }));
    process.exit(1);
  });
}
