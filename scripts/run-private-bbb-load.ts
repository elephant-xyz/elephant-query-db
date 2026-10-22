import { Pool } from "pg";

import {
  loadPrivateBbbBundle,
  planPrivateBbbBundle,
  verifyPrivateBbbBundle,
} from "../src/loader/private-bbb.js";

type Options = {
  readonly mode: "plan" | "apply" | "verify";
  readonly bundlePath: string;
};

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let mode: Options["mode"] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--plan" || token === "--apply" || token === "--verify") {
      if (mode !== undefined) {
        throw new Error("Choose exactly one of --plan, --apply, or --verify");
      }
      mode = token.slice(2) as Options["mode"];
      continue;
    }
    if (token !== "--bundle") {
      throw new Error(`Unknown argument: ${String(token)}`);
    }
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
  if (mode === undefined) {
    throw new Error("Choose exactly one of --plan, --apply, or --verify");
  }
  return { mode, bundlePath };
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
    const result =
      options.mode === "plan"
        ? await planPrivateBbbBundle({
            pool,
            bundlePath: options.bundlePath,
          })
        : options.mode === "verify"
          ? await verifyPrivateBbbBundle({
              pool,
              bundlePath: options.bundlePath,
            })
          : await loadPrivateBbbBundle({
              pool,
              bundlePath: options.bundlePath,
            });
    process.stdout.write(
      `${JSON.stringify({
        event: `private_bbb_${options.mode}_finished`,
        ...result,
      })}\n`,
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
