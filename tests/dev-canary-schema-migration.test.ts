import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEV_CANARY_MIGRATION_TAGS,
  PINNED_DEV_CANARY_MIGRATIONS,
  loadDevCanaryMigrationDescriptors,
} from "../src/migrations/dev-canary-schema.js";
import { parseDevCanaryMigrationArgs } from "../scripts/run-dev-canary-schema-migration.js";

describe("DEV canary schema migration contract", () => {
  it("keeps migrations 0009-0012 ordered and pinned to reviewed hashes", async () => {
    const descriptors = await loadDevCanaryMigrationDescriptors();

    expect(descriptors.map(({ tag }) => tag)).toEqual(
      DEV_CANARY_MIGRATION_TAGS,
    );
    expect(
      descriptors.map(({ tag, createdAt, hash }) => ({
        tag,
        createdAt,
        hash,
      })),
    ).toEqual(
      PINNED_DEV_CANARY_MIGRATIONS.map(({ tag, createdAt, hash }) => ({
        tag,
        createdAt,
        hash,
      })),
    );
    for (const descriptor of descriptors) {
      expect(descriptor.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(descriptor.sql.length).toBeGreaterThan(0);
    }
  });

  it("keeps the snapshot lineage continuous across 0009-0012", async () => {
    const snapshots = await Promise.all(
      ["0009", "0010", "0011", "0012"].map(
        async (tag) =>
          JSON.parse(
            await readFile(`migrations/meta/${tag}_snapshot.json`, "utf8"),
          ) as { readonly id: string; readonly prevId: string },
      ),
    );

    expect(snapshots[1]?.prevId).toBe(snapshots[0]?.id);
    expect(snapshots[2]?.prevId).toBe(snapshots[1]?.id);
    expect(snapshots[3]?.prevId).toBe(snapshots[2]?.id);
  });

  it("keeps 0009 additive to existing geometry rows", async () => {
    const sql = await readFile(
      "migrations/0009_rock_island_geometry_illinois_sos.sql",
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE "geometry_rings"');
    expect(sql).toContain('CREATE TABLE "illinois_sos_component_records"');
    expect(sql).toContain(
      'REFERENCES "public"."geometries"("geometry_id") ON DELETE cascade',
    );
    expect(sql).not.toContain('ALTER TABLE "geometries"');
    expect(sql).not.toMatch(/^\s*(?:DELETE|DROP|TRUNCATE|UPDATE)\b/imu);
  });

  it("keeps 0010-0011 nullable and pair-governed", async () => {
    const migration0010 = await readFile(
      "migrations/0010_address_identity.sql",
      "utf8",
    );
    const migration0011 = await readFile(
      "migrations/0011_identity_pair_constraint.sql",
      "utf8",
    );

    expect(migration0010).toContain(
      'ALTER TABLE "addresses" ADD COLUMN "elephant_uuid" uuid',
    );
    expect(migration0010).toContain(
      'ALTER TABLE "addresses" ADD COLUMN "elephant_token" text',
    );
    expect(migration0010).not.toContain("NOT NULL");
    expect(migration0010).not.toMatch(
      /^\s*(?:DELETE|DROP|TRUNCATE|UPDATE)\b/imu,
    );
    expect(migration0011).toContain(
      '("addresses"."elephant_uuid" IS NULL) = ("addresses"."elephant_token" IS NULL)',
    );
  });

  it("keeps 0012 additive with the reviewed table, FK, and index counts", async () => {
    const migration0012 = await readFile(
      "migrations/0012_private_bbb_persistence.sql",
      "utf8",
    );
    expect(migration0012.match(/^CREATE TABLE\b/gmu)).toHaveLength(8);
    expect(
      migration0012.match(/^ALTER TABLE .* FOREIGN KEY\b/gmu),
    ).toHaveLength(13);
    expect(migration0012.match(/^CREATE (?:UNIQUE )?INDEX\b/gmu)).toHaveLength(
      30,
    );
    expect(migration0012).not.toMatch(
      /^\s*(?:DELETE|DROP|TRUNCATE|UPDATE)\b/imu,
    );
  });

  it("rejects changed, missing, unknown, and newer migration contracts", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "query-db-migration-contract-"),
    );
    try {
      await cp("migrations", directory, { recursive: true });
      await writeFile(
        path.join(directory, "0012_private_bbb_persistence.sql"),
        "-- changed\n",
      );
      await expect(
        loadDevCanaryMigrationDescriptors(directory),
      ).rejects.toThrow(/Pinned migration hash mismatch/u);

      await cp(
        "migrations/0012_private_bbb_persistence.sql",
        path.join(directory, "0012_private_bbb_persistence.sql"),
      );
      const journalPath = path.join(directory, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Record<string, unknown>[];
      };
      journal.entries.push({
        idx: 11,
        version: "7",
        when: 1792617628788,
        tag: "0013_unknown",
        breakpoints: true,
      });
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await expect(
        loadDevCanaryMigrationDescriptors(directory),
      ).rejects.toThrow(/missing, unknown, or newer/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit apply safety evidence", () => {
    expect(
      parseDevCanaryMigrationArgs(["--plan", "--environment", "DEV"]),
    ).toMatchObject({ mode: "plan", environment: "DEV" });
    expect(
      parseDevCanaryMigrationArgs([
        "--apply",
        "--environment",
        "DEV",
        "--expected-endpoint-fingerprint",
        "0123456789abcdef",
        "--approval-ref",
        "review-44",
        "--approval-ref",
        "review-45",
        "--backup-ref",
        "backup-123",
        "--backup-created-at",
        "2026-10-22T12:00:00.000Z",
        "--writer-pause-proof",
        "/private/writer-pause-proof.json",
      ]),
    ).toEqual({
      mode: "apply",
      environment: "DEV",
      expectedEndpointFingerprint: "0123456789abcdef",
      approvalRefs: ["review-44", "review-45"],
      backupRef: "backup-123",
      backupCreatedAt: "2026-10-22T12:00:00.000Z",
      writerPauseProofPath: "/private/writer-pause-proof.json",
    });
    expect(
      parseDevCanaryMigrationArgs([
        "--verify",
        "--environment",
        "DEV",
        "--expected-endpoint-fingerprint",
        "0123456789abcdef",
      ]),
    ).toMatchObject({ mode: "verify", environment: "DEV" });
    expect(() => parseDevCanaryMigrationArgs(["--environment", "DEV"])).toThrow(
      /--plan, --apply, or --verify/u,
    );
    expect(() =>
      parseDevCanaryMigrationArgs([
        "--apply",
        "--environment",
        "DEV",
        "--writers-paused",
      ]),
    ).toThrow(/Unknown argument/u);
  });
});
