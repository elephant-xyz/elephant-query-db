import { describe, expect, it } from "vitest";

import {
  COUNTY_KEYED_SOURCES,
  COVERAGE_SOURCES,
  COVERAGE_UPSERT_SQL,
  GLOBAL_COVERAGE_SOURCES,
  buildCoverageCountSql,
  buildCoverageTimestampSql,
  buildCoverageUpsertValues,
  buildGlobalSourceCoverageByCountySql,
  computeCoverage,
  computeGlobalSourceCoverageByCounty,
  computeIngestedCount,
  countySlugFromArtifactUri,
  countySlugFromJurisdictionKey,
  deleteCoverageRowsForSourceExcept,
  globalSourceCountyExpr,
  isGlobalCoverageSource,
  refreshCoverage,
  refreshGlobalSourceCoverage,
  type CoverageQueryClient,
  type CoverageSource,
} from "../scripts/oracle-dataset-coverage-upsert.js";

import {
  backfillCoverage,
  discoverAppraisalCounties,
} from "../scripts/backfill-oracle-dataset-coverage.js";

// ---------------------------------------------------------------------------
// Recording / routing mock client
// ---------------------------------------------------------------------------

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };

/**
 * A CoverageQueryClient mock that routes on SQL substrings so tests can assert both
 * the emitted SQL/values and the resulting computations without a real database.
 *
 * @param handler - Maps an intercepted call to the rows it should return.
 * @returns The mock client plus the recorded calls.
 */
function createRoutingClient(
  handler: (call: QueryCall) => readonly Record<string, unknown>[],
): { client: CoverageQueryClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client: CoverageQueryClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: Row[] }> {
      const call = { text, values };
      calls.push(call);
      return { rows: handler(call) as Row[] };
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// countySlugFromJurisdictionKey
// ---------------------------------------------------------------------------

describe("countySlugFromJurisdictionKey", () => {
  it("inverts appraisalSourceForCounty for single and multi-word counties", () => {
    expect(countySlugFromJurisdictionKey("lee_appraiser")).toBe("lee");
    expect(countySlugFromJurisdictionKey("palm_beach_appraiser")).toBe("palm-beach");
    expect(countySlugFromJurisdictionKey("miami_dade_appraiser")).toBe("miami-dade");
    expect(countySlugFromJurisdictionKey("santa_clara_appraiser")).toBe("santa-clara");
  });

  it("tolerates keys without the _appraiser suffix and stray casing/underscores", () => {
    expect(countySlugFromJurisdictionKey("ORANGE_APPRAISER")).toBe("orange");
    expect(countySlugFromJurisdictionKey("palm_beach")).toBe("palm-beach");
    expect(countySlugFromJurisdictionKey("_lee_")).toBe("lee");
  });
});

// ---------------------------------------------------------------------------
// countySlugFromArtifactUri (TS twin of the SQL derivation)
// ---------------------------------------------------------------------------

describe("countySlugFromArtifactUri", () => {
  it("parses the county from sunbiz artifact URIs", () => {
    const base = "s3://bucket/permit-harvest";
    expect(
      countySlugFromArtifactUri(
        "sunbiz",
        `${base}/sunbiz-miami-dade-corporate-quarterly-2026q2/lexicon-transform/x/part-00000.jsonl`,
      ),
    ).toBe("miami-dade");
    expect(
      countySlugFromArtifactUri(
        "sunbiz",
        `${base}/sunbiz-palm-beach-corporate-quarterly-2026q2/x/part-0.jsonl`,
      ),
    ).toBe("palm-beach");
    expect(
      countySlugFromArtifactUri(
        "sunbiz",
        `${base}/sunbiz-lee-corporate-quarterly-2026q2-expanded/x/part-0.jsonl`,
      ),
    ).toBe("lee");
  });

  it("parses the county from bbb artifact URIs, stripping -county[-permit-seeded]", () => {
    const base = "s3://bucket/permit-harvest/bbb/category-data";
    expect(
      countySlugFromArtifactUri(
        "bbb",
        `${base}/lee-county-permit-seeded/profiles/profiles-part-0027.jsonl`,
      ),
    ).toBe("lee");
    expect(
      countySlugFromArtifactUri(
        "bbb",
        `${base}/miami-dade-county/profiles/profiles/profiles-part-0001.jsonl`,
      ),
    ).toBe("miami-dade");
  });

  it("returns null for unparseable / empty URIs", () => {
    expect(countySlugFromArtifactUri("sunbiz", "")).toBeNull();
    expect(countySlugFromArtifactUri("sunbiz", "s3://bucket/no-county-here.jsonl")).toBeNull();
    expect(countySlugFromArtifactUri("bbb", "s3://bucket/permit-harvest/other/x.jsonl")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

describe("buildCoverageCountSql", () => {
  it("counts DISTINCT folios for appraisal bound to the <county>_appraiser source", () => {
    const stmt = buildCoverageCountSql("palm-beach", "appraisal");
    expect(stmt.text).toContain("FROM properties p");
    expect(stmt.text).toContain("SELECT DISTINCT COALESCE");
    expect(stmt.values).toEqual(["palm_beach_appraiser"]);
  });

  it("counts permits with an anchored source prefix", () => {
    const stmt = buildCoverageCountSql("lee", "permits");
    expect(stmt.text).toContain("FROM property_improvements");
    expect(stmt.text).toContain("source_system ~ ('^' || $1 || '_')");
    expect(stmt.values).toEqual(["lee"]);
  });

  it("counts sunbiz per county via the artifact-URI-derived county", () => {
    const stmt = buildCoverageCountSql("miami-dade", "sunbiz");
    expect(stmt.text).toContain("FROM business_registrations");
    expect(stmt.text).toContain(globalSourceCountyExpr("sunbiz"));
    expect(stmt.text).toContain("= $1");
    expect(stmt.values).toEqual(["miami-dade"]);
  });

  it("counts bbb per county via the artifact-URI-derived county", () => {
    const stmt = buildCoverageCountSql("lee", "bbb");
    expect(stmt.text).toContain("FROM business_reputation_profiles");
    expect(stmt.text).toContain(globalSourceCountyExpr("bbb"));
    expect(stmt.text).toContain("= $1");
    expect(stmt.values).toEqual(["lee"]);
  });
});

describe("buildCoverageTimestampSql", () => {
  it("derives MIN/MAX loaded_at scoped like the count query for county-keyed sources", () => {
    const appraisal = buildCoverageTimestampSql("orange", "appraisal");
    expect(appraisal.text).toContain("min(loaded_at)");
    expect(appraisal.text).toContain("FROM properties");
    expect(appraisal.values).toEqual(["orange_appraiser"]);

    const permits = buildCoverageTimestampSql("orange", "permits");
    expect(permits.text).toContain("FROM property_improvements");
    expect(permits.values).toEqual(["orange"]);
  });

  it("derives MIN/MAX loaded_at per county for sunbiz / bbb", () => {
    const sunbiz = buildCoverageTimestampSql("palm-beach", "sunbiz");
    expect(sunbiz.text).toContain("FROM business_registrations");
    expect(sunbiz.text).toContain(globalSourceCountyExpr("sunbiz"));
    expect(sunbiz.values).toEqual(["palm-beach"]);

    const bbb = buildCoverageTimestampSql("lee", "bbb");
    expect(bbb.text).toContain("FROM business_reputation_profiles");
    expect(bbb.values).toEqual(["lee"]);
  });
});

describe("buildGlobalSourceCoverageByCountySql", () => {
  it("groups sunbiz counts by the artifact-URI county with load-time bounds", () => {
    const stmt = buildGlobalSourceCoverageByCountySql("sunbiz");
    expect(stmt.text).toContain("FROM business_registrations");
    expect(stmt.text).toContain("GROUP BY");
    expect(stmt.text).toContain("count(*)::text AS ingested_count");
    expect(stmt.text).toContain("min(loaded_at)::text AS first_loaded_at");
    expect(stmt.text).toContain("max(loaded_at)::text AS last_loaded_at");
    // Rows whose county can't be parsed are excluded from the partition.
    expect(stmt.text).toContain("IS NOT NULL");
    expect(stmt.values).toEqual([]);
  });

  it("groups bbb counts by the artifact-URI county", () => {
    const stmt = buildGlobalSourceCoverageByCountySql("bbb");
    expect(stmt.text).toContain("FROM business_reputation_profiles");
    expect(stmt.text).toContain(globalSourceCountyExpr("bbb"));
    expect(stmt.values).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Upsert SQL + values
// ---------------------------------------------------------------------------

describe("coverage upsert contract", () => {
  it("is an idempotent ON CONFLICT upsert that preserves publish-owned columns", () => {
    expect(COVERAGE_UPSERT_SQL).toContain("INSERT INTO oracle_dataset_coverage");
    expect(COVERAGE_UPSERT_SQL).toContain("ON CONFLICT (county, source) DO UPDATE SET");
    expect(COVERAGE_UPSERT_SQL).toContain("ingested_count = EXCLUDED.ingested_count");
    // first_loaded_at keeps the earliest known value.
    expect(COVERAGE_UPSERT_SQL).toContain(
      "first_loaded_at = COALESCE(oracle_dataset_coverage.first_loaded_at, EXCLUDED.first_loaded_at)",
    );
    // cid / ipns_label / expected_count are never overwritten.
    expect(COVERAGE_UPSERT_SQL).not.toContain("cid =");
    expect(COVERAGE_UPSERT_SQL).not.toContain("ipns_label =");
    expect(COVERAGE_UPSERT_SQL).not.toContain("expected_count =");
  });

  it("binds values in [county, source, count, first, last] order", () => {
    expect(
      buildCoverageUpsertValues({
        county: "lee",
        source: "permits",
        ingestedCount: 27,
        firstLoadedAt: "2026-07-08T10:00:00.000Z",
        lastLoadedAt: "2026-07-08T11:00:00.000Z",
      }),
    ).toEqual(["lee", "permits", 27, "2026-07-08T10:00:00.000Z", "2026-07-08T11:00:00.000Z"]);
  });
});

// ---------------------------------------------------------------------------
// deleteCoverageRowsForSourceExcept
// ---------------------------------------------------------------------------

describe("deleteCoverageRowsForSourceExcept", () => {
  it("emits a DELETE that keeps only the given counties for a source", async () => {
    const { client, calls } = createRoutingClient(() => []);
    await deleteCoverageRowsForSourceExcept(client, "sunbiz", ["lee", "miami-dade"]);
    const del = calls.find((c) => c.text.includes("DELETE FROM oracle_dataset_coverage"));
    expect(del).toBeDefined();
    expect(del?.text).toContain("county <> ALL($2::text[])");
    expect(del?.values).toEqual(["sunbiz", ["lee", "miami-dade"]]);
  });

  it("deletes every row for a source when the keep-set is empty", async () => {
    const { client, calls } = createRoutingClient(() => []);
    await deleteCoverageRowsForSourceExcept(client, "bbb", []);
    const del = calls.find((c) => c.text.includes("DELETE FROM oracle_dataset_coverage"));
    expect(del?.values).toEqual(["bbb", []]);
  });
});

// ---------------------------------------------------------------------------
// computeIngestedCount coercion
// ---------------------------------------------------------------------------

describe("computeIngestedCount", () => {
  it("parses bigint-as-text into a finite integer", async () => {
    const { client } = createRoutingClient(() => [{ ingested_count: "511695" }]);
    expect(await computeIngestedCount(client, "lee", "appraisal")).toBe(511695);
  });

  it("treats missing/negative/non-numeric counts as zero", async () => {
    const empty = createRoutingClient(() => []);
    expect(await computeIngestedCount(empty.client, "lee", "permits")).toBe(0);

    const nullish = createRoutingClient(() => [{ ingested_count: null }]);
    expect(await computeIngestedCount(nullish.client, "lee", "permits")).toBe(0);

    const negative = createRoutingClient(() => [{ ingested_count: "-5" }]);
    expect(await computeIngestedCount(negative.client, "lee", "permits")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeCoverage + refreshCoverage
// ---------------------------------------------------------------------------

/**
 * Route count vs timestamp vs upsert queries for the compute/refresh tests.
 *
 * @param call - The SQL call intercepted by the mock.
 * @returns Rows appropriate to the intercepted query kind.
 */
function coverageHandler(call: QueryCall): readonly Record<string, unknown>[] {
  if (call.text.includes("INSERT INTO oracle_dataset_coverage")) return [];
  if (call.text.includes("min(loaded_at)")) {
    return [{ first_loaded_at: "2026-06-24T12:30:39.000Z", last_loaded_at: "2026-06-25T00:47:41.000Z" }];
  }
  if (call.text.includes("ingested_count")) return [{ ingested_count: "42" }];
  return [];
}

describe("computeCoverage / refreshCoverage", () => {
  it("combines count and timestamps into one computation", async () => {
    const { client } = createRoutingClient(coverageHandler);
    const computation = await computeCoverage(client, "lee", "appraisal");
    expect(computation).toEqual({
      county: "lee",
      source: "appraisal",
      ingestedCount: 42,
      firstLoadedAt: "2026-06-24T12:30:39.000Z",
      lastLoadedAt: "2026-06-25T00:47:41.000Z",
    });
  });

  it("upserts the computed row with the ON CONFLICT statement and ordered values", async () => {
    const { client, calls } = createRoutingClient(coverageHandler);
    await refreshCoverage(client, "lee", "permits");
    const upsert = calls.find((c) => c.text.includes("INSERT INTO oracle_dataset_coverage"));
    expect(upsert).toBeDefined();
    expect(upsert?.values).toEqual([
      "lee",
      "permits",
      42,
      "2026-06-24T12:30:39.000Z",
      "2026-06-25T00:47:41.000Z",
    ]);
  });
});

// ---------------------------------------------------------------------------
// computeGlobalSourceCoverageByCounty + refreshGlobalSourceCoverage
// ---------------------------------------------------------------------------

describe("computeGlobalSourceCoverageByCounty", () => {
  it("maps grouped rows into per-county computations, skipping blank/zero counties", async () => {
    const { client } = createRoutingClient(() => [
      { county: "lee", ingested_count: "363660", first_loaded_at: "a", last_loaded_at: "b" },
      { county: "miami-dade", ingested_count: "2970008", first_loaded_at: "c", last_loaded_at: "d" },
      { county: "", ingested_count: "5", first_loaded_at: null, last_loaded_at: null },
      { county: "ghost", ingested_count: "0", first_loaded_at: null, last_loaded_at: null },
    ]);
    const computations = await computeGlobalSourceCoverageByCounty(client, "sunbiz");
    expect(computations).toEqual([
      { county: "lee", source: "sunbiz", ingestedCount: 363660, firstLoadedAt: "a", lastLoadedAt: "b" },
      {
        county: "miami-dade",
        source: "sunbiz",
        ingestedCount: 2970008,
        firstLoadedAt: "c",
        lastLoadedAt: "d",
      },
    ]);
  });
});

describe("refreshGlobalSourceCoverage", () => {
  it("prunes stale counties then upserts each derived county exactly once", async () => {
    const upserts: { county: string; source: string; count: number }[] = [];
    const deletes: { source: string; keep: readonly unknown[] }[] = [];
    const { client } = createRoutingClient((call: QueryCall) => {
      if (call.text.includes("DELETE FROM oracle_dataset_coverage")) {
        deletes.push({ source: String(call.values[0]), keep: call.values[1] as unknown[] });
        return [];
      }
      if (call.text.includes("INSERT INTO oracle_dataset_coverage")) {
        upserts.push({
          county: String(call.values[0]),
          source: String(call.values[1]),
          count: Number(call.values[2]),
        });
        return [];
      }
      if (call.text.includes("GROUP BY")) {
        return [
          { county: "lee", ingested_count: "2594", first_loaded_at: null, last_loaded_at: null },
          { county: "miami-dade", ingested_count: "216", first_loaded_at: null, last_loaded_at: null },
        ];
      }
      return [];
    });

    const written = await refreshGlobalSourceCoverage(client, "bbb");

    expect(written.map((c) => `${c.county}:${c.ingestedCount}`)).toEqual([
      "lee:2594",
      "miami-dade:216",
    ]);
    // Prune runs with exactly the derived keep-set before the upserts.
    expect(deletes).toEqual([{ source: "bbb", keep: ["lee", "miami-dade"] }]);
    expect(upserts).toEqual([
      { county: "lee", source: "bbb", count: 2594 },
      { county: "miami-dade", source: "bbb", count: 216 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Backfill discovery + population
// ---------------------------------------------------------------------------

describe("discoverAppraisalCounties", () => {
  it("derives sorted, de-duplicated county slugs from _appraiser sources only", async () => {
    const { client } = createRoutingClient(() => [
      { source_system: "palm_beach_appraiser" },
      { source_system: "lee_appraiser" },
      { source_system: "lee_appraiser" },
      { source_system: "sunbiz" },
      { source_system: null },
    ]);
    expect(await discoverAppraisalCounties(client)).toEqual(["lee", "palm-beach"]);
  });
});

describe("backfillCoverage", () => {
  it("writes county-keyed rows only for populated sources and per-county sunbiz/bbb rows", async () => {
    // County-keyed model: lee has appraisal + permits; palm-beach has appraisal but NO
    // permits (0 rows -> no permit row). santa-clara is NOT in the county-keyed set.
    // Global model: sunbiz is present for lee/miami-dade/palm-beach; bbb for lee/miami-dade.
    // orange/santa-clara appear in NEITHER global partition -> they must get no sunbiz/bbb rows.
    const countyKeyedCounts: Record<string, number> = {
      "lee|appraisal": 511695,
      "lee|permits": 2114833,
      "palm-beach|appraisal": 653945,
      "palm-beach|permits": 0,
    };
    const sunbizGroups = [
      { county: "lee", ingested_count: "363660", first_loaded_at: null, last_loaded_at: null },
      { county: "miami-dade", ingested_count: "2970008", first_loaded_at: null, last_loaded_at: null },
      { county: "palm-beach", ingested_count: "1198914", first_loaded_at: null, last_loaded_at: null },
    ];
    const bbbGroups = [
      { county: "lee", ingested_count: "2594", first_loaded_at: null, last_loaded_at: null },
      { county: "miami-dade", ingested_count: "216", first_loaded_at: null, last_loaded_at: null },
    ];

    const upserts: { county: string; source: string; count: number }[] = [];
    const deletes: { source: string; keep: readonly unknown[] }[] = [];

    const { client } = createRoutingClient((call: QueryCall) => {
      if (call.text.includes("DELETE FROM oracle_dataset_coverage")) {
        deletes.push({ source: String(call.values[0]), keep: call.values[1] as unknown[] });
        return [];
      }
      if (call.text.includes("INSERT INTO oracle_dataset_coverage")) {
        upserts.push({
          county: String(call.values[0]),
          source: String(call.values[1]),
          count: Number(call.values[2]),
        });
        return [];
      }
      if (call.text.includes("GROUP BY") && call.text.includes("FROM business_registrations")) {
        return sunbizGroups;
      }
      if (call.text.includes("GROUP BY") && call.text.includes("FROM business_reputation_profiles")) {
        return bbbGroups;
      }
      if (call.text.includes("min(loaded_at)")) {
        return [{ first_loaded_at: null, last_loaded_at: null }];
      }
      if (call.text.includes("FROM properties p")) {
        const county = String(call.values[0]) === "lee_appraiser" ? "lee" : "palm-beach";
        return [{ ingested_count: String(countyKeyedCounts[`${county}|appraisal`]) }];
      }
      if (call.text.includes("FROM property_improvements")) {
        const county = String(call.values[0]) === "lee" ? "lee" : "palm-beach";
        return [{ ingested_count: String(countyKeyedCounts[`${county}|permits`]) }];
      }
      return [];
    });

    const written = await backfillCoverage(client, ["lee", "palm-beach"]);

    const keys = written.map((c) => `${c.county}|${c.source}`).sort();
    expect(keys).toEqual([
      "lee|appraisal",
      "lee|bbb",
      "lee|permits",
      "lee|sunbiz",
      "miami-dade|bbb",
      "miami-dade|sunbiz",
      "palm-beach|appraisal",
      "palm-beach|sunbiz",
    ]);

    // Empty palm-beach permits produced no upsert.
    expect(
      upserts.find((u) => u.county === "palm-beach" && u.source === "permits"),
    ).toBeUndefined();

    // sunbiz/bbb are attributed per county with DISTINCT counts (no statewide fan-out).
    const sunbizUpserts = upserts.filter((u) => u.source === "sunbiz");
    expect(sunbizUpserts).toEqual([
      { county: "lee", source: "sunbiz", count: 363660 },
      { county: "miami-dade", source: "sunbiz", count: 2970008 },
      { county: "palm-beach", source: "sunbiz", count: 1198914 },
    ]);

    // Stale-row pruning runs for both global sources with the derived keep-sets.
    expect(deletes).toEqual([
      { source: "sunbiz", keep: ["lee", "miami-dade", "palm-beach"] },
      { source: "bbb", keep: ["lee", "miami-dade"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Source set sanity
// ---------------------------------------------------------------------------

describe("coverage source sets", () => {
  it("lists the four supported sources", () => {
    const expected: readonly CoverageSource[] = ["appraisal", "permits", "sunbiz", "bbb"];
    expect(COVERAGE_SOURCES).toEqual(expected);
  });

  it("partitions sources into county-keyed and global (artifact-URI-derived)", () => {
    expect(COUNTY_KEYED_SOURCES).toEqual(["appraisal", "permits"]);
    expect(GLOBAL_COVERAGE_SOURCES).toEqual(["sunbiz", "bbb"]);
    expect(isGlobalCoverageSource("sunbiz")).toBe(true);
    expect(isGlobalCoverageSource("bbb")).toBe(true);
    expect(isGlobalCoverageSource("appraisal")).toBe(false);
    expect(isGlobalCoverageSource("permits")).toBe(false);
  });
});
