import { pathToFileURL } from "node:url";

import { Client } from "pg";

export const TAX_ROLL_AVM_METHOD =
  "LEE_APPRAISER_TAX_ROLL_JUST_VALUE";

type CleanupOptions = {
  readonly apply: boolean;
  readonly sourceSystem: string;
};

export function parseTaxRollAvmCleanupOptions(
  argv: readonly string[],
): CleanupOptions {
  let apply = false;
  let sourceSystem: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--source-system") {
      sourceSystem = argv[index + 1]?.trim() ?? null;
      index += 1;
    }
  }
  if (sourceSystem === null || sourceSystem.length === 0) {
    throw new Error("--source-system is required");
  }
  if (!/^[a-z0-9_]+_appraiser$/u.test(sourceSystem)) {
    throw new Error("--source-system must identify one appraisal source");
  }
  return { apply, sourceSystem };
}

export function buildTaxRollAvmCleanupSql(apply: boolean): string {
  const predicate = `
    source_system = $1
    AND valuation_method_type = $2`;
  if (!apply) {
    return `
      SELECT count(*)::integer AS affected_count
      FROM property_valuations
      WHERE ${predicate}
    `;
  }
  return `
    WITH deleted AS (
      DELETE FROM property_valuations
      WHERE ${predicate}
      RETURNING property_valuation_id
    )
    SELECT count(*)::integer AS affected_count
    FROM deleted
  `;
}

async function main(): Promise<void> {
  const options = parseTaxRollAvmCleanupOptions(process.argv.slice(2));
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ affected_count: number }>(
      buildTaxRollAvmCleanupSql(options.apply),
      [options.sourceSystem, TAX_ROLL_AVM_METHOD],
    );
    console.log(
      JSON.stringify({
        event: options.apply
          ? "tax_roll_avm_cleanup_applied"
          : "tax_roll_avm_cleanup_dry_run",
        sourceSystem: options.sourceSystem,
        affectedCount: result.rows[0]?.affected_count ?? 0,
      }),
    );
  } finally {
    await client.end();
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: "tax_roll_avm_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
