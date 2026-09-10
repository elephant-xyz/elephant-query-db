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
    unnormalized_address: null,
    situs_full_address: null,
    latitude: null,
    longitude: null,
    lot_size_acre: null,
    lot_area_sqft: null,
    exterior_wall_material: null,
    roof_covering_material: null,
    roof_date: null,
    roof_age_years: null,
    roof_date_source: null,
    roof_date_lineage: null,
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
  });
});

describe("query table roof-date contract", () => {
  it("emits roof date, age, source, and lineage as scalar parquet fields", () => {
    const lineage = JSON.stringify({
      schemaVersion: "elephant.roof-date-lineage.v1",
      currentSource: "permit",
      currentRoofDate: "2023-06-15",
    });
    expect(
      buildQueryTableRow(
        sourceRow({
          roof_date: "2023-06-15",
          roof_age_years: "3",
          roof_date_source: "permit",
          roof_date_lineage: lineage,
        }),
        null,
      ),
    ).toMatchObject({
      roof_date: "2023-06-15",
      roof_age_years: 3,
      roof_date_source: "permit",
      roof_date_lineage: lineage,
    });

    const schema = buildQueryTableParquetSchema();
    expect(schema.schema.roof_date).toMatchObject({ type: "UTF8" });
    expect(schema.schema.roof_age_years).toMatchObject({ type: "INT64" });
    expect(schema.schema.roof_date_source).toMatchObject({ type: "UTF8" });
    expect(schema.schema.roof_date_lineage).toMatchObject({ type: "UTF8" });
  });

  it("surfaces the canonical roof state already resolved by ingest", () => {
    const sql = buildQueryTableSql("duval_appraiser", false, false, null);
    expect(sql).toContain("sp.roof_date AS roof_date");
    expect(sql).toContain("sp.roof_age_years AS roof_age_years");
    expect(sql).toContain("sp.roof_date_source AS roof_date_source");
    expect(sql).toContain(
      "sp.roof_date_lineage::text AS roof_date_lineage",
    );
    expect(sql).not.toContain("age(current_date");
    expect(sql).not.toContain("LEFT JOIN roof_resolved");
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
