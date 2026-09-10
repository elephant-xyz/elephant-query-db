import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ParquetReader,
  ParquetSchema,
  ParquetWriter,
} from "@dsnp/parquetjs";

import { mintSitusAddressIdentity } from "../src/loader/address-signature.js";
import { computeFileSha256 } from "./run-property-consolidation-export.js";

export type QueryTableIdentityBackfillOptions = {
  readonly county: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly reportPath: string;
  readonly sourceCid: string;
};

export type QueryTableIdentityBackfillReport = {
  readonly schemaVersion: "1";
  readonly kind: "elephant-query-table-identity-backfill";
  readonly county: string;
  readonly sourceCid: string;
  readonly sourceParquetSha256: string;
  readonly parquetSha256: string;
  readonly validatedAt: string;
  readonly passed: boolean;
  readonly databaseReconciled: false;
  readonly immutableBaselineReconciled: boolean;
  readonly sourceRowCount: number;
  readonly outputRowCount: number;
  readonly eligibleIdentityRows: number;
  readonly matchingIdentityRows: number;
  readonly preservedColumnsSha256: string;
  readonly outputPreservedColumnsSha256: string;
  readonly failures: readonly string[];
};

type BackfillStats = {
  readonly rowCount: number;
  readonly eligibleIdentityRows: number;
  readonly matchingIdentityRows: number;
  readonly preservedColumnsSha256: string;
};

const IPFS_CID_PATTERN = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/u;
const IDENTITY_COLUMNS = new Set(["elephant_uuid", "elephant_token"]);

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Date) return { date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { buffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function updatePreservedColumnsHash(
  hash: ReturnType<typeof createHash>,
  record: Record<string, unknown>,
  columns: readonly string[],
): void {
  for (const column of columns) {
    hash.update(column, "utf8");
    hash.update("\0", "utf8");
    hash.update(JSON.stringify(canonicalValue(record[column])), "utf8");
    hash.update("\n", "utf8");
  }
}

async function readBackfilledStats(
  parquetPath: string,
  preservedColumns: readonly string[],
): Promise<BackfillStats> {
  const reader = await ParquetReader.openFile(parquetPath);
  const hash = createHash("sha256");
  let rowCount = 0;
  let eligibleIdentityRows = 0;
  let matchingIdentityRows = 0;
  try {
    const cursor = reader.getCursor();
    let record = (await cursor.next()) as Record<string, unknown> | null;
    while (record !== null) {
      rowCount += 1;
      updatePreservedColumnsHash(hash, record, preservedColumns);
      const expected = mintSitusAddressIdentity({
        state: optionalText(record["state_code"]),
        postalCode: optionalText(record["address_zip"]),
        street: optionalText(record["address_street"]),
      });
      const elephantUuid = optionalText(record["elephant_uuid"]);
      const elephantToken = optionalText(record["elephant_token"]);
      if (expected !== null) {
        eligibleIdentityRows += 1;
        if (
          elephantUuid === expected.elephantUuid &&
          elephantToken === expected.elephantToken
        ) {
          matchingIdentityRows += 1;
        }
      } else if (elephantUuid !== null || elephantToken !== null) {
        throw new Error("Ineligible query-table row has an address identity");
      }
      record = (await cursor.next()) as Record<string, unknown> | null;
    }
  } finally {
    await reader.close();
  }
  return {
    rowCount,
    eligibleIdentityRows,
    matchingIdentityRows,
    preservedColumnsSha256: hash.digest("hex"),
  };
}

/**
 * Add address:v1 identities to an immutable published Parquet baseline while
 * proving every pre-existing scalar column and row remains unchanged.
 */
export async function backfillQueryTableAddressIdentities(
  options: QueryTableIdentityBackfillOptions,
): Promise<QueryTableIdentityBackfillReport> {
  if (resolve(options.inputPath) === resolve(options.outputPath)) {
    throw new Error("Backfill input and output paths must be different");
  }
  if (!IPFS_CID_PATTERN.test(options.sourceCid)) {
    throw new Error("A valid immutable source Parquet CID is required");
  }

  const sourceParquetSha256 = await computeFileSha256(options.inputPath);
  const reader = await ParquetReader.openFile(options.inputPath);
  const preservedColumns = Object.keys(reader.schema.schema).filter(
    (column) => !IDENTITY_COLUMNS.has(column),
  );
  for (const required of [
    "state_code",
    "address_street",
    "address_zip",
    "request_identifier",
  ]) {
    if (!preservedColumns.includes(required)) {
      await reader.close();
      throw new Error(`Published baseline is missing required column ${required}`);
    }
  }

  const outputSchema = new ParquetSchema({
    ...reader.schema.schema,
    elephant_uuid: { type: "UTF8", optional: true },
    elephant_token: { type: "UTF8", optional: true },
  });
  await mkdir(dirname(options.outputPath), { recursive: true });
  const writer = await ParquetWriter.openFile(outputSchema, options.outputPath, {
    rowGroupSize: 10_000,
  });

  const sourceHash = createHash("sha256");
  let sourceRowCount = 0;
  try {
    const cursor = reader.getCursor();
    let record = (await cursor.next()) as Record<string, unknown> | null;
    while (record !== null) {
      sourceRowCount += 1;
      updatePreservedColumnsHash(sourceHash, record, preservedColumns);
      const identity = mintSitusAddressIdentity({
        state: optionalText(record["state_code"]),
        postalCode: optionalText(record["address_zip"]),
        street: optionalText(record["address_street"]),
      });
      await writer.appendRow({
        ...record,
        elephant_uuid: identity?.elephantUuid ?? null,
        elephant_token: identity?.elephantToken ?? null,
      });
      record = (await cursor.next()) as Record<string, unknown> | null;
    }
  } finally {
    await reader.close();
    await writer.close();
  }

  const sourcePreservedColumnsSha256 = sourceHash.digest("hex");
  const output = await readBackfilledStats(
    options.outputPath,
    preservedColumns,
  );
  const failures: string[] = [];
  if (sourceRowCount !== output.rowCount) {
    failures.push(
      `row count changed from ${sourceRowCount} to ${output.rowCount}`,
    );
  }
  if (sourcePreservedColumnsSha256 !== output.preservedColumnsSha256) {
    failures.push("one or more pre-existing query-table values changed");
  }
  if (output.eligibleIdentityRows !== output.matchingIdentityRows) {
    failures.push(
      `${output.eligibleIdentityRows - output.matchingIdentityRows} eligible rows have an incorrect identity`,
    );
  }

  const report: QueryTableIdentityBackfillReport = {
    schemaVersion: "1",
    kind: "elephant-query-table-identity-backfill",
    county: options.county,
    sourceCid: options.sourceCid,
    sourceParquetSha256,
    parquetSha256: await computeFileSha256(options.outputPath),
    validatedAt: new Date().toISOString(),
    passed: failures.length === 0,
    databaseReconciled: false,
    immutableBaselineReconciled: failures.length === 0,
    sourceRowCount,
    outputRowCount: output.rowCount,
    eligibleIdentityRows: output.eligibleIdentityRows,
    matchingIdentityRows: output.matchingIdentityRows,
    preservedColumnsSha256: sourcePreservedColumnsSha256,
    outputPreservedColumnsSha256: output.preservedColumnsSha256,
    failures,
  };
  await mkdir(dirname(options.reportPath), { recursive: true });
  await writeFile(
    options.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (!report.passed) {
    throw new Error(`Query-table identity backfill failed: ${failures.join("; ")}`);
  }
  return report;
}

function parseOptions(argv: readonly string[]): QueryTableIdentityBackfillOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg?.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg.slice(2), value);
      index += 1;
    }
  }
  const county = values.get("county");
  const inputPath = values.get("input");
  const outputPath = values.get("output");
  const sourceCid = values.get("source-cid");
  if (!county || !inputPath || !outputPath || !sourceCid) {
    throw new Error(
      "--county, --input, --output, and --source-cid are required",
    );
  }
  return {
    county,
    inputPath,
    outputPath,
    sourceCid,
    reportPath:
      values.get("report") ??
      `${outputPath}.identity-backfill-report.json`,
  };
}

async function main(): Promise<void> {
  const report = await backfillQueryTableAddressIdentities(
    parseOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(report));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
