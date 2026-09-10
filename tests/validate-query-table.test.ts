import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";
import { afterEach, describe, expect, it } from "vitest";

import { readParquetStats } from "../scripts/validate-query-table.js";

const GOLDEN_UUID = "c3a982a7-1102-50b8-b2cd-6cb3fca2060f";
const GOLDEN_TOKEN =
  "da5b90e067f162ea35eb482befaea835b32df7861adb282c6fb3983f17fa325e";

const directories: string[] = [];

async function writeFixture(
  rows: ReadonlyArray<Record<string, unknown>>,
  includeIdentityColumns = true,
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "query-table-validation-"));
  directories.push(directory);
  const path = join(directory, "query-table.parquet");
  const schema = new ParquetSchema({
    request_identifier: { type: "UTF8" },
    state_code: { type: "UTF8", optional: true },
    address_street: { type: "UTF8", optional: true },
    address_zip: { type: "UTF8", optional: true },
    ...(includeIdentityColumns
      ? {
          elephant_uuid: { type: "UTF8", optional: true },
          elephant_token: { type: "UTF8", optional: true },
        }
      : {}),
  });
  const writer = await ParquetWriter.openFile(schema, path);
  try {
    for (const row of rows) await writer.appendRow(row);
  } finally {
    await writer.close();
  }
  return path;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("query-table address identity validation", () => {
  it("recomputes every eligible address and permits nulls only for ineligible rows", async () => {
    const path = await writeFixture([
      {
        request_identifier: "folio-1",
        state_code: "FL",
        address_street: "11659 JONATHAN RD",
        address_zip: "32225-1234",
        elephant_uuid: GOLDEN_UUID,
        elephant_token: GOLDEN_TOKEN,
      },
      {
        request_identifier: "folio-2",
        state_code: "FL",
        address_street: "NO ZIP",
        address_zip: null,
        elephant_uuid: null,
        elephant_token: null,
      },
    ]);

    await expect(readParquetStats(path)).resolves.toMatchObject({
      rowCount: 2,
      distinctRequestIdentifiers: 2,
      missingIdentityColumns: [],
      eligibleIdentityRows: 1,
      matchingIdentityRows: 1,
      missingIdentityRows: 0,
      ineligibleWithIdentityRows: 0,
      partialIdentityRows: 0,
      invalidUuidRows: 0,
      invalidTokenRows: 0,
      mismatchedIdentityRows: 0,
    });
  });

  it("detects missing, partial, malformed, and mismatched identities", async () => {
    const path = await writeFixture([
      {
        request_identifier: "missing",
        state_code: "FL",
        address_street: "11659 JONATHAN RD",
        address_zip: "32225",
      },
      {
        request_identifier: "partial",
        state_code: "FL",
        address_street: "11659 JONATHAN RD",
        address_zip: "32225",
        elephant_uuid: GOLDEN_UUID,
      },
      {
        request_identifier: "mismatch",
        state_code: "FL",
        address_street: "11659 JONATHAN RD",
        address_zip: "32225",
        elephant_uuid: "00000000-0000-5000-8000-000000000000",
        elephant_token: "0".repeat(64),
      },
      {
        request_identifier: "ineligible",
        state_code: "FL",
        address_street: "NO ZIP",
        elephant_uuid: "not-a-uuid",
        elephant_token: "not-a-token",
      },
    ]);

    await expect(readParquetStats(path)).resolves.toMatchObject({
      eligibleIdentityRows: 3,
      matchingIdentityRows: 0,
      missingIdentityRows: 1,
      ineligibleWithIdentityRows: 1,
      partialIdentityRows: 1,
      invalidUuidRows: 1,
      invalidTokenRows: 1,
      mismatchedIdentityRows: 2,
    });
  });

  it("reports identity columns missing from an old publication", async () => {
    const path = await writeFixture(
      [
        {
          request_identifier: "folio-1",
          state_code: "FL",
          address_street: "11659 JONATHAN RD",
          address_zip: "32225",
        },
      ],
      false,
    );

    const stats = await readParquetStats(path);
    expect(stats.missingIdentityColumns).toEqual([
      "elephant_uuid",
      "elephant_token",
    ]);
    expect(stats.missingIdentityRows).toBe(1);
  });
});
