import { describe, expect, it } from "vitest";

/**
 * Story 3 — AC2: derived geo index builder / export contract.
 *
 * ALL TESTS IN THIS FILE ARE INTENTIONALLY RED.
 * `../scripts/run-geo-index-export.js` does not exist yet, so the per-test
 * dynamic import throws and every test fails until the slim single-pass geo
 * export is built. (Dynamic import keeps each failure a counted RED rather
 * than an uncounted collection error.)
 *
 * Contract pinned here:
 *  - ONE SQL pass produces a slim row per property carrying both validation
 *    keys (folio + request_identifier), the centroid (latitude, longitude),
 *    the current_avm_value, AND the property type (kept so the risk aggregate
 *    can distinguish commercial vs residential — AC3/AC4).
 *  - The builder is a PURE function of a flat row: it needs NO nested
 *    consolidated property data (no permits/taxes/valuations arrays). This is
 *    the "no full property file re-fetch" guard — if someone makes the geo
 *    index depend on the heavy consolidation export, this contract breaks.
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

describe("buildGeoIndexRow", () => {
  it("carries both validation keys: folio and request_identifier", async () => {
    const { buildGeoIndexRow } = await import(EXPORT_MODULE);
    const entry = buildGeoIndexRow(FLAT_ROW);
    expect(entry.folio).toBe("0001234567");
    expect(entry.requestIdentifier).toBe("REQ-1234567890");
    expect(entry.parcelIdentifier).toBe("1234567890");
  });

  it("coerces latitude and longitude strings to finite numbers", async () => {
    const { buildGeoIndexRow } = await import(EXPORT_MODULE);
    const entry = buildGeoIndexRow(FLAT_ROW);
    expect(entry.latitude).toBeCloseTo(26.640628, 6);
    expect(entry.longitude).toBeCloseTo(-81.872605, 6);
    expect(Number.isFinite(entry.latitude)).toBe(true);
    expect(Number.isFinite(entry.longitude)).toBe(true);
  });

  it("coerces current_avm_value to a number when present", async () => {
    const { buildGeoIndexRow } = await import(EXPORT_MODULE);
    const entry = buildGeoIndexRow(FLAT_ROW);
    expect(entry.currentAvmValue).toBe(350000);
  });

  it("keeps current_avm_value null when the source value is null", async () => {
    const { buildGeoIndexRow } = await import(EXPORT_MODULE);
    const entry = buildGeoIndexRow({ ...FLAT_ROW, current_avm_value: null });
    expect(entry.currentAvmValue).toBeNull();
  });

  it("preserves the property type so the risk aggregate can split commercial vs residential", async () => {
    const { buildGeoIndexRow } = await import(EXPORT_MODULE);
    const commercial = buildGeoIndexRow({ ...FLAT_ROW, property_type: "COMMERCIAL" });
    const residential = buildGeoIndexRow({ ...FLAT_ROW, property_type: "RESIDENTIAL" });
    expect(commercial.propertyType).toBe("COMMERCIAL");
    expect(residential.propertyType).toBe("RESIDENTIAL");
  });

  it("builds a complete entry from flat scalars ALONE (no nested consolidated data / no re-fetch)", async () => {
    const { buildGeoIndexRow } = await import(EXPORT_MODULE);
    // The row carries no permits/taxes/valuations arrays — proving the geo
    // index is a single slim SQL pass, not a re-read of the consolidated file.
    const entry = buildGeoIndexRow(FLAT_ROW);
    expect(entry).toMatchObject({
      parcelIdentifier: "1234567890",
      requestIdentifier: "REQ-1234567890",
      folio: "0001234567",
      propertyType: "COMMERCIAL",
    });
    expect(typeof entry.latitude).toBe("number");
    expect(typeof entry.longitude).toBe("number");
  });
});

describe("buildGeoIndex", () => {
  const rows = [
    FLAT_ROW,
    {
      parcel_identifier: "2222222222",
      request_identifier: "REQ-2222222222",
      folio: "0002222222",
      latitude: "26.5",
      longitude: "-81.9",
      current_avm_value: "125000",
      property_type: "RESIDENTIAL",
    },
  ];

  it("emits one entry per distinct request_identifier with the validation keys intact", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const index = buildGeoIndex(rows);
    expect(index.entries).toHaveLength(2);
    expect(index.entries.map((e: { parcelIdentifier: string }) => e.parcelIdentifier)).toEqual([
      "1234567890",
      "2222222222",
    ]);
    for (const entry of index.entries) {
      expect(entry.folio).toBeTruthy();
      expect(entry.requestIdentifier).toBeTruthy();
    }
  });

  it("reports a count equal to the number of DISTINCT request_identifiers (the true folio)", async () => {
    const { buildGeoIndex } = await import(EXPORT_MODULE);
    const index = buildGeoIndex(rows);
    expect(index.count).toBe(new Set(rows.map((r) => r.request_identifier)).size);
    expect(index.count).toBe(index.entries.length);
  });
});
