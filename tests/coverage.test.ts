import { describe, expect, it } from "vitest";

import {
  ORACLE_DATASET_COVERAGE_COLUMNS,
  ORACLE_DATASET_COVERAGE_TABLE,
  toDatasetInfoCoverageEntry,
  type OracleDatasetCoverageRow,
} from "../src/coverage/oracleDatasetCoverage.js";

describe("oracle_dataset_coverage contract", () => {
  it("uses the locked table name and column set", () => {
    expect(ORACLE_DATASET_COVERAGE_TABLE).toBe("oracle_dataset_coverage");
    expect(ORACLE_DATASET_COVERAGE_COLUMNS).toEqual([
      "county",
      "source",
      "ingested_count",
      "expected_count",
      "first_loaded_at",
      "last_loaded_at",
      "cid",
      "ipns_label",
    ]);
  });

  it("maps DB rows to getOracleDatasetInfo coverage entries", () => {
    const row: OracleDatasetCoverageRow = {
      county: "lee",
      source: "permits",
      ingested_count: 27,
      expected_count: null,
      first_loaded_at: "2026-07-08T10:00:00.000Z",
      last_loaded_at: "2026-07-08T10:00:00.000Z",
      cid: "QmPermitExample",
      ipns_label: "oracle-permit-table-lee",
    };
    expect(toDatasetInfoCoverageEntry(row)).toEqual({
      source: "permits",
      ingestedCount: 27,
      expectedCount: null,
      firstLoadedAt: "2026-07-08T10:00:00.000Z",
      lastLoadedAt: "2026-07-08T10:00:00.000Z",
      cid: "QmPermitExample",
      ipnsLabel: "oracle-permit-table-lee",
    });
  });
});
