import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildKeyPrefix,
  buildS3Keys,
  computeFileSha256,
  parseOptions,
  readMigrationVersion,
} from "../scripts/run-snapshot-export.js";

describe("parseOptions", () => {
  it("uses default values when no flags are passed", () => {
    const options = parseOptions([]);

    expect(options.county).toBe("lee");
    expect(options.bucket).toBe("elephant-oracle-node-environmentbucket-mmsoo3xbdi80");
    expect(options.envFile).toBe(".env.local");
    expect(options.keyPrefix).toBeNull();
    expect(options.outDir).toBe(".snapshot-export");
  });

  it("parses --county flag", () => {
    const options = parseOptions(["--county", "miami-dade"]);
    expect(options.county).toBe("miami-dade");
  });

  it("parses --bucket flag", () => {
    const options = parseOptions(["--bucket", "my-custom-bucket"]);
    expect(options.bucket).toBe("my-custom-bucket");
  });

  it("parses --key-prefix flag", () => {
    const options = parseOptions(["--key-prefix", "custom/prefix/"]);
    expect(options.keyPrefix).toBe("custom/prefix/");
  });

  it("parses --env-file flag", () => {
    const options = parseOptions(["--env-file", "/etc/myapp/.env"]);
    expect(options.envFile).toBe("/etc/myapp/.env");
  });

  it("parses --out-dir flag", () => {
    const options = parseOptions(["--out-dir", "/tmp/snapshots"]);
    expect(options.outDir).toBe("/tmp/snapshots");
  });

  it("parses multiple flags together", () => {
    const options = parseOptions([
      "--county", "broward",
      "--bucket", "other-bucket",
      "--out-dir", "/tmp/out",
    ]);
    expect(options.county).toBe("broward");
    expect(options.bucket).toBe("other-bucket");
    expect(options.outDir).toBe("/tmp/out");
    expect(options.keyPrefix).toBeNull();
  });
});

describe("buildKeyPrefix", () => {
  it("produces snapshots/<county>/<timestamp>/ shape", () => {
    const prefix = buildKeyPrefix("lee", "2026-06-18T12:00:00.000Z");
    expect(prefix).toMatch(/^snapshots\/lee\/\d{8}T\d{6}Z\/$/);
  });

  it("includes the county in the prefix", () => {
    const prefix = buildKeyPrefix("broward", "2026-06-18T12:00:00.000Z");
    expect(prefix).toContain("broward");
    expect(prefix.startsWith("snapshots/broward/")).toBe(true);
  });

  it("is idempotent for the same inputs", () => {
    const snapshotAt = "2026-06-18T12:00:00.000Z";
    const first = buildKeyPrefix("lee", snapshotAt);
    const second = buildKeyPrefix("lee", snapshotAt);
    expect(first).toBe(second);
  });

  it("ends with a trailing slash", () => {
    const prefix = buildKeyPrefix("lee", "2026-06-18T12:00:00.000Z");
    expect(prefix.endsWith("/")).toBe(true);
  });
});

describe("buildS3Keys", () => {
  it("builds dump key with correct pattern", () => {
    const { dumpKey } = buildS3Keys("snapshots/lee/20260618T120000Z/", "lee", "20260618T120000Z");
    expect(dumpKey).toBe("snapshots/lee/20260618T120000Z/snapshot-lee-20260618T120000Z.sql.gz");
  });

  it("builds manifest key under the prefix", () => {
    const { manifestKey } = buildS3Keys("snapshots/lee/20260618T120000Z/", "lee", "20260618T120000Z");
    expect(manifestKey).toBe("snapshots/lee/20260618T120000Z/manifest.json");
  });

  it("uses a custom prefix", () => {
    const { dumpKey, manifestKey } = buildS3Keys("custom/path/", "broward", "20260101T000000Z");
    expect(dumpKey).toBe("custom/path/snapshot-broward-20260101T000000Z.sql.gz");
    expect(manifestKey).toBe("custom/path/manifest.json");
  });

  it("keys derived from buildKeyPrefix + buildS3Keys match expected structure", () => {
    const snapshotAt = "2026-06-18T12:00:00.000Z";
    const county = "lee";
    const prefix = buildKeyPrefix(county, snapshotAt);
    // Extract timestamp from prefix: snapshots/lee/<timestamp>/
    const timestamp = prefix.split("/")[2];
    expect(timestamp).toBeDefined();
    const { dumpKey, manifestKey } = buildS3Keys(prefix, county, timestamp!);
    expect(dumpKey).toContain(county);
    expect(dumpKey.endsWith(".sql.gz")).toBe(true);
    expect(manifestKey.endsWith("manifest.json")).toBe(true);
    expect(dumpKey.startsWith(prefix)).toBe(true);
    expect(manifestKey.startsWith(prefix)).toBe(true);
  });
});

describe("readMigrationVersion", () => {
  it("returns the tag of the last entry", async () => {
    const journalPath = join(tmpdir(), `test-journal-${Date.now()}.json`);
    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1000, tag: "0000_first_migration", breakpoints: true },
        { idx: 1, version: "7", when: 2000, tag: "0001_second_migration", breakpoints: true },
        { idx: 2, version: "7", when: 3000, tag: "0002_third_migration", breakpoints: true },
      ],
    };
    await writeFile(journalPath, JSON.stringify(journal));

    try {
      const version = await readMigrationVersion(journalPath);
      expect(version).toBe("0002_third_migration");
    } finally {
      await rm(journalPath, { force: true });
    }
  });

  it("returns the single entry tag when only one entry exists", async () => {
    const journalPath = join(tmpdir(), `test-journal-single-${Date.now()}.json`);
    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1000, tag: "0000_only_migration", breakpoints: true },
      ],
    };
    await writeFile(journalPath, JSON.stringify(journal));

    try {
      const version = await readMigrationVersion(journalPath);
      expect(version).toBe("0000_only_migration");
    } finally {
      await rm(journalPath, { force: true });
    }
  });

  it("throws on an empty entries array", async () => {
    const journalPath = join(tmpdir(), `test-journal-empty-${Date.now()}.json`);
    await writeFile(journalPath, JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }));

    try {
      await expect(readMigrationVersion(journalPath)).rejects.toThrow("no entries");
    } finally {
      await rm(journalPath, { force: true });
    }
  });

  it("throws on a malformed journal missing entries", async () => {
    const journalPath = join(tmpdir(), `test-journal-bad-${Date.now()}.json`);
    await writeFile(journalPath, JSON.stringify({ version: "7" }));

    try {
      await expect(readMigrationVersion(journalPath)).rejects.toThrow(/missing entries/);
    } finally {
      await rm(journalPath, { force: true });
    }
  });
});

describe("computeFileSha256", () => {
  it("returns the correct sha256 hex digest of a known-content file", async () => {
    const filePath = join(tmpdir(), `test-sha256-${Date.now()}.txt`);
    const content = "elephant snapshot export test content";
    await writeFile(filePath, content);

    const expected = createHash("sha256").update(content).digest("hex");

    try {
      const actual = await computeFileSha256(filePath);
      expect(actual).toBe(expected);
      expect(actual).toHaveLength(64);
      expect(actual).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it("returns a different digest for different content", async () => {
    const file1 = join(tmpdir(), `test-sha256-a-${Date.now()}.txt`);
    const file2 = join(tmpdir(), `test-sha256-b-${Date.now()}.txt`);
    await writeFile(file1, "content A");
    await writeFile(file2, "content B");

    try {
      const hash1 = await computeFileSha256(file1);
      const hash2 = await computeFileSha256(file2);
      expect(hash1).not.toBe(hash2);
    } finally {
      await rm(file1, { force: true });
      await rm(file2, { force: true });
    }
  });

  it("returns the same digest for the same content", async () => {
    const file1 = join(tmpdir(), `test-sha256-c-${Date.now()}.txt`);
    const file2 = join(tmpdir(), `test-sha256-d-${Date.now()}.txt`);
    const sameContent = "identical content for both files";
    await writeFile(file1, sameContent);
    await writeFile(file2, sameContent);

    try {
      const hash1 = await computeFileSha256(file1);
      const hash2 = await computeFileSha256(file2);
      expect(hash1).toBe(hash2);
    } finally {
      await rm(file1, { force: true });
      await rm(file2, { force: true });
    }
  });
});
