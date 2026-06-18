import { describe, expect, it } from "vitest";

import {
  assemblePropertyRecord,
  buildManifestEntry,
  buildManifestSummary,
  computeIpfsCid,
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
