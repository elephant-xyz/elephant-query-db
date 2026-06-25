import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  readonly filebaseApiToken: string | null;
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

type FilebaseIpnsItem = {
  readonly label: string;
  readonly network_key: string;
  readonly cid?: string;
  readonly sequence?: number;
  readonly enabled?: boolean;
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

  await client.send(command);

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
  const filebaseCid = await putObjectAndCaptureCid(client, {
    bucket: options.bucket,
    key,
    body,
    contentType: "application/json",
  });

  if (filebaseCid === undefined) {
    return { ok: false, key, error: "Filebase did not return x-amz-meta-cid header" };
  }

  if (expectedCid !== null && filebaseCid !== expectedCid) {
    console.error(
      JSON.stringify({
        event: "cid_mismatch",
        key,
        expectedCid,
        filebaseCid,
        message: "Pre-computed CID is authoritative — Filebase CID differs. Investigate before trusting the upload.",
      })
    );
  }

  return { ok: true, key, cid: filebaseCid };
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
  const ipnsName = record?.network_key ?? label;

  console.log(JSON.stringify({ event: "ipns_updated", label, ipnsName, indexCid }));
  return ipnsName;
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

  const filebaseApiToken = resolveOptionalEnvVar("FILEBASE_API_TOKEN");
  const filebaseIpnsLabel = resolveOptionalEnvVar("FILEBASE_IPNS_LABEL");

  return {
    exportDir: values.get("export-dir") ?? ".property-consolidation-export",
    concurrency,
    dryRun: values.get("dry-run") === "true",
    limit,
    endpoint: process.env["S3_ENDPOINT"] ?? "https://s3.filebase.io",
    bucket: resolveEnvVar("S3_BUCKET"),
    accessKeyId: resolveEnvVar("S3_ACCESS_KEY_ID"),
    secretAccessKey: resolveEnvVar("S3_SECRET_ACCESS_KEY"),
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
    // Use the relative key, not entry.filePath: the manifest stores filePath WITH the
    // export-dir prefix already, so join(exportDir, filePath) would double it
    // (".property-consolidation-export/.property-consolidation-export/...").
    const absolutePath = join(options.exportDir, key);

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
      const filebaseCid = await putObjectAndCaptureCid(client, {
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
    const filebaseCid = await putObjectAndCaptureCid(client, {
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

  // 5. IPNS upsert (if API token is set and index was uploaded)
  let ipnsName: string | undefined;
  if (hasShardedIndex && indexCid !== undefined) {
    if (options.filebaseApiToken !== null) {
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
    } else {
      console.log("[ipns] FILEBASE_API_TOKEN not set — skipping IPNS update.");
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
  } else if (hasShardedIndex && indexCid !== undefined && options.filebaseApiToken === null) {
    console.log(`\n=== IPNS ===`);
    console.log(`IPNS update skipped: FILEBASE_API_TOKEN not set.\n`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} upload(s) failed. Re-run the same command to resume — already-uploaded files will be skipped.\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ event: "upload_failed_fatal", error: message }));
  process.exit(1);
});
