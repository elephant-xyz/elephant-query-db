import { pathToFileURL } from "node:url";

import { adaptOraclePrivateBbbHandoff } from "../src/loader/private-bbb-adapter.js";

type Options = {
  readonly handoffPath: string;
  readonly outputDirectory: string;
};

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

export function parsePrivateBbbAdapterArgs(args: readonly string[]): Options {
  let handoffPath: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--handoff":
        handoffPath = readValue(args, index, argument);
        index += 1;
        break;
      case "--output-dir":
        outputDirectory = readValue(args, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }
  if (handoffPath === undefined) throw new Error("--handoff is required");
  if (outputDirectory === undefined) {
    throw new Error("--output-dir is required");
  }
  return { handoffPath, outputDirectory };
}

async function main(): Promise<void> {
  const options = parsePrivateBbbAdapterArgs(process.argv.slice(2));
  const result = await adaptOraclePrivateBbbHandoff(options);
  process.stdout.write(
    `${JSON.stringify({
      event: "private_bbb_bundle_prepared",
      ...result,
    })}\n`,
  );
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
        event: "private_bbb_bundle_prepare_failed",
        error: message,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
