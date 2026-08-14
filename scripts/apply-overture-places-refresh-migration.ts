import { readFile } from "node:fs/promises";

import { Client } from "pg";

/**
 * Apply the idempotent SQL-only places refresh migration. This script exists
 * for the established Fargate loader path, which does not run Drizzle's
 * migration journal.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const sql = await readFile(
    "migrations/0008_overture_places_refresh.sql",
    "utf8",
  );
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    application_name: "query-db-overture-places-refresh-migration",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({
        event: "overture_places_refresh_migration_applied",
        statementCount: statements.length,
      })}\n`,
    );
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught;
  } finally {
    await client.end();
  }
}

main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  process.stderr.write(
    `${JSON.stringify({
      event: "overture_places_refresh_migration_failed",
      error: message,
    })}\n`,
  );
  process.exitCode = 1;
});
