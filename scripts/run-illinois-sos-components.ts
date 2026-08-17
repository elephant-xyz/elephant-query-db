import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  ILLINOIS_SOS_BULK_COMPONENT_SPECS,
  loadIllinoisSosBulkComponentFile,
  parseIllinoisSosBulkComponentFile,
  type IllinoisSosBulkComponent,
  type IllinoisSosBulkEntityKind,
  type IllinoisSosParsedBulkComponentFile,
  type JsonObject,
  type QueryClient,
  type QueryRowsResult,
} from "../src/loader/index.js";

type IllinoisSosComponentInput = {
  readonly component: IllinoisSosBulkComponent;
  readonly entityKind: IllinoisSosBulkEntityKind;
  readonly path: string;
};

type IllinoisSosComponentOptions = {
  readonly inputs: readonly IllinoisSosComponentInput[];
  readonly load: boolean;
};

type DatabaseQueryRunner = {
  readonly query: <Row extends JsonObject = JsonObject>(
    text: string,
    values: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Row[] }>;
};

/**
 * Validate operator-downloaded official Corporation/LLC components and
 * optionally load them into the private evidence table.
 *
 * This command has no network behavior. Every source file must be supplied by
 * an operator from an official apps.ilsos.gov bulk link.
 */
async function main(): Promise<void> {
  const options = parseIllinoisSosComponentOptions(process.argv.slice(2));
  const files = await Promise.all(options.inputs.map(readComponentFile));
  console.log(
    JSON.stringify({
      components: files.map((file) => ({
        component: file.component,
        entityKind: file.entityKind,
        recordCount: file.records.length,
        runDate: file.runDate,
        sourceFileName: file.sourceFileName,
      })),
      event: "illinois_sos_private_components_validated",
      publicationApproved: false,
    }),
  );
  if (!options.load) return;

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for --load");
  }
  const pool = new Pool({
    application_name: "illinois-sos-private-components",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  const connection = await pool.connect();
  const client = createQueryClient(connection);
  try {
    await connection.query("BEGIN");
    const firstPass = [];
    for (const file of files) {
      firstPass.push({
        component: file.component,
        counters: await loadIllinoisSosBulkComponentFile(client, file),
        entityKind: file.entityKind,
        runDate: file.runDate,
      });
    }
    const idempotencyPass = [];
    for (const file of files) {
      const counters = await loadIllinoisSosBulkComponentFile(client, file);
      if (counters.changedRows !== 0) {
        throw new Error(
          `Idempotency verification changed ${counters.changedRows} ${file.entityKind}:${file.component} rows`,
        );
      }
      idempotencyPass.push({
        component: file.component,
        counters,
        entityKind: file.entityKind,
        runDate: file.runDate,
      });
    }
    await connection.query("COMMIT");
    console.log(
      JSON.stringify({
        event: "illinois_sos_private_components_loaded",
        firstPass,
        idempotencyPass,
        publicationApproved: false,
      }),
    );
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

/**
 * Parse the repeatable component-file CLI contract.
 *
 * @param argv - Arguments following the script name.
 * @returns Validated local component inputs and explicit load choice.
 */
export function parseIllinoisSosComponentOptions(
  argv: readonly string[],
): IllinoisSosComponentOptions {
  const inputs: IllinoisSosComponentInput[] = [];
  let load = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--load") {
      load = true;
      continue;
    }
    if (token !== "--file") {
      throw new Error(`Unknown option: ${token ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--file requires entity-kind:component:path");
    }
    inputs.push(parseComponentInput(value));
    index += 1;
  }
  if (inputs.length === 0) {
    throw new Error("Provide at least one --file entity-kind:component:path");
  }
  return { inputs, load };
}

function parseComponentInput(value: string): IllinoisSosComponentInput {
  const firstSeparator = value.indexOf(":");
  const secondSeparator = value.indexOf(":", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) {
    throw new Error(`Invalid --file value: ${value}`);
  }
  const entityKind = value.slice(0, firstSeparator);
  const component = value.slice(firstSeparator + 1, secondSeparator);
  const path = value.slice(secondSeparator + 1);
  if (entityKind !== "corporation" && entityKind !== "llc") {
    throw new Error(`Invalid Illinois SOS entity kind: ${entityKind}`);
  }
  const supported = ILLINOIS_SOS_BULK_COMPONENT_SPECS.some(
    (spec) =>
      spec.entityKind === entityKind && spec.component === component,
  );
  if (!supported) {
    throw new Error(
      `Unsupported Illinois SOS component: ${entityKind}:${component}`,
    );
  }
  if (path.length === 0) {
    throw new Error(`Missing path for ${entityKind}:${component}`);
  }
  return {
    component: component as IllinoisSosBulkComponent,
    entityKind,
    path,
  };
}

async function readComponentFile(
  input: IllinoisSosComponentInput,
): Promise<IllinoisSosParsedBulkComponentFile> {
  const absolutePath = resolve(input.path);
  return parseIllinoisSosBulkComponentFile({
    component: input.component,
    contents: await readFile(absolutePath, "utf8"),
    entityKind: input.entityKind,
    sourceArtifactUri: pathToFileURL(absolutePath).href,
    sourceFileName: basename(absolutePath),
  });
}

function createQueryClient(runner: DatabaseQueryRunner): QueryClient {
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ): Promise<QueryRowsResult<Row>> {
      const result = await runner.query<Row>(text, values);
      return { rows: result.rows };
    },
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
