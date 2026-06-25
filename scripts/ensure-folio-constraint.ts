/**
 * Idempotently ensure the parcels folio unique key (migration 0005) is applied.
 *
 * Migration 0005 re-keys parcel dedup from the digits-only normalized `parcel_identifier`
 * to the folio `request_identifier`. It is required before the re-load (the loader upserts
 * ON CONFLICT (jurisdiction_key, request_identifier)). Migration 0005's raw SQL is NOT
 * idempotent (the ADD CONSTRAINT errors if it already exists), so this step is safe to run
 * on every container start: it no-ops when the constraint is already present.
 */
import { Client } from "pg";

const TARGET_CONSTRAINT = "parcels_jurisdiction_key_request_identifier_unique";
const OLD_CONSTRAINT = "parcels_jurisdiction_key_parcel_identifier_unique";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1`,
      [TARGET_CONSTRAINT],
    );
    if (rows.length > 0) {
      console.log(JSON.stringify({ event: "folio_constraint_present", constraint: TARGET_CONSTRAINT }));
      return;
    }

    const nullCheck = await client.query(
      `SELECT count(*)::int AS n FROM parcels WHERE request_identifier IS NULL`,
    );
    if (Number(nullCheck.rows[0].n) > 0) {
      throw new Error("parcels.request_identifier has NULL rows; backfill before applying NOT NULL");
    }

    await client.query(`ALTER TABLE "parcels" DROP CONSTRAINT IF EXISTS "${OLD_CONSTRAINT}"`);
    await client.query(`ALTER TABLE "parcels" ALTER COLUMN "request_identifier" SET NOT NULL`);
    await client.query(
      `ALTER TABLE "parcels" ADD CONSTRAINT "${TARGET_CONSTRAINT}" UNIQUE ("jurisdiction_key", "request_identifier")`,
    );
    console.log(JSON.stringify({ event: "folio_constraint_applied", constraint: TARGET_CONSTRAINT }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "ensure_folio_constraint_failed", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
