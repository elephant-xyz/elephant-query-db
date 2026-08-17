import { describe, expect, it } from "vitest";

import {
  buildRockIslandCompanyLocationEvidenceSql,
  parseConfidenceOptions,
} from "../scripts/report-rock-island-company-location-confidence.js";
import { aggregateIllinoisSosLocationConfidence } from "../src/loader/index.js";

describe("private Illinois SOS company-location confidence", () => {
  it("assigns each company/property pair only to its strongest tier", () => {
    const report = aggregateIllinoisSosLocationConfidence([
      evidence("A", "P1", "H1", "registered_agent_office", false, "alpha"),
      evidence("A", "P1", "H1", "registered_agent_office", true, "alpha"),
      evidence("A", "P3", "H3", "registered_agent_office", false, "alpha"),
      evidence("B", "P1", "H1", "entity_principal", false, "shared"),
      evidence("C", "P2", "H2", "registered_agent_office", false, "charlie"),
      evidence("D", "P2", "H2", "registered_agent_office", false, "shared"),
    ]);

    expect(report.tiers).toEqual({
      high: {
        matchCount: 1,
        uniqueCompanyCount: 1,
        uniquePropertyCount: 1,
      },
      low: {
        matchCount: 3,
        uniqueCompanyCount: 3,
        uniquePropertyCount: 2,
      },
      medium: {
        matchCount: 1,
        uniqueCompanyCount: 1,
        uniquePropertyCount: 1,
      },
    });
    expect(report.collisions).toEqual({
      addressHashesWithMultipleCompanies: 2,
      addressHashesWithMultipleProperties: 0,
      companiesWithMultipleProperties: 1,
      normalizedNamesWithMultipleCompanies: 1,
      propertiesWithMultipleCompanies: 2,
    });
  });

  it("keeps agent-office-only evidence explicitly low confidence", () => {
    const report = aggregateIllinoisSosLocationConfidence([
      evidence("A", "P1", "H1", "registered_agent_office", false, null),
    ]);

    expect(report.tiers.low.matchCount).toBe(1);
    expect(report.tiers.medium.matchCount).toBe(0);
    expect(report.tiers.high.matchCount).toBe(0);
    expect(report.evidenceRules.low).toMatch(/not an operating location/u);
  });

  it("uses a read-only aggregate evidence query", () => {
    const sql = buildRockIslandCompanyLocationEvidenceSql();

    expect(sql).toContain("br.source_system = 'illinois_sos'");
    expect(sql).toContain("p.source_system = 'rock_island_appraiser'");
    expect(sql).toContain("exact_permit_business_corroboration");
    expect(sql).not.toMatch(/\b(?:DELETE|INSERT|UPDATE|TRUNCATE)\b/u);
  });

  it("accepts only an optional aggregate JSON output", () => {
    expect(parseConfidenceOptions([])).toEqual({ outputPath: null });
    expect(parseConfidenceOptions(["--output", "/tmp/report.json"])).toEqual({
      outputPath: "/tmp/report.json",
    });
    expect(() => parseConfidenceOptions(["--private-rows"])).toThrow(/Usage/u);
  });
});

function evidence(
  companyKey: string,
  propertyKey: string,
  normalizedAddressHash: string,
  addressRole: string,
  exactPermitBusinessCorroboration: boolean,
  normalizedCompanyName: string | null,
) {
  return {
    addressRole,
    companyKey,
    exactPermitBusinessCorroboration,
    normalizedAddressHash,
    normalizedCompanyName,
    propertyKey,
  };
}
