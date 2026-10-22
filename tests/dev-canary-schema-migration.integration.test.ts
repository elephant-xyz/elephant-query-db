import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BBB_PRIVATE_FOREIGN_KEYS,
  BBB_PRIVATE_INDEXES,
  BBB_PRIVATE_TABLES,
  runDevCanarySchemaMigration,
} from "../src/migrations/dev-canary-schema.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("DEV canary schema migration integration", () => {
  const client = new Client({ connectionString: testDatabaseUrl });
  let proofDirectory: string;

  beforeAll(async () => {
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    proofDirectory = await mkdtemp(
      path.join(tmpdir(), "query-db-writer-pause-"),
    );
    await client.query(`
      CREATE TABLE public.addresses (
        address_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_system text NOT NULL,
        source_record_key text NOT NULL,
        marker text NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE public.geometries (
        geometry_id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      )
    `);
    await client.query(`
      CREATE TABLE public.companies (
        company_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        request_identifier text,
        name text,
        source_system text NOT NULL,
        source_record_key text NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE public.properties (
        property_id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      )
    `);
    await client.query(`
      CREATE TABLE public.property_improvements (
        property_improvement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id uuid REFERENCES public.properties(property_id),
        contractor_company_id uuid REFERENCES public.companies(company_id),
        source_system text NOT NULL,
        source_record_key text NOT NULL
      )
    `);
    await client.query(`
      INSERT INTO public.addresses (source_system, source_record_key, marker)
      VALUES ('fixture', 'fixture:address:1', 'preserve-me')
    `);
  });

  afterAll(async () => {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.end();
    await rm(proofDirectory, { recursive: true, force: true });
  });

  it("plans read-only, applies without row loss, and reruns idempotently", async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    const plan = await runDevCanarySchemaMigration(testDatabaseUrl, {
      mode: "plan",
      environment: "DEV",
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.pendingActions).toContain("apply migration 0009 target tables");
    expect(plan.pendingActions).toContain(
      "apply migration 0012 private BBB tables",
    );
    expect(plan.risk.migration0012).toMatchObject({
      targetTablesPresent: 0,
      expectedTables: 8,
      expectedForeignKeys: 13,
      expectedIndexes: 30,
    });

    const beforeApply = await client.query<{
      readonly identity_columns: number;
      readonly geometry_rings: string | null;
      readonly bbb_harvest_runs: string | null;
      readonly ledger: string | null;
    }>(`
      SELECT
        (
          SELECT count(*)::int
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'addresses'
            AND column_name IN ('elephant_uuid', 'elephant_token')
        ) AS identity_columns,
        to_regclass('public.geometry_rings')::text AS geometry_rings,
        to_regclass('public.bbb_harvest_runs')::text AS bbb_harvest_runs,
        to_regclass('drizzle.__drizzle_migrations')::text AS ledger
    `);
    expect(beforeApply.rows[0]).toEqual({
      identity_columns: 0,
      geometry_rings: null,
      bbb_harvest_runs: null,
      ledger: null,
    });

    const proofPath = path.join(proofDirectory, "writer-pause-proof.json");
    await writeWriterPauseProof(
      proofPath,
      plan.environment.endpointFingerprint,
    );
    const backupCreatedAt = new Date().toISOString();
    const applyOptions = {
      mode: "apply" as const,
      environment: "DEV",
      expectedEndpointFingerprint: plan.environment.endpointFingerprint,
      approvalRefs: ["local-disposable-test"],
      backupRef: "local-disposable-snapshot",
      backupCreatedAt,
      writerPauseProofPath: proofPath,
    };

    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, {
        ...applyOptions,
        environment: "PROD",
      }),
    ).rejects.toThrow(/exactly DEV/u);
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, {
        ...applyOptions,
        expectedEndpointFingerprint: "0000000000000000",
      }),
    ).rejects.toThrow(/endpoint-fingerprint/u);
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, {
        ...applyOptions,
        approvalRefs: [],
      }),
    ).rejects.toThrow(/approval-ref/u);
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, {
        ...applyOptions,
        backupRef: "",
      }),
    ).rejects.toThrow(/backup-ref/u);
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, {
        ...applyOptions,
        backupCreatedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/stale/u);
    const {
      writerPauseProofPath: _writerPauseProofPath,
      ...withoutWriterPauseProof
    } = applyOptions;
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, withoutWriterPauseProof),
    ).rejects.toThrow(/writer-pause-proof/u);
    const wrongProofPath = path.join(
      proofDirectory,
      "wrong-writer-pause-proof.json",
    );
    await writeWriterPauseProof(wrongProofPath, "0000000000000000");
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, {
        ...applyOptions,
        writerPauseProofPath: wrongProofPath,
      }),
    ).rejects.toThrow(/pause proof.*fingerprint/u);

    const applied = await runDevCanarySchemaMigration(
      testDatabaseUrl,
      applyOptions,
    );
    expect(applied.blockers).toEqual([]);
    expect(applied.pendingActions).toEqual([]);
    expect(applied.targetMigrations.every(({ recorded }) => recorded)).toBe(
      true,
    );
    expect(applied.targetMigrations).toHaveLength(4);
    expect(applied.risk.migration0012).toMatchObject({
      targetTablesPresent: 8,
      expectedTables: 8,
      expectedForeignKeys: 13,
      expectedIndexes: 30,
    });
    expect(applied.authorizationEvidence).toMatchObject({
      approvalRefCount: 1,
      backupCreatedAt,
      writerCount: 1,
    });
    expect(applied.authorizationEvidence?.writerPauseProofSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    const bbbTables = await client.query<{ readonly table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[...BBB_PRIVATE_TABLES]],
    );
    expect(bbbTables.rows.map((row) => row.table_name)).toEqual(
      [...BBB_PRIVATE_TABLES].sort(),
    );
    const bbbForeignKeys = await client.query<{ readonly conname: string }>(
      `SELECT constraint_row.conname
       FROM pg_constraint constraint_row
       JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       WHERE namespace_row.nspname = 'public'
         AND constraint_row.contype = 'f'
         AND constraint_row.conname = ANY($1::text[])
         AND constraint_row.convalidated
       ORDER BY constraint_row.conname`,
      [[...BBB_PRIVATE_FOREIGN_KEYS]],
    );
    expect(bbbForeignKeys.rows.map((row) => row.conname)).toEqual(
      [...BBB_PRIVATE_FOREIGN_KEYS].sort(),
    );
    const bbbIndexes = await client.query<{ readonly indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[...BBB_PRIVATE_INDEXES]],
    );
    expect(bbbIndexes.rows.map((row) => row.indexname)).toEqual(
      [...BBB_PRIVATE_INDEXES].sort(),
    );

    const preserved = await client.query<{
      readonly marker: string;
      readonly elephant_uuid: string | null;
      readonly elephant_token: string | null;
    }>(`
      SELECT marker, elephant_uuid::text, elephant_token
      FROM public.addresses
      WHERE source_record_key = 'fixture:address:1'
    `);
    expect(preserved.rows).toEqual([
      {
        marker: "preserve-me",
        elephant_uuid: null,
        elephant_token: null,
      },
    ]);

    const constraint = await client.query<{
      readonly convalidated: boolean;
    }>(`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'public.addresses'::regclass
        AND conname = 'addresses_elephant_identity_pair_check'
    `);
    expect(constraint.rows).toEqual([{ convalidated: true }]);

    await client.query(`
      INSERT INTO public.addresses (
        source_system,
        source_record_key,
        marker,
        elephant_uuid,
        elephant_token
      )
      VALUES (
        'fixture',
        'fixture:address:2',
        'valid-pair',
        'c3a982a7-1102-50b8-b2cd-6cb3fca2060f',
        'token'
      )
    `);
    await expect(
      client.query(`
        INSERT INTO public.addresses (
          source_system,
          source_record_key,
          marker,
          elephant_uuid
        )
        VALUES (
          'fixture',
          'fixture:address:3',
          'invalid-pair',
          'c3a982a7-1102-50b8-b2cd-6cb3fca2060f'
        )
      `),
    ).rejects.toThrow(/addresses_elephant_identity_pair_check/u);

    const ledgerBeforeReplay = await client.query<{ readonly count: number }>(`
      SELECT count(*)::int AS count
      FROM drizzle.__drizzle_migrations
    `);
    expect(ledgerBeforeReplay.rows[0]?.count).toBe(4);

    const replay = await runDevCanarySchemaMigration(
      testDatabaseUrl,
      applyOptions,
    );
    expect(replay.pendingActions).toEqual([]);
    const ledgerAfterReplay = await client.query<{ readonly count: number }>(`
      SELECT count(*)::int AS count
      FROM drizzle.__drizzle_migrations
    `);
    expect(ledgerAfterReplay.rows[0]?.count).toBe(4);

    const verified = await runDevCanarySchemaMigration(testDatabaseUrl, {
      mode: "verify",
      environment: "DEV",
      expectedEndpointFingerprint: plan.environment.endpointFingerprint,
    });
    expect(verified.pendingActions).toEqual([]);

    const migration0011 = applied.targetMigrations.find(({ tag }) =>
      tag.startsWith("0011_"),
    );
    const migration0012 = applied.targetMigrations.find(({ tag }) =>
      tag.startsWith("0012_"),
    );
    if (migration0011 === undefined || migration0012 === undefined) {
      throw new Error("Expected migration descriptors are missing");
    }

    await client.query(
      `UPDATE drizzle.__drizzle_migrations
       SET hash = $1
       WHERE created_at = $2`,
      ["0".repeat(64), migration0012.createdAt],
    );
    const wrongHashPlan = await runDevCanarySchemaMigration(testDatabaseUrl, {
      mode: "plan",
      environment: "DEV",
    });
    expect(wrongHashPlan.blockers).toContain(
      "Drizzle ledger hash mismatch for 0012_private_bbb_persistence",
    );
    await expect(
      runDevCanarySchemaMigration(testDatabaseUrl, applyOptions),
    ).rejects.toThrow(/ledger hash mismatch/u);
    await client.query(
      `UPDATE drizzle.__drizzle_migrations
       SET hash = $1
       WHERE created_at = $2`,
      [migration0012.hash, migration0012.createdAt],
    );

    await client.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [migration0011.createdAt],
    );
    const missingLedgerPlan = await runDevCanarySchemaMigration(
      testDatabaseUrl,
      { mode: "plan", environment: "DEV" },
    );
    expect(missingLedgerPlan.blockers).toContain(
      "Drizzle ledger is missing a predecessor in the recorded 0009-0012 sequence",
    );
    await client.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ($1, $2)`,
      [migration0011.hash, migration0011.createdAt],
    );

    await client.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ($1, $2)`,
      ["f".repeat(64), migration0012.createdAt + 1],
    );
    const newerLedgerPlan = await runDevCanarySchemaMigration(testDatabaseUrl, {
      mode: "plan",
      environment: "DEV",
    });
    expect(
      newerLedgerPlan.blockers.some((blocker) =>
        blocker.includes("unknown or newer migration"),
      ),
    ).toBe(true);
    await client.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [migration0012.createdAt + 1],
    );
  }, 120_000);
});

async function writeWriterPauseProof(
  proofPath: string,
  endpointFingerprint: string,
): Promise<void> {
  await writeFile(
    proofPath,
    `${JSON.stringify(
      {
        schemaVersion: "query-db.dev-writer-pause-proof.v1",
        environment: "DEV",
        endpointFingerprint,
        observedAt: new Date().toISOString(),
        inventoryComplete: true,
        inventoryRef: "synthetic-disposable-writer-inventory",
        operatorProvided: true,
        writers: [
          {
            writerId: "synthetic-manual-loader",
            kind: "manual-loader",
            ownerRef: "synthetic-test-owner",
            pauseCommand: "synthetic-stop-loader",
            resumeCommand: "synthetic-start-loader",
            proofRef: "synthetic-paused-receipt",
            paused: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}
