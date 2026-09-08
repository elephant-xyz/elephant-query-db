import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const DEFAULT_UPLOAD_RUNS_DIR = ".upload-runs";

export type CheckpointRecord = {
  readonly key: string;
  readonly cid: string;
  readonly uploadedAt: string;
};

type LegacyCheckpoint = {
  readonly schemaVersion: "1";
  readonly startedAt: string;
  readonly entries: readonly CheckpointRecord[];
};

type JournalRecord = {
  readonly schemaVersion: "2";
  readonly type: "upload_succeeded";
  readonly record: CheckpointRecord;
};

export type UploadCheckpointPaths = {
  readonly snapshotPath: string;
  readonly journalPath: string;
};

export type UploadCheckpointRecovery = {
  readonly uploaded: Map<string, CheckpointRecord>;
  readonly legacyEntryCount: number;
  readonly journalEntryCount: number;
  readonly partialJournalTailIgnored: boolean;
};

export type UploadRetryInfo = {
  readonly attempts: number;
  readonly retryDelayMs: number;
  readonly throttled: boolean;
};

export type UploadProgressState = {
  total: number;
  uploaded: number;
  failed: number;
  skipped: number;
  startedAt: number;
  rollingWindowMs: number;
  recentUploadTimestamps: number[];
  retriedUploads: number;
  retryAttempts: number;
  retryDelayMs: number;
  throttledFailures: number;
};

export type UploadProgressSnapshot = {
  readonly total: number;
  readonly uploaded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly done: number;
  readonly rollingWindowSec: number;
  readonly rollingRatePerSec: number;
  readonly retriedUploads: number;
  readonly retryAttempts: number;
  readonly retryDelayMs: number;
  readonly throttledFailures: number;
};

/**
 * Build the legacy snapshot and append-only journal paths for one Filebase bucket.
 *
 * The snapshot path intentionally remains unchanged so existing schemaVersion 1
 * checkpoints continue to resume. The journal is bucket-scoped beside it.
 *
 * @param bucket - Filebase bucket whose stable object keys the checkpoint tracks.
 * @param runsDir - Directory that contains uploader state files.
 * @returns Paths for the compatible JSON snapshot and schemaVersion 2 NDJSON journal.
 */
export function uploadCheckpointPathsForBucket(
  bucket: string,
  runsDir: string = DEFAULT_UPLOAD_RUNS_DIR,
): UploadCheckpointPaths {
  const safeBucket = bucket.replace(/[^a-zA-Z0-9._-]/gu, "_");
  const stem = `filebase-upload-checkpoint-${safeBucket}`;
  return {
    snapshotPath: join(runsDir, `${stem}.json`),
    journalPath: join(runsDir, `${stem}.ndjson`),
  };
}

/**
 * Read a text file when present without hiding non-ENOENT filesystem failures.
 *
 * @param path - File to read as UTF-8.
 * @returns File contents, or null when the path does not exist.
 */
async function readOptionalText(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  });
}

/**
 * Check that an unknown JSON value is a complete successful-upload record.
 *
 * @param value - Parsed JSON value to validate.
 * @returns True only for records with non-empty key, CID, and timestamp strings.
 */
function isCheckpointRecord(value: unknown): value is CheckpointRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    "cid" in value &&
    typeof value.cid === "string" &&
    value.cid.length > 0 &&
    "uploadedAt" in value &&
    typeof value.uploadedAt === "string" &&
    value.uploadedAt.length > 0
  );
}

/**
 * Parse and validate the legacy schemaVersion 1 JSON checkpoint.
 *
 * @param text - Complete legacy checkpoint JSON.
 * @param path - Source path included in validation errors.
 * @returns Validated legacy checkpoint.
 */
function parseLegacyCheckpoint(text: string, path: string): LegacyCheckpoint {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== "1" ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "string" ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isCheckpointRecord)
  ) {
    throw new Error(`Invalid schemaVersion 1 Filebase checkpoint at ${path}`);
  }
  return {
    schemaVersion: "1",
    startedAt: parsed.startedAt,
    entries: parsed.entries,
  };
}

/**
 * Parse and validate one complete schemaVersion 2 NDJSON journal line.
 *
 * @param line - One non-empty NDJSON line.
 * @param path - Journal path included in validation errors.
 * @param lineNumber - One-based line number included in validation errors.
 * @returns Successful upload record carried by the line.
 */
function parseJournalLine(
  line: string,
  path: string,
  lineNumber: number,
): CheckpointRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error: unknown) {
    throw new Error(
      `Invalid schemaVersion 2 Filebase journal JSON at ${path}:${lineNumber}`,
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== "2" ||
    !("type" in parsed) ||
    parsed.type !== "upload_succeeded" ||
    !("record" in parsed) ||
    !isCheckpointRecord(parsed.record)
  ) {
    throw new Error(
      `Invalid schemaVersion 2 Filebase journal record at ${path}:${lineNumber}`,
    );
  }
  return parsed.record;
}

/**
 * Recover uploaded keys from the legacy snapshot followed by the new journal.
 *
 * Journal records win by key, allowing fixed-key objects to be safely updated.
 * A malformed final line is tolerated only when it lacks a terminating newline,
 * which is the expected shape of a process crash during one append. Malformed
 * complete or non-final records fail closed.
 *
 * @param paths - Bucket-scoped snapshot and journal paths.
 * @returns Recovered map, source counts, and partial-tail status.
 */
export async function readUploadCheckpoint(
  paths: UploadCheckpointPaths,
): Promise<UploadCheckpointRecovery> {
  const uploaded = new Map<string, CheckpointRecord>();
  const snapshotText = await readOptionalText(paths.snapshotPath);
  let legacyEntryCount = 0;

  if (snapshotText !== null) {
    const snapshot = parseLegacyCheckpoint(snapshotText, paths.snapshotPath);
    legacyEntryCount = snapshot.entries.length;
    for (const entry of snapshot.entries) {
      uploaded.set(entry.key, entry);
    }
  }

  const journalText = await readOptionalText(paths.journalPath);
  let journalEntryCount = 0;
  let partialJournalTailIgnored = false;

  if (journalText !== null && journalText.length > 0) {
    const hasTerminatingNewline = journalText.endsWith("\n");
    const lines = journalText.split("\n");
    const lastContentIndex = hasTerminatingNewline ? lines.length - 2 : lines.length - 1;

    for (let index = 0; index <= lastContentIndex; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim().length === 0) continue;
      try {
        const record = parseJournalLine(line, paths.journalPath, index + 1);
        uploaded.set(record.key, record);
        journalEntryCount += 1;
      } catch (error: unknown) {
        if (index === lastContentIndex && !hasTerminatingNewline) {
          partialJournalTailIgnored = true;
          break;
        }
        throw error;
      }
    }
  }

  return {
    uploaded,
    legacyEntryCount,
    journalEntryCount,
    partialJournalTailIgnored,
  };
}

/**
 * Atomically replace one text file without ever truncating the valid destination.
 *
 * Bytes are written and synced to a unique sibling file first, then renamed over
 * the destination. A failure before rename leaves the prior destination intact.
 *
 * @param destinationPath - Stable file path readers use.
 * @param contents - Complete UTF-8 contents for the replacement file.
 * @returns Promise resolved after the replacement and parent directory are synced.
 */
export async function writeTextFileAtomically(
  destinationPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | null = null;

  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, destinationPath);

    const directoryHandle = await open(dirname(destinationPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error: unknown) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Compact recovered upload state into the compatible JSON snapshot, then rotate
 * the journal to an empty file by atomic rename. If rotation fails, the valid
 * snapshot and old journal remain safely mergeable on the next resume.
 *
 * @param paths - Bucket-scoped snapshot and journal paths.
 * @param startedAt - ISO timestamp for the current uploader session.
 * @param uploaded - Last successful record for every uploaded object key.
 * @returns Promise resolved after snapshot and journal replacements are durable.
 */
export async function compactUploadCheckpoint(
  paths: UploadCheckpointPaths,
  startedAt: string,
  uploaded: ReadonlyMap<string, CheckpointRecord>,
): Promise<void> {
  const checkpoint: LegacyCheckpoint = {
    schemaVersion: "1",
    startedAt,
    entries: [...uploaded.values()],
  };
  await writeTextFileAtomically(
    paths.snapshotPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
  await writeTextFileAtomically(paths.journalPath, "");
}

/**
 * Serialized append-only writer for successful-upload checkpoint records.
 *
 * Each append waits for the prior append. The handle is synced every
 * `syncEveryRecords` entries, bounding a machine-crash tail while avoiding one
 * fsync per property. Process crashes retain every completed write.
 */
export class CheckpointJournal {
  private handle: FileHandle | null = null;
  private tail: Promise<void> = Promise.resolve();
  private unsyncedRecords = 0;
  private closed = false;

  /**
   * Create a journal writer.
   *
   * @param journalPath - Bucket-scoped append-only NDJSON path.
   * @param syncEveryRecords - Maximum successful records between durable fsyncs.
   */
  constructor(
    private readonly journalPath: string,
    private readonly syncEveryRecords: number = 50,
  ) {
    if (!Number.isInteger(syncEveryRecords) || syncEveryRecords < 1) {
      throw new Error("syncEveryRecords must be a positive integer");
    }
  }

  /**
   * Append one successful upload after all prior appends finish.
   *
   * @param record - Stable key, Filebase CID, and upload timestamp to persist.
   * @returns Promise resolved only after this complete NDJSON line is written.
   */
  append(record: CheckpointRecord): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Cannot append to a closed checkpoint journal"));
    }

    const operation = this.tail.then(async () => {
      const handle = await this.getHandle();
      const journalRecord: JournalRecord = {
        schemaVersion: "2",
        type: "upload_succeeded",
        record,
      };
      await handle.appendFile(`${JSON.stringify(journalRecord)}\n`, "utf8");
      this.unsyncedRecords += 1;
      if (this.unsyncedRecords >= this.syncEveryRecords) {
        await handle.sync();
        this.unsyncedRecords = 0;
      }
    });
    this.tail = operation;
    return operation;
  }

  /**
   * Flush queued appends, fsync the bounded tail, and close the journal handle.
   *
   * @returns Promise resolved after all accepted records are durable.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.tail;
      return;
    }
    this.closed = true;

    let failure: unknown;
    try {
      await this.tail;
      if (this.handle !== null && this.unsyncedRecords > 0) {
        await this.handle.sync();
        this.unsyncedRecords = 0;
      }
    } catch (error: unknown) {
      failure = error;
    } finally {
      if (this.handle !== null) {
        await this.handle.close().catch((error: unknown) => {
          if (failure === undefined) failure = error;
        });
        this.handle = null;
      }
    }

    if (failure !== undefined) throw failure;
  }

  /**
   * Lazily open the journal in append mode.
   *
   * @returns Open file handle shared only by this serialized writer.
   */
  private async getHandle(): Promise<FileHandle> {
    if (this.handle === null) {
      this.handle = await open(this.journalPath, "a");
    }
    return this.handle;
  }
}

/**
 * Process items with a fixed number of looping workers.
 *
 * Unlike mapping every item to a semaphore waiter, this creates at most
 * `concurrency` worker promises. A first unexpected worker error stops new
 * scheduling while all active workers settle, then propagates the error.
 *
 * @param items - Ordered input collection to process.
 * @param concurrency - Maximum number of simultaneously active workers.
 * @param worker - Async operation for one item and its zero-based index.
 * @returns Promise resolved after every scheduled item finishes.
 */
export async function runBoundedWorkerPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  let nextIndex = 0;
  let firstFailure: unknown;
  const workerCount = Math.min(concurrency, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (firstFailure === undefined) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) return;

      try {
        await worker(item, index);
      } catch (error: unknown) {
        firstFailure = error;
      }
    }
  });

  await Promise.all(workers);
  if (firstFailure !== undefined) throw firstFailure;
}

/**
 * Create zero-based progress for the current run.
 *
 * Existing checkpoint size is deliberately not an input: resumed keys are
 * counted exactly once when the current upload plan encounters and skips them.
 *
 * @param total - Number of objects in the current upload plan.
 * @param startedAt - Session start in Unix milliseconds.
 * @param rollingWindowMs - Throughput window in milliseconds.
 * @returns Mutable progress state owned by one uploader session.
 */
export function createUploadProgress(
  total: number,
  startedAt: number = Date.now(),
  rollingWindowMs: number = 60_000,
): UploadProgressState {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("total must be a non-negative integer");
  }
  if (!Number.isFinite(rollingWindowMs) || rollingWindowMs <= 0) {
    throw new Error("rollingWindowMs must be positive");
  }
  return {
    total,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    startedAt,
    rollingWindowMs,
    recentUploadTimestamps: [],
    retriedUploads: 0,
    retryAttempts: 0,
    retryDelayMs: 0,
    throttledFailures: 0,
  };
}

/**
 * Calculate successful uploads per second within a rolling time window.
 *
 * During the first window, the denominator is elapsed session time (minimum one
 * second). After that it is the full window, so old session history cannot hide
 * a current slowdown.
 *
 * @param uploadTimestamps - Successful upload times in Unix milliseconds.
 * @param sessionStartedAt - Session start in Unix milliseconds.
 * @param now - Snapshot time in Unix milliseconds.
 * @param windowMs - Rolling window width in milliseconds.
 * @returns Successful uploads per second for the current window.
 */
export function calculateRollingRate(
  uploadTimestamps: readonly number[],
  sessionStartedAt: number,
  now: number,
  windowMs: number,
): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("windowMs must be positive");
  }
  const cutoff = now - windowMs;
  const count = uploadTimestamps.reduce(
    (total, timestamp) =>
      timestamp > cutoff && timestamp <= now ? total + 1 : total,
    0,
  );
  const observedMs = Math.min(
    windowMs,
    Math.max(1_000, now - sessionStartedAt),
  );
  return count / (observedMs / 1_000);
}

/**
 * Record one durable successful upload and its SDK retry metadata.
 *
 * @param state - Mutable session progress.
 * @param retry - Attempts, retry delay, and throttle classification.
 * @param uploadedAt - Success time in Unix milliseconds.
 * @returns Nothing.
 */
export function recordUploadSuccess(
  state: UploadProgressState,
  retry: UploadRetryInfo,
  uploadedAt: number = Date.now(),
): void {
  state.uploaded += 1;
  state.recentUploadTimestamps.push(uploadedAt);
  recordRetryMetadata(state, retry, false);
  pruneUploadTimestamps(state, uploadedAt);
}

/**
 * Record one failed upload and its SDK retry/throttle metadata.
 *
 * @param state - Mutable session progress.
 * @param retry - Attempts, retry delay, and throttle classification.
 * @returns Nothing.
 */
export function recordUploadFailure(
  state: UploadProgressState,
  retry: UploadRetryInfo,
): void {
  state.failed += 1;
  recordRetryMetadata(state, retry, true);
}

/**
 * Record one current-plan object skipped because its checkpoint is reusable.
 *
 * @param state - Mutable session progress.
 * @returns Nothing.
 */
export function recordUploadSkipped(state: UploadProgressState): void {
  state.skipped += 1;
}

/**
 * Build an immutable progress snapshot with rolling throughput and retry totals.
 *
 * @param state - Mutable session progress.
 * @param now - Snapshot time in Unix milliseconds.
 * @returns Current totals and rolling operational signals.
 */
export function snapshotUploadProgress(
  state: UploadProgressState,
  now: number = Date.now(),
): UploadProgressSnapshot {
  return {
    total: state.total,
    uploaded: state.uploaded,
    failed: state.failed,
    skipped: state.skipped,
    done: state.uploaded + state.failed + state.skipped,
    rollingWindowSec: state.rollingWindowMs / 1_000,
    rollingRatePerSec: calculateRollingRate(
      state.recentUploadTimestamps,
      state.startedAt,
      now,
      state.rollingWindowMs,
    ),
    retriedUploads: state.retriedUploads,
    retryAttempts: state.retryAttempts,
    retryDelayMs: state.retryDelayMs,
    throttledFailures: state.throttledFailures,
  };
}

/**
 * Fold AWS SDK retry metadata into aggregate session counters.
 *
 * @param state - Mutable session progress.
 * @param retry - Metadata for one completed operation.
 * @param failed - Whether the operation exhausted retries and failed.
 * @returns Nothing.
 */
function recordRetryMetadata(
  state: UploadProgressState,
  retry: UploadRetryInfo,
  failed: boolean,
): void {
  const retryCount = Math.max(0, retry.attempts - 1);
  if (retryCount > 0) {
    state.retriedUploads += 1;
    state.retryAttempts += retryCount;
  }
  state.retryDelayMs += Math.max(0, retry.retryDelayMs);
  if (failed && retry.throttled) {
    state.throttledFailures += 1;
  }
}

/**
 * Keep only timestamps that can affect the next rolling-rate snapshot.
 *
 * @param state - Mutable session progress.
 * @param now - Latest successful upload time in Unix milliseconds.
 * @returns Nothing.
 */
function pruneUploadTimestamps(
  state: UploadProgressState,
  now: number,
): void {
  const cutoff = now - state.rollingWindowMs;
  let firstIncluded = 0;
  while (
    firstIncluded < state.recentUploadTimestamps.length &&
    (state.recentUploadTimestamps[firstIncluded] ?? Number.POSITIVE_INFINITY) <= cutoff
  ) {
    firstIncluded += 1;
  }
  if (firstIncluded > 0) {
    state.recentUploadTimestamps.splice(0, firstIncluded);
  }
}
