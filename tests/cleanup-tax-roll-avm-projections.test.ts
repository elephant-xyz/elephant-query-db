import { describe, expect, it } from "vitest";

import {
  TAX_ROLL_AVM_METHOD,
  buildTaxRollAvmCleanupSql,
  parseTaxRollAvmCleanupOptions,
} from "../scripts/cleanup-tax-roll-avm-projections.js";

describe("tax-roll AVM cleanup", () => {
  it("defaults to dry-run and requires an appraisal source system", () => {
    expect(
      parseTaxRollAvmCleanupOptions(["--source-system", "duval_appraiser"]),
    ).toEqual({
      apply: false,
      sourceSystem: "duval_appraiser",
    });
    expect(() => parseTaxRollAvmCleanupOptions([])).toThrow(/source-system/i);
    expect(() =>
      parseTaxRollAvmCleanupOptions(["--source-system", "attom_avm"]),
    ).toThrow(/apprais/i);
  });

  it("requires explicit --apply before generating a deletion", () => {
    expect(buildTaxRollAvmCleanupSql(false)).toContain("SELECT count(*)");
    expect(buildTaxRollAvmCleanupSql(false)).not.toContain("DELETE FROM");
    expect(buildTaxRollAvmCleanupSql(true)).toContain(
      "DELETE FROM property_valuations",
    );
  });

  it("scopes the cleanup to the known false valuation method", () => {
    expect(TAX_ROLL_AVM_METHOD).toBe(
      "LEE_APPRAISER_TAX_ROLL_JUST_VALUE",
    );
    expect(buildTaxRollAvmCleanupSql(true)).toContain(
      "valuation_method_type = $2",
    );
  });
});
