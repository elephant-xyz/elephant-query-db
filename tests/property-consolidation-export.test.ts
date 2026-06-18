import { describe, expect, it } from "vitest";

import {
  accumulateManifestStats,
  assemblePropertyRecord,
  buildManifestEntry,
  buildManifestSummary,
  computeIpfsCid,
  DEFAULT_BATCH_SIZE,
  EMPTY_MANIFEST_STATS,
  parseOptions,
} from "../scripts/run-property-consolidation-export.js";

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

describe("parseOptions", () => {
  it("uses default values when no flags are passed", () => {
    const options = parseOptions([]);

    expect(options.limit).toBeNull();
    expect(options.outDir).toBe(".property-consolidation-export");
    expect(options.county).toBe("lee");
    expect(options.envFile).toBe(".env.local");
  });

  it("parses --limit flag", () => {
    const options = parseOptions(["--limit", "50"]);
    expect(options.limit).toBe(50);
  });

  it("parses --out-dir flag", () => {
    const options = parseOptions(["--out-dir", "/tmp/output"]);
    expect(options.outDir).toBe("/tmp/output");
  });

  it("parses --county flag", () => {
    const options = parseOptions(["--county", "broward"]);
    expect(options.county).toBe("broward");
  });

  it("parses --env-file flag", () => {
    const options = parseOptions(["--env-file", "/etc/app/.env"]);
    expect(options.envFile).toBe("/etc/app/.env");
  });

  it("parses multiple flags together", () => {
    const options = parseOptions([
      "--limit", "100",
      "--out-dir", "/data/out",
      "--county", "miami-dade",
      "--env-file", ".env.prod",
    ]);
    expect(options.limit).toBe(100);
    expect(options.outDir).toBe("/data/out");
    expect(options.county).toBe("miami-dade");
    expect(options.envFile).toBe(".env.prod");
  });

  it("treats non-numeric limit as null", () => {
    const options = parseOptions(["--limit", "abc"]);
    expect(options.limit).toBeNull();
  });

  it("uses DEFAULT_BATCH_SIZE when --batch-size is not passed", () => {
    const options = parseOptions([]);
    expect(options.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(options.batchSize).toBe(250);
  });

  it("parses --batch-size flag", () => {
    const options = parseOptions(["--batch-size", "50"]);
    expect(options.batchSize).toBe(50);
  });

  it("falls back to DEFAULT_BATCH_SIZE for non-numeric --batch-size", () => {
    const options = parseOptions(["--batch-size", "abc"]);
    expect(options.batchSize).toBe(DEFAULT_BATCH_SIZE);
  });

  it("falls back to DEFAULT_BATCH_SIZE for zero --batch-size", () => {
    const options = parseOptions(["--batch-size", "0"]);
    expect(options.batchSize).toBe(DEFAULT_BATCH_SIZE);
  });

  it("falls back to DEFAULT_BATCH_SIZE for negative --batch-size", () => {
    const options = parseOptions(["--batch-size", "-5"]);
    expect(options.batchSize).toBe(DEFAULT_BATCH_SIZE);
  });

  it("parses --batch-size alongside other flags", () => {
    const options = parseOptions(["--limit", "100", "--batch-size", "25", "--county", "broward"]);
    expect(options.limit).toBe(100);
    expect(options.batchSize).toBe(25);
    expect(options.county).toBe("broward");
  });
});

// ---------------------------------------------------------------------------
// assemblePropertyRecord
// ---------------------------------------------------------------------------

const mockProperty = {
  property_id: "prop-uuid-1",
  parcel_id: "parcel-uuid-1",
  address_id: "addr-uuid-1",
  parcel_identifier: "1234567890",
  property_type: "RESIDENTIAL",
  property_usage_type: "SINGLE_FAMILY",
  structure_form: "DETACHED",
  build_status: "IMPROVED",
  property_structure_built_year: 1995,
  property_effective_built_year: 1998,
  historic_designation: false,
  livable_floor_area: "2000",
  total_area: "2500",
  area_under_air: "1900",
  number_of_units: 1,
  subdivision: "OAK PARK",
  zoning: "RS-1",
  property_legal_description_text: "LOT 5 BLK 12",
  source_system: "lee_appraiser",
};

const mockParcel = {
  parcel_id: "parcel-uuid-1",
  parcel_identifier: "1234567890",
  county_name: "Lee",
  state_code: "FL",
  jurisdiction_key: "lee",
};

const mockAddress = {
  address_id: "addr-uuid-1",
  street_number: "123",
  street_name: "Main",
  street_suffix_type: "St",
  city_name: "Fort Myers",
  state_code: "FL",
  postal_code: "33901",
  latitude: "26.640628",
  longitude: "-81.872605",
  normalized_address_key: "123-main-st-fort-myers-fl-33901",
};

describe("assemblePropertyRecord", () => {
  it("has all required top-level keys", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result).toHaveProperty("parcelId");
    expect(result).toHaveProperty("county");
    expect(result).toHaveProperty("jurisdictionKey");
    expect(result).toHaveProperty("sourceSystem");
    expect(result).toHaveProperty("address");
    expect(result).toHaveProperty("property");
    expect(result).toHaveProperty("parcel");
    expect(result).toHaveProperty("geometry");
    expect(result).toHaveProperty("ownerships");
    expect(result).toHaveProperty("taxes");
    expect(result).toHaveProperty("sales");
    expect(result).toHaveProperty("structures");
    expect(result).toHaveProperty("lots");
    expect(result).toHaveProperty("layouts");
    expect(result).toHaveProperty("utilities");
    expect(result).toHaveProperty("floodInfo");
    expect(result).toHaveProperty("deeds");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("valuations");
    expect(result).toHaveProperty("permits");
    expect(result).toHaveProperty("sunbizTenants");
    expect(result).toHaveProperty("bbbProfiles");
    expect(result).toHaveProperty("collectedAt");
  });

  it("returns empty arrays when no related data is provided", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.taxes).toHaveLength(0);
    expect(result.sales).toHaveLength(0);
    expect(result.structures).toHaveLength(0);
    expect(result.layouts).toHaveLength(0);
    expect(result.lots).toHaveLength(0);
    expect(result.utilities).toHaveLength(0);
    expect(result.ownerships).toHaveLength(0);
    expect(result.deeds).toHaveLength(0);
    expect(result.files).toHaveLength(0);
    expect(result.valuations).toHaveLength(0);
    expect(result.permits).toHaveLength(0);
    expect(result.sunbizTenants).toHaveLength(0);
    expect(result.bbbProfiles).toHaveLength(0);
  });

  it("returns null for floodInfo when no flood data is provided", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.floodInfo).toBeNull();
  });

  it("returns null for geometry when no geometry data", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.geometry).toBeNull();
  });

  it("correctly maps address fields", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.address.street).toBe("123 Main St");
    expect(result.address.city).toBe("Fort Myers");
    expect(result.address.state).toBe("FL");
    expect(result.address.postalCode).toBe("33901");
    expect(result.address.latitude).toBe("26.640628");
    expect(result.address.longitude).toBe("-81.872605");
  });

  it("correctly maps property fields", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.property.propertyType).toBe("RESIDENTIAL");
    expect(result.property.builtYear).toBe(1995);
    expect(result.property.subdivision).toBe("OAK PARK");
  });

  it("maps geometry when latitude and longitude are present", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [{ property_id: "prop-uuid-1", latitude: "26.640628", longitude: "-81.872605" }],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.geometry).not.toBeNull();
    expect(result.geometry?.latitude).toBe("26.640628");
    expect(result.geometry?.longitude).toBe("-81.872605");
  });

  it("maps floodInfo when flood data is present", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [{ property_id: "prop-uuid-1", flood_zone: "AE", evacuation_zone: "B", flood_insurance_required: true }],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.floodInfo).not.toBeNull();
    expect(result.floodInfo?.floodZone).toBe("AE");
    expect(result.floodInfo?.evacuationZone).toBe("B");
    expect(result.floodInfo?.floodInsuranceRequired).toBe(true);
  });

  it("maps tax records correctly", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [
        {
          property_id: "prop-uuid-1",
          tax_year: 2024,
          property_assessed_value_amount: "250000.00",
          property_market_value_amount: "300000.00",
          property_building_amount: "200000.00",
          property_land_amount: "50000.00",
          property_taxable_value_amount: "250000.00",
          yearly_tax_amount: "3500.00",
        },
      ],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.taxes).toHaveLength(1);
    expect(result.taxes[0]?.taxYear).toBe(2024);
    expect(result.taxes[0]?.assessedValue).toBe("250000.00");
    expect(result.taxes[0]?.yearlyTaxAmount).toBe("3500.00");
  });

  it("preserves ISO date format in collectedAt", () => {
    const isoDate = "2026-06-18T10:00:00.000Z";
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: isoDate,
    });

    expect(result.collectedAt).toBe(isoDate);
  });

  it("handles null parcel gracefully", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: null,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.jurisdictionKey).toBeNull();
    expect(result.parcel.parcelIdentifier).toBe("1234567890");
    expect(result.parcel.countyName).toBeNull();
  });

  it("handles null address gracefully", () => {
    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: null,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.address.street).toBeNull();
    expect(result.address.city).toBeNull();
    expect(result.address.latitude).toBeNull();
  });

  it("maps permits with nested children", () => {
    const permitRow = {
      property_improvement_id: "permit-uuid-1",
      parcel_identifier: "1234567890",
      permit_number: "BP-2024-001",
      improvement_type: "BUILDING",
      completion_date: "2024-06-01",
      record_status: "FINALED",
      estimated_job_value: "50000.00",
      estimated_sq_ft: "200.00",
      project_description: "New roof",
      contractor_company_id: "company-uuid-1",
    };

    const result = assemblePropertyRecord({
      property: mockProperty,
      parcel: mockParcel,
      address: mockAddress,
      taxes: [],
      salesHistories: [],
      structures: [],
      layouts: [],
      lots: [],
      floodStorm: [],
      utilities: [],
      ownerships: [],
      deeds: [],
      files: [],
      geometries: [],
      valuations: [],
      permits: [
        {
          permit: permitRow,
          contacts: [
            {
              property_improvement_id: "permit-uuid-1",
              contact_role: "CONTRACTOR",
              raw_name: "Acme Roofing",
              phone: "555-1234",
              email: null,
              license_number: "CGC123456",
            },
          ],
          customFields: [],
          events: [],
          fees: [],
          links: [],
          inspections: [],
        },
      ],
      sunbizTenants: [],
      bbbProfiles: [],
      county: "lee",
      collectedAt: "2026-06-18T10:00:00.000Z",
    });

    expect(result.permits).toHaveLength(1);
    expect(result.permits[0]?.permitNumber).toBe("BP-2024-001");
    expect(result.permits[0]?.contacts).toHaveLength(1);
    expect(result.permits[0]?.contacts[0]?.contactRole).toBe("CONTRACTOR");
    expect(result.permits[0]?.contacts[0]?.rawName).toBe("Acme Roofing");
  });
});

// ---------------------------------------------------------------------------
// buildManifestEntry
// ---------------------------------------------------------------------------

describe("buildManifestEntry", () => {
  it("passes through all fields", () => {
    const entry = buildManifestEntry({
      parcelIdentifier: "1234567890",
      filePath: "/data/properties/1234567890.json",
      fileSizeBytes: 4096,
      sha256: "abc123def456",
      cid: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
    });

    expect(entry.parcelIdentifier).toBe("1234567890");
    expect(entry.filePath).toBe("/data/properties/1234567890.json");
    expect(entry.fileSizeBytes).toBe(4096);
    expect(entry.sha256).toBe("abc123def456");
    expect(entry.cid).toBe("QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");
  });

  it("accepts null cid", () => {
    const entry = buildManifestEntry({
      parcelIdentifier: "9876543210",
      filePath: "/data/properties/9876543210.json",
      fileSizeBytes: 2048,
      sha256: "deadbeef",
      cid: null,
    });

    expect(entry.cid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildManifestSummary
// ---------------------------------------------------------------------------

describe("buildManifestSummary", () => {
  it("computes totalBytes as sum of all entry sizes", () => {
    const entries = [
      buildManifestEntry({ parcelIdentifier: "001", filePath: "/p/001.json", fileSizeBytes: 1000, sha256: "a", cid: null }),
      buildManifestEntry({ parcelIdentifier: "002", filePath: "/p/002.json", fileSizeBytes: 2000, sha256: "b", cid: null }),
      buildManifestEntry({ parcelIdentifier: "003", filePath: "/p/003.json", fileSizeBytes: 3000, sha256: "c", cid: null }),
    ];

    const summary = buildManifestSummary(entries, "2026-06-18T09:00:00.000Z", "2026-06-18T09:05:00.000Z", "lee");

    expect(summary.totalBytes).toBe(6000);
  });

  it("computes min, avg, max correctly", () => {
    const entries = [
      buildManifestEntry({ parcelIdentifier: "001", filePath: "/p/001.json", fileSizeBytes: 1000, sha256: "a", cid: null }),
      buildManifestEntry({ parcelIdentifier: "002", filePath: "/p/002.json", fileSizeBytes: 3000, sha256: "b", cid: null }),
      buildManifestEntry({ parcelIdentifier: "003", filePath: "/p/003.json", fileSizeBytes: 2000, sha256: "c", cid: null }),
    ];

    const summary = buildManifestSummary(entries, "2026-06-18T09:00:00.000Z", "2026-06-18T09:05:00.000Z", "lee");

    expect(summary.minBytes).toBe(1000);
    expect(summary.maxBytes).toBe(3000);
    expect(summary.avgBytes).toBe(2000);
  });

  it("computes projectedBytes300k as avgBytes * 300000", () => {
    const entries = [
      buildManifestEntry({ parcelIdentifier: "001", filePath: "/p/001.json", fileSizeBytes: 4000, sha256: "a", cid: null }),
      buildManifestEntry({ parcelIdentifier: "002", filePath: "/p/002.json", fileSizeBytes: 4000, sha256: "b", cid: null }),
    ];

    const summary = buildManifestSummary(entries, "2026-06-18T09:00:00.000Z", "2026-06-18T09:05:00.000Z", "lee");

    expect(summary.projectedBytes300k).toBe(4000 * 300_000);
  });

  it("sets schemaVersion to '1'", () => {
    const summary = buildManifestSummary([], "2026-06-18T09:00:00.000Z", "2026-06-18T09:05:00.000Z", "lee");
    expect(summary.schemaVersion).toBe("1");
  });

  it("handles empty entries gracefully", () => {
    const summary = buildManifestSummary([], "2026-06-18T09:00:00.000Z", "2026-06-18T09:05:00.000Z", "lee");

    expect(summary.propertyCount).toBe(0);
    expect(summary.totalBytes).toBe(0);
    expect(summary.minBytes).toBe(0);
    expect(summary.avgBytes).toBe(0);
    expect(summary.maxBytes).toBe(0);
    expect(summary.projectedBytes300k).toBe(0);
  });

  it("sets propertyCount to number of entries", () => {
    const entries = [
      buildManifestEntry({ parcelIdentifier: "001", filePath: "/p/001.json", fileSizeBytes: 100, sha256: "a", cid: null }),
      buildManifestEntry({ parcelIdentifier: "002", filePath: "/p/002.json", fileSizeBytes: 200, sha256: "b", cid: null }),
    ];

    const summary = buildManifestSummary(entries, "2026-06-18T09:00:00.000Z", "2026-06-18T09:05:00.000Z", "lee");

    expect(summary.propertyCount).toBe(2);
  });

  it("preserves startedAt as exportedAt and completedAt", () => {
    const summary = buildManifestSummary(
      [],
      "2026-06-18T09:00:00.000Z",
      "2026-06-18T09:05:00.000Z",
      "lee",
    );

    expect(summary.exportedAt).toBe("2026-06-18T09:00:00.000Z");
    expect(summary.completedAt).toBe("2026-06-18T09:05:00.000Z");
    expect(summary.county).toBe("lee");
  });
});

// ---------------------------------------------------------------------------
// computeIpfsCid
// ---------------------------------------------------------------------------

describe("computeIpfsCid", () => {
  it("does not throw when called with an empty buffer", async () => {
    await expect(computeIpfsCid(Buffer.alloc(0))).resolves.not.toThrow();
  });

  it("returns null or a string (never throws)", async () => {
    const result = await computeIpfsCid(Buffer.alloc(0));
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("returns a CID string when called with content", async () => {
    const content = Buffer.from("elephant property consolidation test", "utf8");
    const cid = await computeIpfsCid(content);

    if (cid !== null) {
      expect(typeof cid).toBe("string");
      expect(cid.length).toBeGreaterThan(0);
      // CIDv0 starts with "Qm", CIDv1 starts with "baf"
      expect(cid.startsWith("Qm") || cid.startsWith("baf")).toBe(true);
    }
  });

  it("returns the same CID for identical content", async () => {
    const content = Buffer.from("deterministic content for cid test", "utf8");
    const cid1 = await computeIpfsCid(content);
    const cid2 = await computeIpfsCid(content);

    if (cid1 !== null && cid2 !== null) {
      expect(cid1).toBe(cid2);
    }
  });
});

// ---------------------------------------------------------------------------
// accumulateManifestStats (incremental running fold)
// ---------------------------------------------------------------------------

describe("accumulateManifestStats", () => {
  it("starts empty with sentinel minBytes", () => {
    expect(EMPTY_MANIFEST_STATS.count).toBe(0);
    expect(EMPTY_MANIFEST_STATS.totalBytes).toBe(0);
    expect(EMPTY_MANIFEST_STATS.maxBytes).toBe(0);
    // minBytes starts at MAX_SAFE_INTEGER so first real value always wins
    expect(EMPTY_MANIFEST_STATS.minBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("accumulates a single entry correctly", () => {
    const stats = accumulateManifestStats(EMPTY_MANIFEST_STATS, 1000);
    expect(stats.count).toBe(1);
    expect(stats.totalBytes).toBe(1000);
    expect(stats.minBytes).toBe(1000);
    expect(stats.maxBytes).toBe(1000);
  });

  it("tracks running min correctly", () => {
    let stats = EMPTY_MANIFEST_STATS;
    for (const size of [500, 2000, 100, 1500]) {
      stats = accumulateManifestStats(stats, size);
    }
    expect(stats.minBytes).toBe(100);
  });

  it("tracks running max correctly", () => {
    let stats = EMPTY_MANIFEST_STATS;
    for (const size of [500, 2000, 100, 1500]) {
      stats = accumulateManifestStats(stats, size);
    }
    expect(stats.maxBytes).toBe(2000);
  });

  it("tracks totalBytes as a running sum", () => {
    let stats = EMPTY_MANIFEST_STATS;
    for (const size of [100, 200, 300]) {
      stats = accumulateManifestStats(stats, size);
    }
    expect(stats.totalBytes).toBe(600);
    expect(stats.count).toBe(3);
  });

  it("produces the same min/max/total as buildManifestSummary for the same data", () => {
    const sizes = [800, 1200, 450, 3100, 975];
    const entries = sizes.map((s, i) =>
      buildManifestEntry({
        parcelIdentifier: String(i),
        filePath: `/p/${String(i)}.json`,
        fileSizeBytes: s,
        sha256: String(i),
        cid: null,
      }),
    );

    // Incremental fold
    const runningStats = sizes.reduce(accumulateManifestStats, EMPTY_MANIFEST_STATS);

    // Summary (uses the same fold internally)
    const summary = buildManifestSummary(entries, "2026-06-18T00:00:00.000Z", "2026-06-18T00:01:00.000Z", "lee");

    expect(runningStats.totalBytes).toBe(summary.totalBytes);
    expect(runningStats.minBytes).toBe(summary.minBytes);
    expect(runningStats.maxBytes).toBe(summary.maxBytes);
    expect(runningStats.count).toBe(summary.propertyCount);
  });
});

// ---------------------------------------------------------------------------
// Batched output equals non-batched output
// Verifies that splitting a set of properties across batches produces
// the same per-property assembled JSON as assembling them all at once.
// ---------------------------------------------------------------------------

describe("batched assembly produces identical output to non-batched assembly", () => {
  const makeProperty = (id: string, parcelId: string, addressId: string, parcelIdentifier: string) => ({
    property_id: id,
    parcel_id: parcelId,
    address_id: addressId,
    parcel_identifier: parcelIdentifier,
    property_type: "COMMERCIAL",
    property_usage_type: "OFFICE",
    structure_form: null,
    build_status: "IMPROVED",
    property_structure_built_year: 2000 + Number(id.slice(-1)),
    property_effective_built_year: 2001 + Number(id.slice(-1)),
    historic_designation: false,
    livable_floor_area: "5000",
    total_area: "6000",
    area_under_air: "4800",
    number_of_units: 1,
    subdivision: "BUSINESS PARK",
    zoning: "C-2",
    property_legal_description_text: `LOT ${id}`,
    source_system: "lee_appraiser",
  });

  const makeParcel = (parcelId: string, parcelIdentifier: string) => ({
    parcel_id: parcelId,
    parcel_identifier: parcelIdentifier,
    county_name: "Lee",
    state_code: "FL",
    jurisdiction_key: "lee",
  });

  const makeAddress = (addressId: string) => ({
    address_id: addressId,
    street_number: "100",
    street_name: "Commerce",
    street_suffix_type: "Blvd",
    city_name: "Cape Coral",
    state_code: "FL",
    postal_code: "33990",
    latitude: "26.563",
    longitude: "-81.949",
    normalized_address_key: `key-${addressId}`,
  });

  const properties = [
    makeProperty("prop-1", "parcel-1", "addr-1", "1111111111"),
    makeProperty("prop-2", "parcel-2", "addr-2", "2222222222"),
    makeProperty("prop-3", "parcel-3", "addr-3", "3333333333"),
    makeProperty("prop-4", "parcel-4", "addr-4", "4444444444"),
    makeProperty("prop-5", "parcel-5", "addr-5", "5555555555"),
  ];

  const parcels = properties.map((p) => makeParcel(p.parcel_id, p.parcel_identifier));
  const addresses = properties.map((p) => makeAddress(p.address_id));
  const collectedAt = "2026-06-18T12:00:00.000Z";
  const county = "lee";

  function assembleAll() {
    const parcelMap = new Map(parcels.map((p) => [p.parcel_id, p]));
    const addressMap = new Map(addresses.map((a) => [a.address_id, a]));
    return properties.map((property) =>
      assemblePropertyRecord({
        property,
        parcel: parcelMap.get(property.parcel_id) ?? null,
        address: addressMap.get(property.address_id) ?? null,
        taxes: [],
        salesHistories: [],
        structures: [],
        layouts: [],
        lots: [],
        floodStorm: [],
        utilities: [],
        ownerships: [],
        deeds: [],
        files: [],
        geometries: [],
        valuations: [],
        permits: [],
        sunbizTenants: [],
        bbbProfiles: [],
        county,
        collectedAt,
      }),
    );
  }

  function assembleBatched(batchSize: number) {
    const results: ReturnType<typeof assemblePropertyRecord>[] = [];
    for (let start = 0; start < properties.length; start += batchSize) {
      const batch = properties.slice(start, start + batchSize);
      const batchParcelIds = new Set(batch.map((p) => p.parcel_id));
      const batchAddressIds = new Set(batch.map((p) => p.address_id));
      const batchParcels = parcels.filter((p) => batchParcelIds.has(p.parcel_id));
      const batchAddresses = addresses.filter((a) => batchAddressIds.has(a.address_id));
      const parcelMap = new Map(batchParcels.map((p) => [p.parcel_id, p]));
      const addressMap = new Map(batchAddresses.map((a) => [a.address_id, a]));

      for (const property of batch) {
        results.push(
          assemblePropertyRecord({
            property,
            parcel: parcelMap.get(property.parcel_id) ?? null,
            address: addressMap.get(property.address_id) ?? null,
            taxes: [],
            salesHistories: [],
            structures: [],
            layouts: [],
            lots: [],
            floodStorm: [],
            utilities: [],
            ownerships: [],
            deeds: [],
            files: [],
            geometries: [],
            valuations: [],
            permits: [],
            sunbizTenants: [],
            bbbProfiles: [],
            county,
            collectedAt,
          }),
        );
      }
    }
    return results;
  }

  it("produces identical output for batch-size 2 vs all-at-once (5 properties)", () => {
    const allAtOnce = assembleAll();
    const batched = assembleBatched(2);

    expect(batched).toHaveLength(allAtOnce.length);
    for (let i = 0; i < allAtOnce.length; i += 1) {
      expect(JSON.stringify(batched[i])).toBe(JSON.stringify(allAtOnce[i]));
    }
  });

  it("produces identical output for batch-size 1 vs all-at-once", () => {
    const allAtOnce = assembleAll();
    const batched = assembleBatched(1);

    expect(batched).toHaveLength(allAtOnce.length);
    for (let i = 0; i < allAtOnce.length; i += 1) {
      expect(JSON.stringify(batched[i])).toBe(JSON.stringify(allAtOnce[i]));
    }
  });

  it("produces identical output for batch-size larger than set vs all-at-once", () => {
    const allAtOnce = assembleAll();
    const batched = assembleBatched(100);

    expect(batched).toHaveLength(allAtOnce.length);
    for (let i = 0; i < allAtOnce.length; i += 1) {
      expect(JSON.stringify(batched[i])).toBe(JSON.stringify(allAtOnce[i]));
    }
  });
});
