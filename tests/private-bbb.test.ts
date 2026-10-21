import { readFileSync } from "node:fs";

import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  jaroWinklerSimilarity,
  normalizePrivateBbbBusinessName,
  normalizePrivateBbbLicense,
  normalizePrivateBbbPhone,
} from "../src/loader/private-bbb.js";
import {
  bbbArtifactWatermarks,
  bbbHarvestCategories,
  bbbHarvestRuns,
  bbbProfileCategoryMemberships,
  bbbProfileSnapshots,
  bbbPropertyLinkEvidence,
  bbbReconciliationMatches,
  bbbReconciliationRuns,
} from "../src/schema/private-bbb.js";

describe("private BBB schema", () => {
  it("keeps persistence in dedicated private tables", () => {
    expect(
      [
        bbbHarvestRuns,
        bbbHarvestCategories,
        bbbArtifactWatermarks,
        bbbProfileSnapshots,
        bbbProfileCategoryMemberships,
        bbbReconciliationRuns,
        bbbReconciliationMatches,
        bbbPropertyLinkEvidence,
      ].map(getTableName),
    ).toEqual([
      "bbb_harvest_runs",
      "bbb_harvest_categories",
      "bbb_artifact_watermarks",
      "bbb_profile_snapshots",
      "bbb_profile_category_memberships",
      "bbb_reconciliation_runs",
      "bbb_reconciliation_matches",
      "bbb_property_link_evidence",
    ]);
  });

  it("adds tables only and never cascades into legal identity", () => {
    const migration = readFileSync(
      "migrations/0012_private_bbb_persistence.sql",
      "utf8",
    );
    expect(migration).not.toContain('ALTER TABLE "companies"');
    expect(migration).not.toContain('ALTER TABLE "permit_contacts"');
    expect(migration).not.toContain('ALTER TABLE "property_improvements"');
    expect(migration).not.toMatch(/ON DELETE cascade/iu);
    expect(migration).not.toContain("lexicon");
    expect(migration).not.toContain("atlas");
  });
});

describe("private BBB identity normalization", () => {
  it("retains trade words for exact matching", () => {
    expect(normalizePrivateBbbBusinessName("Apex Roofing Services, LLC")).toBe(
      "APEX ROOFING SERVICES",
    );
    expect(
      normalizePrivateBbbBusinessName("Apex Roofing Services, LLC", {
        loose: true,
      }),
    ).toBe("APEX");
  });

  it("normalizes only valid phone and license identifiers", () => {
    expect(normalizePrivateBbbPhone("+1 (352) 555-0100")).toBe("3525550100");
    expect(normalizePrivateBbbPhone("555-0100")).toBeNull();
    expect(normalizePrivateBbbLicense("ccc-1332246")).toBe("CCC1332246");
    expect(normalizePrivateBbbLicense("unknown")).toBeNull();
  });

  it("ranks fuzzy names without promoting them to exact identity", () => {
    expect(
      jaroWinklerSimilarity("COVENANT CONSTRUCTION", "COVENANT CONSTRCTION"),
    ).toBeGreaterThanOrEqual(0.9);
    expect(jaroWinklerSimilarity("ALPHA", "OMEGA")).toBeLessThan(0.9);
  });
});
