import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointJournal,
  calculateRollingRate,
  compactUploadCheckpoint,
  createUploadProgress,
  readUploadCheckpoint,
  recordUploadFailure,
  recordUploadSkipped,
  recordUploadSuccess,
  runBoundedWorkerPool,
  snapshotUploadProgress,
  uploadCheckpointPathsForBucket,
  type CheckpointRecord,
} from "../scripts/filebase-upload-state.js";

const temporaryDirectories: string[] = [];

/**
 * Create one isolated uploader-state directory and register it for cleanup.
 *
 * @returns Absolute temporary directory path.
 */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "filebase-upload-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Build a deterministic successful-upload record for checkpoint tests.
 *
 * @param key - Stable Filebase object key.
 * @param cid - CID stored for that key.
 * @returns Complete checkpoint record.
 */
function record(key: string, cid: string): CheckpointRecord {
  return {
    key,
    cid,
    uploadedAt: "2026-09-08T12:00:00.000Z",
  };
}

/**
 * Encode one schemaVersion 2 successful-upload journal line.
 *
 * @param checkpointRecord - Record to place in the NDJSON envelope.
 * @returns Complete newline-terminated journal line.
 */
function journalLine(checkpointRecord: CheckpointRecord): string {
  return `${JSON.stringify({
    schemaVersion: "2",
    type: "upload_succeeded",
    record: checkpointRecord,
  })}\n`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Filebase checkpoint recovery", () => {
  it("merges legacy schemaVersion 1 JSON with newer journal records", async () => {
    const directory = await createTemporaryDirectory();
    const paths = uploadCheckpointPathsForBucket("county-bucket", directory);
    await writeFile(
      paths.snapshotPath,
      JSON.stringify({
        schemaVersion: "1",
        startedAt: "2026-09-08T11:00:00.000Z",
        entries: [
          record("properties/a.json", "bafy-old-a"),
          record("properties/legacy-only.json", "bafy-legacy"),
        ],
      }),
      "utf8",
    );

    const journal = new CheckpointJournal(paths.journalPath, 1);
    await Promise.all([
      journal.append(record("properties/a.json", "bafy-new-a")),
      journal.append(record("properties/journal-only.json", "bafy-journal")),
    ]);
    await journal.close();

    const recovery = await readUploadCheckpoint(paths);
    expect(recovery.legacyEntryCount).toBe(2);
    expect(recovery.journalEntryCount).toBe(2);
    expect(recovery.uploaded.size).toBe(3);
    expect(recovery.uploaded.get("properties/a.json")?.cid).toBe("bafy-new-a");
    expect(recovery.uploaded.get("properties/legacy-only.json")?.cid).toBe("bafy-legacy");
    expect(recovery.uploaded.get("properties/journal-only.json")?.cid).toBe("bafy-journal");
  });

  it("recovers a journal without a legacy snapshot", async () => {
    const directory = await createTemporaryDirectory();
    const paths = uploadCheckpointPathsForBucket("county-bucket", directory);
    const journal = new CheckpointJournal(paths.journalPath, 1);
    await journal.append(record("properties/a.json", "bafy-a"));
    await journal.close();

    const recovery = await readUploadCheckpoint(paths);
    expect(recovery.legacyEntryCount).toBe(0);
    expect(recovery.journalEntryCount).toBe(1);
    expect(recovery.uploaded.get("properties/a.json")?.cid).toBe("bafy-a");
  });

  it("ignores only one incomplete final journal line after a crash", async () => {
    const directory = await createTemporaryDirectory();
    const paths = uploadCheckpointPathsForBucket("county-bucket", directory);
    await writeFile(
      paths.journalPath,
      `${journalLine(record("properties/a.json", "bafy-a"))}{"schemaVersion":"2","type":`,
      "utf8",
    );

    const recovery = await readUploadCheckpoint(paths);
    expect(recovery.partialJournalTailIgnored).toBe(true);
    expect(recovery.journalEntryCount).toBe(1);
    expect(recovery.uploaded.get("properties/a.json")?.cid).toBe("bafy-a");
  });

  it("fails closed for a malformed complete journal record", async () => {
    const directory = await createTemporaryDirectory();
    const paths = uploadCheckpointPathsForBucket("county-bucket", directory);
    await writeFile(
      paths.journalPath,
      `${journalLine(record("properties/a.json", "bafy-a"))}not-json\n`,
      "utf8",
    );

    await expect(readUploadCheckpoint(paths)).rejects.toThrow(/journal/u);
  });

  it("atomically compacts to valid JSON and rotates the journal", async () => {
    const directory = await createTemporaryDirectory();
    const paths = uploadCheckpointPathsForBucket("county-bucket", directory);
    await writeFile(
      paths.snapshotPath,
      JSON.stringify({
        schemaVersion: "1",
        startedAt: "2026-09-08T10:00:00.000Z",
        entries: [record("properties/old.json", "bafy-old")],
      }),
      "utf8",
    );
    await writeFile(
      paths.journalPath,
      journalLine(record("properties/journal.json", "bafy-journal")),
      "utf8",
    );

    const uploaded = new Map<string, CheckpointRecord>([
      ["properties/a.json", record("properties/a.json", "bafy-a")],
      ["properties/b.json", record("properties/b.json", "bafy-b")],
    ]);
    await compactUploadCheckpoint(
      paths,
      "2026-09-08T12:00:00.000Z",
      uploaded,
    );

    const compacted = JSON.parse(await readFile(paths.snapshotPath, "utf8")) as {
      readonly schemaVersion: string;
      readonly entries: readonly CheckpointRecord[];
    };
    expect(compacted.schemaVersion).toBe("1");
    expect(compacted.entries.map((entry) => entry.key)).toEqual([
      "properties/a.json",
      "properties/b.json",
    ]);
    expect(await readFile(paths.journalPath, "utf8")).toBe("");
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("bounded worker scheduling", () => {
  it("keeps active and pending operations bounded by concurrency", async () => {
    const items = Array.from({ length: 80 }, (_, index) => index);
    let active = 0;
    let maximumActive = 0;
    let completed = 0;

    await runBoundedWorkerPool(items, 4, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
      active -= 1;
      completed += 1;
    });

    expect(completed).toBe(items.length);
    expect(maximumActive).toBe(4);
  });
});

describe("resumed progress and rolling throughput", () => {
  it("counts resumed skips exactly once instead of seeding from checkpoint size", () => {
    const progress = createUploadProgress(5, 0, 60_000);
    recordUploadSkipped(progress);
    recordUploadSkipped(progress);
    recordUploadSuccess(
      progress,
      { attempts: 1, retryDelayMs: 0, throttled: false },
      1_000,
    );

    const snapshot = snapshotUploadProgress(progress, 2_000);
    expect(snapshot.skipped).toBe(2);
    expect(snapshot.uploaded).toBe(1);
    expect(snapshot.done).toBe(3);
    expect(snapshot.total).toBe(5);
  });

  it("calculates rate from only the rolling window", () => {
    expect(
      calculateRollingRate([1_000, 50_000, 55_000, 59_000], 0, 60_000, 10_000),
    ).toBeCloseTo(0.2);
    expect(
      calculateRollingRate([1_000, 50_000, 55_000, 59_000], 0, 70_000, 10_000),
    ).toBe(0);
  });

  it("reports SDK retries, delay, and exhausted throttle failures", () => {
    const progress = createUploadProgress(2, 0, 60_000);
    recordUploadSuccess(
      progress,
      { attempts: 3, retryDelayMs: 250, throttled: false },
      1_000,
    );
    recordUploadFailure(progress, {
      attempts: 4,
      retryDelayMs: 750,
      throttled: true,
    });

    const snapshot = snapshotUploadProgress(progress, 2_000);
    expect(snapshot.retriedUploads).toBe(2);
    expect(snapshot.retryAttempts).toBe(5);
    expect(snapshot.retryDelayMs).toBe(1_000);
    expect(snapshot.throttledFailures).toBe(1);
  });
});
