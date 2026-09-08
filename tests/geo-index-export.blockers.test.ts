import { describe, expect, it } from "vitest";

/**
 * Story 3 — geo/value: code-review-sentinel BLOCKER regression tests.
 *
 * ALL TESTS IN THIS FILE ARE INTENTIONALLY RED until the builder contract in
 * `../scripts/run-geo-index-export.ts` is fixed. They encode the reviewer's
 * blockers, NOT new scope. Each test names the exact bug it protects against.
 *
 * Blockers encoded here (producer side):
 *  1. Producer/consumer schema mismatch — the exported index MUST carry
 *     `county` (and `exportedAt`) so the MCP consumer's `GeoIndexSchema`
 *     (elephant-mcp/src/lib/oracleGeoIndex.ts), which REQUIRES `county`, can
 *     parse a real exported file. `buildGeoIndex` currently emits only
 *     { schemaVersion, count, entries } → consumer parse would throw.
 *  2. Cardinality exactness — one entry per property, keyed on the TRUE folio
 *     `request_identifier`. Duplicate flat rows for the same property (caused by
 *     joining multiple geometries or multiple property_valuations) MUST collapse
 *     to a SINGLE entry with one selected current_avm_value and a single
 *     centroid; but DISTINCT properties that happen to share a normalized,
 *     non-unique `parcel_identifier` (the Lee folio-collapse bug) MUST stay
 *     SEPARATE. Keying on parcel_identifier silently dropped ~30,851 Lee parcels.
 *  4. NaN lat/lng — rows whose latitude/longitude cannot be coerced to a finite
 *     number MUST be skipped, never emitted as NaN. `buildGeoIndexRow` currently
 *     falls back to `Number.NaN`, and `buildGeoIndex` keeps it.
 */

const EXPORT_MODULE = "../scripts/run-geo-index-export.js";

const FLAT_ROW = {
  parcel_identifier: "1234567890",
  request_identifier: "REQ-1234567890",
  folio: "0001234567",
  latitude: "26.640628",
  longitude: "-81.872605",
  current_avm_value: "350000.00",
  property_type: "COMMERCIAL",
};

// ---------------------------------------------------------------------------
// Blocker 1 — county / exportedAt so the consumer schema can parse the export
// ---------------------------------------------------------------------------
describe("buildGeoIndex — producer/consumer schema parity (blocker 1, red)", () => {
  it("emits the county supplied by the caller so the consumer GeoIndexSchema (county required) parses", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const index = buildGeoIndex([FLAT_ROW], { county: "Lee" });
    expect(index.county).toBe("Lee");
  });

  it("emits an exportedAt timestamp string on the index", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const index = buildGeoIndex([FLAT_ROW], { county: "Lee" });
    expect(typeof index.exportedAt).toBe("string");
    expect(Number.isNaN(Date.parse(index.exportedAt))).toBe(false);
  });

  it("produces an object whose shape satisfies the consumer's required keys (county + entries)", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const index = buildGeoIndex([FLAT_ROW], { county: "Lee" });
    // Mirrors the REQUIRED fields of GeoIndexSchema in
    // elephant-mcp/src/lib/oracleGeoIndex.ts. A real exported file is consumed
    // there; without county this parse would throw at runtime.
    expect(index).toMatchObject({
      county: "Lee",
      entries: expect.any(Array),
    });
  });
});

// ---------------------------------------------------------------------------
// Blocker 2 — one entry per property, keyed on the TRUE folio request_identifier
// (no double count from duplicate join rows; no collapse of distinct properties
// that share a non-unique normalized parcel_identifier)
// ---------------------------------------------------------------------------
describe("buildGeoIndex — request_identifier cardinality / dedup (blocker 2, red)", () => {
  it("keeps DISTINCT request_identifiers that share a normalized parcel_identifier as SEPARATE entries", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    // The Lee folio-collapse bug, encoded: parcel_identifier is digits-only
    // normalized and NOT unique, so distinct STRAPs/condo units share it. The
    // true folio is request_identifier. Keying dedup on the normalized parcel id
    // (as the old code did, via `folio` = parcel_identifier) collapses these two
    // distinct properties into one — silently dropping the second.
    const rows = [
      { ...FLAT_ROW, request_identifier: "10038474", parcel_identifier: "3143231043380090", folio: "3143231043380090" },
      { ...FLAT_ROW, request_identifier: "10038475", parcel_identifier: "3143231043380090", folio: "3143231043380090" },
    ];
    const index = buildGeoIndex(rows, { county: "Lee" });
    expect(index.entries).toHaveLength(2);
    expect(index.count).toBe(2);
    expect(new Set(index.entries.map((e: { requestIdentifier: string }) => e.requestIdentifier))).toEqual(
      new Set(["10038474", "10038475"]),
    );
  });

  it("collapses duplicate flat rows for the same request_identifier into a single entry", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    // Two identical rows for one property — e.g. it joined two geometry rows.
    // This must NOT yield two entries.
    const index = buildGeoIndex([FLAT_ROW, { ...FLAT_ROW }], { county: "Lee" });
    expect(index.entries).toHaveLength(1);
    expect(index.count).toBe(1);
    expect(index.entries[0].requestIdentifier).toBe("REQ-1234567890");
  });

  it("does not double-count a property that has multiple property_valuations", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    // Same request_identifier + same centroid, two differing valuations (the
    // LEFT JOIN onto property_valuations produced two rows). Exactly one entry
    // must survive.
    const rows = [
      { ...FLAT_ROW, current_avm_value: "100000" },
      { ...FLAT_ROW, current_avm_value: "200000" },
    ];
    const index = buildGeoIndex(rows, { county: "Lee" });
    expect(index.entries).toHaveLength(1);
    expect(index.count).toBe(1);
    // Selection contract: the single surviving entry takes the maximum non-null
    // current_avm_value among the duplicates (deterministic, never the sum).
    expect(index.entries[0].currentAvmValue).toBe(200000);
  });

  it("emits exactly one centroid per property (single latitude/longitude, not repeated)", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const rows = [
      { ...FLAT_ROW, current_avm_value: "100000" },
      { ...FLAT_ROW, current_avm_value: "200000" },
    ];
    const index = buildGeoIndex(rows, { county: "Lee" });
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].latitude).toBeCloseTo(26.640628, 6);
    expect(index.entries[0].longitude).toBeCloseTo(-81.872605, 6);
  });

  it("count equals the number of DISTINCT request_identifiers across a mixed batch", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const other = {
      parcel_identifier: "2222222222",
      request_identifier: "REQ-2222222222",
      folio: "0002222222",
      latitude: "26.5",
      longitude: "-81.9",
      current_avm_value: "125000",
      property_type: "RESIDENTIAL",
    };
    const rows = [FLAT_ROW, { ...FLAT_ROW }, other];
    const index = buildGeoIndex(rows, { county: "Lee" });
    expect(index.count).toBe(new Set(rows.map((r) => r.request_identifier)).size);
    expect(
      new Set(index.entries.map((e: { requestIdentifier: string }) => e.requestIdentifier)),
    ).toEqual(new Set(["REQ-1234567890", "REQ-2222222222"]));
  });
});

// ---------------------------------------------------------------------------
// Blocker 4 — invalid lat/lng must be skipped, never emitted as NaN
// ---------------------------------------------------------------------------
describe("buildGeoIndex — invalid centroid rejection (blocker 4, red)", () => {
  it("skips rows whose latitude/longitude is null instead of emitting NaN", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const rows = [
      FLAT_ROW,
      { ...FLAT_ROW, folio: "NULL-LAT", latitude: null },
      { ...FLAT_ROW, folio: "NULL-LNG", longitude: null },
    ];
    const index = buildGeoIndex(rows, { county: "Lee" });
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].folio).toBe("0001234567");
  });

  it("skips rows whose latitude/longitude is non-numeric instead of emitting NaN", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const rows = [
      FLAT_ROW,
      { ...FLAT_ROW, folio: "BAD-LAT", latitude: "not-a-number" },
    ];
    const index = buildGeoIndex(rows, { county: "Lee" });
    expect(index.entries).toHaveLength(1);
  });

  it("never emits an entry with a non-finite latitude or longitude", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const rows = [
      FLAT_ROW,
      { ...FLAT_ROW, folio: "BAD", latitude: "abc", longitude: null },
    ];
    const index = buildGeoIndex(rows, { county: "Lee" });
    for (const entry of index.entries) {
      expect(Number.isFinite(entry.latitude)).toBe(true);
      expect(Number.isFinite(entry.longitude)).toBe(true);
    }
  });
});
