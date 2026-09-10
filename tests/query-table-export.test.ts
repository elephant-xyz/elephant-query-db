import { describe, expect, it } from "vitest";

import {
  applyManifestEnrichment,
  buildQueryTableRow,
  buildQueryTableParquetSchema,
  buildQueryTableSql,
  includePaDosEnrichmentInQueryTable,
  includeSunbizBbbEnrichmentInQueryTable,
  type QueryTableSourceRow,
} from "../scripts/run-query-table-export.js";

/**
 * Build a fully-null source row so each test can override only the fields it
 * exercises. Mirrors the `pg` result shape (numeric columns arrive as strings).
 */
function sourceRow(overrides: Partial<QueryTableSourceRow>): QueryTableSourceRow {
  return {
    property_id: "p1",
    folio: "10603861",
    request_identifier: "10603861",
    parcel_identifier: "10603861",
    source_system: "lee_appraiser",
    county_name: "Lee",
    state_code: "FL",
    street_number: null,
    street_name: null,
    street_suffix_type: null,
    city_name: null,
    postal_code: null,
    unit_identifier: null,
    unnormalized_address: null,
    situs_full_address: null,
    latitude: null,
    longitude: null,
    lot_size_acre: null,
    lot_area_sqft: null,
    exterior_wall_material: null,
    roof_covering_material: null,
    property_type: null,
    property_usage_type: null,
    built_year: null,
    livable_floor_area: null,
    total_area: null,
    layout_livable_area_sq_ft: null,
    layout_area_under_air_sq_ft: null,
    assessed_value: null,
    market_value: null,
    land_value: null,
    avm_value: null,
    owner_name: null,
    owners_text: null,
    owner_count: null,
    owner_occupied: null,
    last_sale_date: null,
    last_sale_price: null,
    subdivision: null,
    has_permits: null,
    permit_count: null,
    has_sunbiz_tenant: null,
    has_bbb_contractor: null,
    has_pa_corp_tenant: null,
    ...overrides,
  };
}

describe("query table living-area (Sq Ft) sourcing", () => {
  // Regression: the property-level `properties.livable_floor_area` column is
  // unused (0 non-null for every county). The building Sq Ft NEO displays lives
  // in `layouts` (livable_area_sq_ft for Lee, area_under_air_sq_ft for Palm
  // Beach), so the export must source the parquet column from the layout
  // aggregate — otherwise the parquet ships an all-null Sq Ft column.
  it("fills livable_floor_area from the layouts livable_area_sq_ft aggregate (Lee)", () => {
    const row = buildQueryTableRow(
      sourceRow({ livable_floor_area: null, layout_livable_area_sq_ft: "4494" }),
      null,
    );

    expect(row.livable_floor_area).toBe(4494);
  });

  it("falls back to area_under_air_sq_ft when livable area is absent (Palm Beach)", () => {
    const row = buildQueryTableRow(
      sourceRow({
        layout_livable_area_sq_ft: null,
        layout_area_under_air_sq_ft: "1670",
      }),
      null,
    );

    expect(row.livable_floor_area).toBe(1670);
  });

  it("prefers a populated property column over the layout aggregate", () => {
    const row = buildQueryTableRow(
      sourceRow({ livable_floor_area: "3200", layout_livable_area_sq_ft: "4494" }),
      null,
    );

    expect(row.livable_floor_area).toBe(3200);
  });

  it("leaves livable_floor_area null when no layout area exists (Miami-Dade gap)", () => {
    const row = buildQueryTableRow(sourceRow({}), null);

    expect(row.livable_floor_area).toBeNull();
  });

  it("keeps livable_floor_area as a DOUBLE parquet column", () => {
    const schema = buildQueryTableParquetSchema();

    expect(schema.schema.livable_floor_area).toMatchObject({ type: "DOUBLE" });
    expect(schema.schema.elephant_uuid).toMatchObject({ type: "UTF8" });
    expect(schema.schema.elephant_token).toMatchObject({ type: "UTF8" });
  });

  it("mints address:v1 elephant ids from situs street, Oracle state, and ZIP5", () => {
    const row = buildQueryTableRow(
      sourceRow({
        situs_full_address: "11659 JONATHAN RD, JACKSONVILLE, FL 32225",
        state_code: "FL",
      }),
      null,
    );

    expect(row.address_street).toBe("11659 JONATHAN RD");
    expect(row.address_zip).toBe("32225");
    expect(row.elephant_uuid).toBe("c3a982a7-1102-50b8-b2cd-6cb3fca2060f");
    expect(row.elephant_token).toBe(
      "da5b90e067f162ea35eb482befaea835b32df7861adb282c6fb3983f17fa325e",
    );
  });

  it("does not mix owner-mailing unit or ZIP into the situs identity", () => {
    const row = buildQueryTableRow(
      sourceRow({
        situs_full_address: "11659 JONATHAN RD, JACKSONVILLE, FL 32225",
        state_code: "FL",
        street_number: "1",
        street_name: "MAILING",
        street_suffix_type: "ST",
        postal_code: "10001",
        unit_identifier: "APT 2",
      }),
      null,
    );

    expect(row.address_street).toBe("11659 JONATHAN RD");
    expect(row.address_zip).toBe("32225");
    expect(row.elephant_uuid).toBe("c3a982a7-1102-50b8-b2cd-6cb3fca2060f");
    expect(row.elephant_token).toBe(
      "da5b90e067f162ea35eb482befaea835b32df7861adb282c6fb3983f17fa325e",
    );
  });
});

describe("query table enrichment scope", () => {
  it("includes Sunbiz/BBB joins only for Florida oracle counties", () => {
    expect(includeSunbizBbbEnrichmentInQueryTable("lee")).toBe(true);
    expect(includeSunbizBbbEnrichmentInQueryTable("broward")).toBe(true);
    expect(includeSunbizBbbEnrichmentInQueryTable("chester")).toBe(false);
    expect(includeSunbizBbbEnrichmentInQueryTable("santa-clara")).toBe(false);
  });

  it("includes PA DOS joins only for Chester", () => {
    expect(includePaDosEnrichmentInQueryTable("chester")).toBe(true);
    expect(includePaDosEnrichmentInQueryTable("lee")).toBe(false);
  });

  it("emits pa_dos_keys CTE for Chester without Sunbiz scans", () => {
    const sql = buildQueryTableSql("chester_appraiser", false, true, null);
    expect(sql).toContain("pa_dos_keys");
    expect(sql).toContain("has_pa_corp_tenant");
    expect(sql).not.toContain("unit_identifier");
    expect(sql).not.toContain("sunbiz_keys");
  });

  it("counts permits by property_id FK and excludes same-source appraisal improvements", () => {
    const sql = buildQueryTableSql("chester_appraiser", false, true, null);
    expect(sql).toContain("pi.source_system <> cp.source_system");
    expect(sql).toContain("pi.property_id = cp.property_id");
    expect(sql).toContain("LEFT JOIN permit_counts pc ON pc.property_id = p.property_id");
    expect(sql).not.toContain("LEFT JOIN permit_counts pc ON pc.parcel_identifier");
  });

  it("uses consolidation flags so query rows match their property CIDs", () => {
    const row = applyManifestEnrichment(
      sourceRow({
        has_sunbiz_tenant: false,
        has_bbb_contractor: false,
      }),
      {
        cid: "QmExample",
        hasSunbizTenant: true,
        hasBbbContractor: true,
      },
    );

    expect(row.has_sunbiz_tenant).toBe(true);
    expect(row.has_bbb_contractor).toBe(true);
  });
});
