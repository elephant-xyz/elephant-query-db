import { pathToFileURL } from "node:url";

import {
  runDevCanarySchemaMigration,
  type DevCanaryMigrationOptions,
} from "../src/migrations/dev-canary-schema.js";

function readValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseDevCanaryMigrationArgs(
  args: readonly string[],
): DevCanaryMigrationOptions {
  let mode: "plan" | "apply" | "verify" | undefined;
  let environment: string | undefined;
  let expectedEndpointFingerprint: string | undefined;
  const approvalRefs: string[] = [];
  let backupRef: string | undefined;
  let backupCreatedAt: string | undefined;
  let writerPauseProofPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--plan":
        if (mode !== undefined) {
          throw new Error("Choose exactly one of --plan, --apply, or --verify");
        }
        mode = "plan";
        break;
      case "--apply":
        if (mode !== undefined) {
          throw new Error("Choose exactly one of --plan, --apply, or --verify");
        }
        mode = "apply";
        break;
      case "--verify":
        if (mode !== undefined) {
          throw new Error("Choose exactly one of --plan, --apply, or --verify");
        }
        mode = "verify";
        break;
      case "--environment":
        environment = readValue(args, index, argument);
        index += 1;
        break;
      case "--expected-endpoint-fingerprint":
        expectedEndpointFingerprint = readValue(args, index, argument);
        index += 1;
        break;
      case "--approval-ref":
        approvalRefs.push(readValue(args, index, argument));
        index += 1;
        break;
      case "--backup-ref":
        backupRef = readValue(args, index, argument);
        index += 1;
        break;
      case "--backup-created-at":
        backupCreatedAt = readValue(args, index, argument);
        index += 1;
        break;
      case "--writer-pause-proof":
        writerPauseProofPath = readValue(args, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }

  if (mode === undefined) {
    throw new Error("Choose exactly one of --plan, --apply, or --verify");
  }
  if (environment === undefined) {
    throw new Error("--environment is required");
  }

  return {
    mode,
    environment,
    ...(expectedEndpointFingerprint === undefined
      ? {}
      : { expectedEndpointFingerprint }),
    ...(approvalRefs.length === 0 ? {} : { approvalRefs }),
    ...(backupRef === undefined ? {} : { backupRef }),
    ...(backupCreatedAt === undefined ? {} : { backupCreatedAt }),
    ...(writerPauseProofPath === undefined ? {} : { writerPauseProofPath }),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const options = parseDevCanaryMigrationArgs(process.argv.slice(2));
  const report = await runDevCanarySchemaMigration(databaseUrl, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(
      `${JSON.stringify({
        event: "dev_canary_schema_migration_failed",
        error: message,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
