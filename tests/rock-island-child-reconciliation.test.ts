import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRollbackSql,
  hashBackfillFolios,
  parseBackfillOptions,
  shouldReplayBackfillTable,
  sortBackfillRows,
  targetCountUsesPropertyJoin,
  unrelatedCountQueryValues,
} from "../scripts/backfill-rock-island-children.js";
import {
  classifyChildEvidence,
  loaderIndexKeyForArtifact,
  parseReconciliationOptions,
  readCanonicalSeedFolios,
  readLoaderIndexedFolios,
  selectBackfillFolios,
} from "../scripts/reconcile-rock-island-children.js";
import type { PreparedRow } from "../src/loader/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ri-reconcile-"));
  temporaryDirectories.push(directory);
  return directory;
}

const validEvidence = {
  sourceAchievable: true,
  outputPresent: true,
  validationReportPresent: true,
  validationIssueCount: 0,
  mapperAccepted: true,
  loaderIndexed: true,
  dbPresent: true,
  requiredForeignKeyPresent: true,
  duplicate: false,
  requestIdentifierMismatch: false,
} as const;

describe("Rock Island child failure classification", () => {
  it("separates every proven root-cause class without using aggregate counts", () => {
    expect(
      classifyChildEvidence({
        ...validEvidence,
        sourceAchievable: false,
        outputPresent: false,
        mapperAccepted: false,
        loaderIndexed: false,
        dbPresent: false,
        requiredForeignKeyPresent: false,
      }),
    ).toBe("genuine_source_null");
    expect(
      classifyChildEvidence({
        ...validEvidence,
        outputPresent: false,
        mapperAccepted: false,
        loaderIndexed: false,
        dbPresent: false,
        requiredForeignKeyPresent: false,
      }),
    ).toBe("missing_or_invalid_transform_output");
    expect(
      classifyChildEvidence({
        ...validEvidence,
        validationIssueCount: 1,
        loaderIndexed: false,
        dbPresent: false,
        requiredForeignKeyPresent: false,
      }),
    ).toBe("schema_validation_failure");
    expect(
      classifyChildEvidence({
        ...validEvidence,
        mapperAccepted: false,
        loaderIndexed: false,
        dbPresent: false,
        requiredForeignKeyPresent: false,
      }),
    ).toBe("loader_mapper_rejection");
    expect(
      classifyChildEvidence({
        ...validEvidence,
        loaderIndexed: false,
        dbPresent: false,
        requiredForeignKeyPresent: false,
      }),
    ).toBe("loader_not_merged");
    expect(
      classifyChildEvidence({
        ...validEvidence,
        requiredForeignKeyPresent: false,
      }),
    ).toBe("parent_fk_resolution_failure");
    expect(
      classifyChildEvidence({
        ...validEvidence,
        duplicate: true,
      }),
    ).toBe("conflict_or_deduplication");
    expect(classifyChildEvidence(validEvidence)).toBe("ok");
  });
});

describe("Rock Island exact folio inventory", () => {
  it("reconciles all 65,806 canonical seed rows by folio, preserving leading zeros", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "rock-island.csv");
    const folios = Array.from({ length: 65_806 }, (_, index) =>
      String(index).padStart(10, "0"),
    );
    await writeFile(
      seedPath,
      `parcel_id,source_identifier,source_features_json\n${folios
        .map((folio) => `${folio},${folio},"{""PIN"":""${folio}""}"`)
        .join("\n")}\n`,
    );

    const inventory = await readCanonicalSeedFolios(seedPath);

    expect(inventory.folios).toHaveLength(65_806);
    expect(new Set(inventory.folios).size).toBe(65_806);
    expect(inventory.folios[0]).toBe("0000000000");
    expect(inventory.folios[65_805]).toBe("0000065805");
    expect(inventory.duplicateFolios).toEqual([]);
  });

  it("emits the proven backfill scope in lexical folio order", () => {
    expect(
      selectBackfillFolios([
        {
          folio: "1706317011",
          propertyClass: "loader_not_merged",
          addressClass: "loader_not_merged",
          lotClass: "loader_not_merged",
        },
        {
          folio: "0436100005",
          propertyClass: "ok",
          addressClass: "genuine_source_null",
          lotClass: "ok",
        },
        {
          folio: "1615202038",
          propertyClass: "loader_not_merged",
          addressClass: "loader_not_merged",
          lotClass: "loader_not_merged",
        },
      ]),
    ).toEqual(["1615202038", "1706317011"]);
  });

  it("reads job-scoped loader watermarks and keeps folios distinct from paths", async () => {
    const directory = await temporaryDirectory();
    const jobDirectory = join(directory, "full-20260807-1123");
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(
      join(jobDirectory, "appraisal-hashes.json"),
      JSON.stringify({
        version: 1,
        artifacts: {
          "0132400001/transformed.zip": "a".repeat(64),
          "1601305001/transformed.zip": "b".repeat(64),
        },
      }),
    );

    const indexed = await readLoaderIndexedFolios(directory);

    expect(indexed).toEqual(
      new Set([
        "full-20260807-1123/0132400001",
        "full-20260807-1123/1601305001",
      ]),
    );
    expect(
      loaderIndexKeyForArtifact(
        "/srv/ingest/data/artifacts/appraisal/rock-island/full-20260807-1123/1601305001/transformed.zip",
      ),
    ).toBe("full-20260807-1123/1601305001");
  });
});

describe("Rock Island backfill safety", () => {
  it("sorts parents before children and excludes no folio identity information", () => {
    const rows: PreparedRow[] = [
      {
        tableName: "lots",
        values: {
          source_system: "rock_island_appraiser",
          source_record_key: "rock_island_appraiser:1601305001:lot:lot",
        },
      },
      {
        tableName: "properties",
        values: {
          source_system: "rock_island_appraiser",
          source_record_key:
            "rock_island_appraiser:1601305001:property:property",
        },
      },
      {
        tableName: "addresses",
        values: {
          source_system: "rock_island_appraiser",
          source_record_key:
            "rock_island_appraiser:1601305001:address:site",
        },
      },
    ];

    expect(sortBackfillRows(rows).map((row) => row.tableName)).toEqual([
      "addresses",
      "properties",
      "lots",
    ]);
    expect(hashBackfillFolios(["1601305001", "1601306004"])).toHaveLength(64);
  });

  it("generates a source-scoped reversible checkpoint rollback", () => {
    const sql = buildRollbackSql("ri_child_bf_20260814a");

    expect(sql).toContain(
      `target.source_system = 'rock_island_appraiser'`,
    );
    expect(sql).toContain(
      `USING "ri_child_bf_20260814a"."_scope_keys" scope`,
    );
    expect(sql).not.toContain("TRUNCATE");
    expect(sql).not.toContain("CASCADE");
  });

  it("counts child tables without direct folios through properties", () => {
    expect(targetCountUsesPropertyJoin("ownerships")).toBe(true);
    expect(targetCountUsesPropertyJoin("property_valuations")).toBe(true);
    expect(targetCountUsesPropertyJoin("properties")).toBe(false);
    expect(
      unrelatedCountQueryValues(
        "SELECT count(*) FROM addresses WHERE source_system <> $1",
      ),
    ).toEqual(["rock_island_appraiser"]);
    expect(
      unrelatedCountQueryValues("SELECT count(*) FROM companies"),
    ).toEqual([]);
    expect(shouldReplayBackfillTable("properties")).toBe(true);
    expect(shouldReplayBackfillTable("fact_sheets")).toBe(false);
  });

  it("requires exact evidence paths and an explicit apply flag", () => {
    expect(
      parseBackfillOptions([
        "--evidence-dir",
        "/evidence",
        "--checkpoint-dir",
        "/checkpoint",
        "--run-id",
        "run_1",
      ]),
    ).toMatchObject({ apply: false, runId: "run_1" });
    expect(
      parseBackfillOptions([
        "--evidence-dir",
        "/evidence",
        "--checkpoint-dir",
        "/checkpoint",
        "--run-id",
        "run_1",
        "--apply",
      ]),
    ).toMatchObject({ apply: true, runId: "run_1" });
    expect(
      parseReconciliationOptions([
        "--seed",
        "/seed.csv",
        "--hash-index-root",
        "/hashes",
        "--public-query-table",
        "/query.parquet",
        "--output-dir",
        "/evidence",
      ]),
    ).toMatchObject({ concurrency: 12 });
  });
});
