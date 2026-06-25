/**
 * Clear all appraisal-owned rows from the query DB in an FK-safe, batched, resumable way.
 *
 * WHY THIS EXISTS
 * ---------------
 * The appraisal re-load must start from a clean appraisal slate so the parcel count is
 * provable. A blanket `TRUNCATE ... CASCADE` is UNSAFE here: the shared `addresses`,
 * `companies`, and `people` tables are FK-referenced by Sunbiz/BBB, and the permit child
 * tables (`permit_links`/`events`/`fees`/`contacts`/`custom_fields`, `inspections`)
 * FK-reference `property_improvements`. A CASCADE through any of those wipes Sunbiz, BBB,
 * or live permit data (this actually happened: see vault Bugs/2026-06-24-truncate-cascade).
 *
 * THE SAFE RULE
 * -------------
 * Delete ONLY rows whose `source_system = 'lee_appraiser'`, in reverse FK order, and NEVER
 * touch the shared tables (`addresses`, `companies`, `people`). Deleting
 * `property_improvements WHERE source_system='lee_appraiser'` is safe because the permit
 * children hang off the `lee_accela` rows, which are left untouched.
 *
 * Batched (chunked via ctid) so a single statement never locks millions of rows or blows a
 * task timeout, and so the job is interruptible/resumable (re-running just deletes whatever
 * appraisal rows remain — idempotent).
 */
import { Client } from "pg";

const SOURCE_SYSTEM = "lee_appraiser";
const CHUNK_SIZE = 50_000;

/**
 * Appraisal-owned tables in REVERSE of APPRAISAL_TABLE_ORDER
 * (scripts/run-bulk-data-load.ts) so children are deleted before parents.
 * The shared `addresses`, `companies`, `people` are intentionally EXCLUDED.
 */
const DELETE_ORDER: readonly string[] = [
  "ownerships",
  "files",
  "flood_storm_information",
  "lots",
  "layouts",
  "utilities",
  "structures",
  "property_valuations",
  "taxes",
  "sales_histories",
  "geometries",
  "fact_sheets",
  "deeds",
  "property_improvements",
  "properties",
  "parcels",
  "unnormalized_addresses",
];

/**
 * Delete one table's `lee_appraiser` rows in fixed-size chunks until none remain.
 *
 * @param client - Connected pg client.
 * @param table - Table name to clear (appraisal-owned only).
 * @returns Total rows deleted from the table.
 */
async function clearTable(client: Client, table: string): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await client.query(
      `DELETE FROM "${table}"
       WHERE ctid IN (
         SELECT ctid FROM "${table}"
         WHERE source_system = $1
         LIMIT ${CHUNK_SIZE}
       )`,
      [SOURCE_SYSTEM],
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted > 0) {
      console.log(JSON.stringify({ event: "clear_chunk_deleted", table, deleted, total }));
    }
    if (deleted < CHUNK_SIZE) break;
  }
  console.log(JSON.stringify({ event: "clear_table_done", table, total }));
  return total;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log(JSON.stringify({ event: "clear_started", sourceSystem: SOURCE_SYSTEM, tables: DELETE_ORDER.length }));
    let grand = 0;
    for (const table of DELETE_ORDER) {
      grand += await clearTable(client, table);
    }
    console.log(JSON.stringify({ event: "clear_finished", totalDeleted: grand }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "clear_failed", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
