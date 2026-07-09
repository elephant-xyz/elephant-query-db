import { describe, expect, it } from "vitest";

import {
  coerceCount,
  normalizeCoverageRow,
} from "../scripts/write-oracle-dataset-coverage-snapshot.js";

describe("coerceCount", () => {
  it("parses bigint-as-text into a finite number", () => {
    expect(coerceCount("511695", 0)).toBe(511695);
    expect(coerceCount("2114833", 0)).toBe(2114833);
  });

  it("passes through numbers unchanged", () => {
    expect(coerceCount(2594, 0)).toBe(2594);
  });

  it("returns the fallback for null/undefined/non-numeric", () => {
    expect(coerceCount(null, 0)).toBe(0);
    expect(coerceCount(undefined, null)).toBeNull();
    expect(coerceCount("not-a-number", 0)).toBe(0);
    expect(coerceCount("", null)).toBeNull();
  });
});

describe("normalizeCoverageRow", () => {
  it("coerces bigint-as-text counts to numbers so the MCP number schema accepts them", () => {
    const normalized = normalizeCoverageRow({
      county: "lee",
      source: "appraisal",
      ingested_count: "511695",
      expected_count: null,
      first_loaded_at: "2026-06-24 12:30:39.729437+00",
      last_loaded_at: "2026-06-25 00:47:41.48735+00",
      cid: null,
      ipns_label: null,
    });

    expect(normalized.ingested_count).toBe(511695);
    expect(typeof normalized.ingested_count).toBe("number");
    expect(normalized.expected_count).toBeNull();
    expect(normalized.source).toBe("appraisal");
    expect(normalized.first_loaded_at).toBe("2026-06-24 12:30:39.729437+00");
  });

  it("coerces a string expected_count and preserves cid/ipns_label", () => {
    const normalized = normalizeCoverageRow({
      county: "orange",
      source: "permits",
      ingested_count: "612465",
      expected_count: "700000",
      first_loaded_at: null,
      last_loaded_at: null,
      cid: "bafycid",
      ipns_label: "oracle-permit-table-orange",
    });

    expect(normalized.ingested_count).toBe(612465);
    expect(normalized.expected_count).toBe(700000);
    expect(normalized.cid).toBe("bafycid");
    expect(normalized.ipns_label).toBe("oracle-permit-table-orange");
  });

  it("defaults a missing ingested_count to 0", () => {
    const normalized = normalizeCoverageRow({
      county: "lee",
      source: "bbb",
      ingested_count: null,
      expected_count: null,
      first_loaded_at: null,
      last_loaded_at: null,
      cid: null,
      ipns_label: null,
    });

    expect(normalized.ingested_count).toBe(0);
  });
});
