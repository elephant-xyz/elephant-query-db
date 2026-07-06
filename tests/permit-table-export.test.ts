import { describe, expect, it } from "vitest";

import {
  buildPermitTableRow,
  buildPermitTableParquetSchema,
  permitSourcePrefixForCounty,
  type PermitTableSourceRow,
} from "../scripts/run-permit-table-export.js";

/**
 * Build a fully-null source row so each test can override only the fields it
 * exercises. Mirrors the `pg` result shape (numeric columns arrive as strings;
 * date columns are cast to ISO text in SQL).
 */
function sourceRow(overrides: Partial<PermitTableSourceRow>): PermitTableSourceRow {
  return {
    property_improvement_id: "pi-1",
    property_id: null,
    parcel_identifier: null,
    permit_number: null,
    improvement_type: null,
    improvement_status: null,
    improvement_action: null,
    permit_issue_date: null,
    application_received_date: null,
    final_inspection_date: null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: null,
    opened_date: null,
    source_system: null,
    county_name: null,
    project_description: null,
    description: null,
    estimated_job_value: null,
    fee: null,
    ...overrides,
  };
}

describe("permitSourcePrefixForCounty — anchored county prefix", () => {
  it("strips the trailing _appraiser to yield the county prefix", () => {
    expect(permitSourcePrefixForCounty("lee")).toBe("lee");
    expect(permitSourcePrefixForCounty("Lee")).toBe("lee");
  });

  it("normalizes multi-word counties to alnum+underscore", () => {
    expect(permitSourcePrefixForCounty("palm-beach")).toBe("palm_beach");
    expect(permitSourcePrefixForCounty("Palm Beach")).toBe("palm_beach");
  });

  it("yields a prefix that would NOT anchor-match a lookalike county (lee vs leesburg)", () => {
    // The export filters with `source_system ~ '^' || prefix || '_'`; the trailing
    // underscore requirement is what prevents "lee" matching "leesburg_appraiser".
    const prefix = permitSourcePrefixForCounty("lee");
    const anchored = new RegExp(`^${prefix}_`);
    expect(anchored.test("lee_appraiser")).toBe(true);
    expect(anchored.test("lee_accela")).toBe(true);
    expect(anchored.test("leesburg_appraiser")).toBe(false);
  });
});

describe("buildPermitTableRow — one row per permit", () => {
  it("passes the PK through and coerces the money columns to numbers", () => {
    const row = buildPermitTableRow(
      sourceRow({
        property_improvement_id: "pi-42",
        estimated_job_value: "12500.00",
        fee: "350.5",
      }),
    );

    expect(row.property_improvement_id).toBe("pi-42");
    expect(row.estimated_job_value).toBe(12500);
    expect(row.fee).toBe(350.5);
  });

  it("keeps ISO date text verbatim (already cast in SQL)", () => {
    const row = buildPermitTableRow(
      sourceRow({ completion_date: "2007-05-14", permit_issue_date: "2006-11-02" }),
    );

    expect(row.completion_date).toBe("2007-05-14");
    expect(row.permit_issue_date).toBe("2006-11-02");
  });

  it("normalizes empty/whitespace text and null money to null", () => {
    const row = buildPermitTableRow(
      sourceRow({ description: "  ", completion_date: null, fee: null }),
    );

    expect(row.description).toBeNull();
    expect(row.completion_date).toBeNull();
    expect(row.fee).toBeNull();
  });
});

describe("buildPermitTableParquetSchema — column typing", () => {
  it("stores the money columns as DOUBLE and dates as UTF8", () => {
    const schema = buildPermitTableParquetSchema();

    expect(schema.schema.estimated_job_value).toMatchObject({ type: "DOUBLE" });
    expect(schema.schema.fee).toMatchObject({ type: "DOUBLE" });
    expect(schema.schema.completion_date).toMatchObject({ type: "UTF8" });
  });

  it("keeps property_improvement_id as the required (non-optional) primary key", () => {
    const schema = buildPermitTableParquetSchema();

    expect(schema.schema.property_improvement_id).toMatchObject({ type: "UTF8" });
    expect(schema.schema.property_improvement_id?.optional).not.toBe(true);
  });
});
