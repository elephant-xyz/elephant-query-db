import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runDevCanarySchemaMigration } from "../src/migrations/dev-canary-schema.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("DEV canary schema migration integration", () => {
  const client = new Client({ connectionString: testDatabaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP TABLE IF EXISTS public.geometry_rings CASCADE");
    await client.query(
      "DROP TABLE IF EXISTS public.illinois_sos_component_records CASCADE",
    );
    await client.query("DROP TABLE IF EXISTS public.addresses CASCADE");
    await client.query("DROP TABLE IF EXISTS public.geometries CASCADE");
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
      INSERT INTO public.addresses (source_system, source_record_key, marker)
      VALUES ('fixture', 'fixture:address:1', 'preserve-me')
    `);
  });

  afterAll(async () => {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP TABLE IF EXISTS public.geometry_rings CASCADE");
    await client.query(
      "DROP TABLE IF EXISTS public.illinois_sos_component_records CASCADE",
    );
    await client.query("DROP TABLE IF EXISTS public.addresses CASCADE");
    await client.query("DROP TABLE IF EXISTS public.geometries CASCADE");
    await client.end();
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

    const beforeApply = await client.query<{
      readonly identity_columns: number;
      readonly geometry_rings: string | null;
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
        to_regclass('drizzle.__drizzle_migrations')::text AS ledger
    `);
    expect(beforeApply.rows[0]).toEqual({
      identity_columns: 0,
      geometry_rings: null,
      ledger: null,
    });

    const applyOptions = {
      mode: "apply" as const,
      environment: "DEV",
      expectedEndpointFingerprint: plan.environment.endpointFingerprint,
      approvalRef: "local-disposable-test",
      backupRef: "local-disposable-snapshot",
      writersPaused: true,
    };
    const applied = await runDevCanarySchemaMigration(
      testDatabaseUrl,
      applyOptions,
    );
    expect(applied.blockers).toEqual([]);
    expect(applied.pendingActions).toEqual([]);
    expect(applied.targetMigrations.every(({ recorded }) => recorded)).toBe(
      true,
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
    expect(ledgerBeforeReplay.rows[0]?.count).toBe(3);

    const replay = await runDevCanarySchemaMigration(
      testDatabaseUrl,
      applyOptions,
    );
    expect(replay.pendingActions).toEqual([]);
    const ledgerAfterReplay = await client.query<{ readonly count: number }>(`
      SELECT count(*)::int AS count
      FROM drizzle.__drizzle_migrations
    `);
    expect(ledgerAfterReplay.rows[0]?.count).toBe(3);
  });
});
