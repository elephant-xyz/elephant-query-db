import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ParquetReader,
  ParquetSchema,
  ParquetWriter,
} from "@dsnp/parquetjs";
import { afterEach, describe, expect, it } from "vitest";

import { backfillQueryTableAddressIdentities } from "../scripts/backfill-query-table-address-identities.js";

const SOURCE_CID = "QmeWMT7HWoSDX9PLahXDaRuWbXtktSpb5t2kZBvqTNRi5b";
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "query-table-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("query-table address identity backfill", () => {
  it("adds exact identities while preserving all existing rows and values", async () => {
    const directory = await createTemporaryDirectory();
    const inputPath = join(directory, "source.parquet");
    const outputPath = join(directory, "backfilled.parquet");
    const reportPath = join(directory, "report.json");
    const schema = new ParquetSchema({
      request_identifier: { type: "UTF8" },
      state_code: { type: "UTF8", optional: true },
      address_street: { type: "UTF8", optional: true },
      address_zip: { type: "UTF8", optional: true },
      owner_name: { type: "UTF8", optional: true },
      market_value: { type: "DOUBLE", optional: true },
    });
    const writer = await ParquetWriter.openFile(schema, inputPath);
    await writer.appendRow({
      request_identifier: "folio-1",
      state_code: "FL",
      address_street: "11659 JONATHAN RD",
      address_zip: "32225-1234",
      owner_name: "Owner One",
      market_value: 250_000,
    });
    await writer.appendRow({
      request_identifier: "folio-2",
      state_code: "FL",
      address_street: null,
      address_zip: "33701",
      owner_name: "Owner Two",
      market_value: 100_000,
    });
    await writer.close();

    const report = await backfillQueryTableAddressIdentities({
      county: "duval",
      inputPath,
      outputPath,
      reportPath,
      sourceCid: SOURCE_CID,
    });

    expect(report).toMatchObject({
      passed: true,
      databaseReconciled: false,
      immutableBaselineReconciled: true,
      sourceRowCount: 2,
      outputRowCount: 2,
      eligibleIdentityRows: 1,
      matchingIdentityRows: 1,
    });
    expect(report.preservedColumnsSha256).toBe(
      report.outputPreservedColumnsSha256,
    );

    const reader = await ParquetReader.openFile(outputPath);
    const cursor = reader.getCursor();
    const first = (await cursor.next()) as Record<string, unknown>;
    const second = (await cursor.next()) as Record<string, unknown>;
    await reader.close();
    expect(first).toMatchObject({
      request_identifier: "folio-1",
      owner_name: "Owner One",
      market_value: 250_000,
      elephant_uuid: "c3a982a7-1102-50b8-b2cd-6cb3fca2060f",
      elephant_token:
        "da5b90e067f162ea35eb482befaea835b32df7861adb282c6fb3983f17fa325e",
    });
    expect(second.elephant_uuid).toBeNull();
    expect(second.elephant_token).toBeNull();
  });

  it("rejects in-place rewrites and unbound source CIDs", async () => {
    await expect(
      backfillQueryTableAddressIdentities({
        county: "duval",
        inputPath: "/tmp/same.parquet",
        outputPath: "/tmp/same.parquet",
        reportPath: "/tmp/report.json",
        sourceCid: SOURCE_CID,
      }),
    ).rejects.toThrow(/must be different/u);
    await expect(
      backfillQueryTableAddressIdentities({
        county: "duval",
        inputPath: "/tmp/source.parquet",
        outputPath: "/tmp/output.parquet",
        reportPath: "/tmp/report.json",
        sourceCid: "not-a-cid",
      }),
    ).rejects.toThrow(/source Parquet CID/u);
  });
});
