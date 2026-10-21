import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DEV_CANARY_MIGRATION_TAGS,
  loadDevCanaryMigrationDescriptors,
} from "../src/migrations/dev-canary-schema.js";
import { parseDevCanaryMigrationArgs } from "../scripts/run-dev-canary-schema-migration.js";

describe("DEV canary schema migration contract", () => {
  it("keeps migrations 0009-0011 ordered and hashable from the journal", async () => {
    const descriptors = await loadDevCanaryMigrationDescriptors();

    expect(descriptors.map(({ tag }) => tag)).toEqual(
      DEV_CANARY_MIGRATION_TAGS,
    );
    expect(descriptors.map(({ createdAt }) => createdAt)).toEqual(
      [...descriptors]
        .map(({ createdAt }) => createdAt)
        .sort((left, right) => left - right),
    );
    for (const descriptor of descriptors) {
      expect(descriptor.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(descriptor.sql.length).toBeGreaterThan(0);
    }
  });

  it("keeps the snapshot lineage continuous across 0009-0011", async () => {
    const snapshots = await Promise.all(
      ["0009", "0010", "0011"].map(
        async (tag) =>
          JSON.parse(
            await readFile(`migrations/meta/${tag}_snapshot.json`, "utf8"),
          ) as { readonly id: string; readonly prevId: string },
      ),
    );

    expect(snapshots[1]?.prevId).toBe(snapshots[0]?.id);
    expect(snapshots[2]?.prevId).toBe(snapshots[1]?.id);
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

  it("requires explicit apply safety acknowledgements", () => {
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
        "review-123",
        "--backup-ref",
        "backup-123",
        "--writers-paused",
      ]),
    ).toEqual({
      mode: "apply",
      environment: "DEV",
      expectedEndpointFingerprint: "0123456789abcdef",
      approvalRef: "review-123",
      backupRef: "backup-123",
      writersPaused: true,
    });
    expect(() => parseDevCanaryMigrationArgs(["--environment", "DEV"])).toThrow(
      /--plan or --apply/u,
    );
  });
});
