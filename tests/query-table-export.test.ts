import { describe, expect, it } from "vitest";

import {
  buildQueryTableRow,
  buildQueryTableParquetSchema,
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
