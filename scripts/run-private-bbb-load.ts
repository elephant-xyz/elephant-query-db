import { Pool } from "pg";

import { loadPrivateBbbBundle } from "../src/loader/private-bbb.js";

type Options = {
  readonly bundlePath: string;
};

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token.slice(2), next);
    index += 1;
  }
  const bundlePath = values.get("bundle");
  if (bundlePath === undefined || bundlePath.trim().length === 0) {
    throw new Error("--bundle is required");
  }
  return { bundlePath };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const options = parseOptions(process.argv.slice(2));
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "query-db-private-bbb-loader",
    max: 2,
  });
  try {
    const result = await loadPrivateBbbBundle({
      pool,
      bundlePath: options.bundlePath,
    });
    process.stdout.write(
      `${JSON.stringify({ event: "private_bbb_load_finished", ...result })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  process.stderr.write(
    `${JSON.stringify({ event: "private_bbb_load_failed", error: message })}\n`,
  );
  process.exitCode = 1;
});
