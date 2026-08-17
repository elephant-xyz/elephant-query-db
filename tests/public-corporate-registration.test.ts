import { describe, expect, it } from "vitest";

import {
  PUBLIC_CORPORATE_COLUMNS,
  assertPublicCorporateRow,
  buildPublicCorporateRegistrationSql,
  buildPublicCorporateRow,
  buildPublicCorporateSchemaDocument,
  parsePublicCorporateExportOptions,
  type PublicCorporateRegistrationRow,
  type PublicCorporateSourceRow,
} from "../scripts/run-public-corporate-registration-export.js";
import {
  assertCorporatePublishEnvironment,
  corporatePublicationKeys,
} from "../scripts/upload-corporate-registration-to-filebase.js";
import { buildPublicCoverageSnapshot } from "../scripts/write-public-coverage-snapshot.js";

const SOURCE_ROW: PublicCorporateSourceRow = {
  illinois_file_number: "01234567",
  legal_company_name: "EXAMPLE ORGANIZATION INC",
  entity_type_code: "4",
  entity_type: "Domestic Business Corporation",
  entity_status_code: "00",
  entity_status: "Goodstanding",
  incorporation_date: "2020-01-02",
};

function publishEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    S3_ENDPOINT: "https://s3.filebase.com",
    S3_BUCKET: "elephant-oracle-corporate-registration-rock-island",
    S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret",
    FILEBASE_API_TOKEN: "test-token",
    FILEBASE_CORPORATE_IPNS_LABEL:
      "oracle-corporate-registration-rock-island",
    ...overrides,
  };
}

describe("public corporate registration export", () => {
  it("emits exactly the organization registry allowlist", () => {
    const row = buildPublicCorporateRow(SOURCE_ROW);
    expect(Object.keys(row).sort()).toEqual(
      [...PUBLIC_CORPORATE_COLUMNS].sort(),
    );
    expect(() => assertPublicCorporateRow(row)).not.toThrow();
    expect(row).toMatchObject({
      county_code: "081",
      county_scope_type: "registered_agent_office_county",
      snapshot_consistency: "mixed_date",
      statewide_intersection_coverage_percent: 99.9933,
    });
  });

  it("fails closed on an unexpected address or contact field", () => {
    const row = {
      ...buildPublicCorporateRow(SOURCE_ROW),
      street_address: "PRIVATE",
    } as PublicCorporateRegistrationRow;
    expect(() => assertPublicCorporateRow(row)).toThrow(/exact allowlist/u);

    expect(() =>
      assertPublicCorporateRow(
        buildPublicCorporateRow({
          ...SOURCE_ROW,
          legal_company_name: "contact@example.org",
        }),
      ),
    ).toThrow(/contact-like/u);
  });

  it("projects no property, appraisal, address value, or person field", () => {
    const sql = buildPublicCorporateRegistrationSql();
    const selectClause = sql.slice(0, sql.indexOf("FROM public"));
    expect(selectClause).not.toMatch(
      /(agent|officer|person|street|postal|email|phone|property|parcel|appraisal|payload|hash)/iu,
    );
    expect(sql).not.toMatch(/\b(parcels|properties)\b/iu);
    expect(sql).toContain("agentCountyCode");
  });

  it("publishes unavailable organization and dissolution dates as null", () => {
    expect(buildPublicCorporateRow(SOURCE_ROW)).toMatchObject({
      organization_date: null,
      dissolution_date: null,
    });
    expect(buildPublicCorporateSchemaDocument()).toMatchObject({
      primaryKey: "illinois_file_number",
    });
  });

  it("requires exact approved reconciliation inputs", () => {
    expect(
      parsePublicCorporateExportOptions([
        "--exported-at",
        "2026-08-14T17:23:49.000Z",
        "--expected-row-count",
        "11741",
        "--statewide-intersection-count",
        "1981254",
        "--statewide-source-count",
        "1981387",
        "--statewide-excluded-count",
        "133",
        "--excluded-county-081-count",
        "0",
      ]),
    ).toMatchObject({
      expectedRowCount: 11_741,
      excludedCounty081Count: 0,
    });
  });
});

describe("corporate publication isolation", () => {
  it("uses only a dedicated bucket, label, and corporate keys", () => {
    expect(() =>
      assertCorporatePublishEnvironment(publishEnv()),
    ).not.toThrow();
    expect(corporatePublicationKeys()).toEqual([
      "corporate-registrations/rock-island/corporate-registrations.parquet",
      "corporate-registrations/rock-island/corporate-registration-schema.json",
      "corporate-registrations/rock-island/manifest.json",
    ]);
    expect(corporatePublicationKeys().join("|")).not.toMatch(
      /properties|query-tables|dataset-coverage/iu,
    );
  });

  it("rejects property buckets and reserved IPNS labels", () => {
    expect(() =>
      assertCorporatePublishEnvironment(
        publishEnv({
          S3_BUCKET: "elephant-oracle-open-data-rock-island",
        }),
      ),
    ).toThrow(/dedicated bucket/u);
    expect(() =>
      assertCorporatePublishEnvironment(
        publishEnv({
          FILEBASE_CORPORATE_IPNS_LABEL:
            "oracle-open-data-rock-island",
        }),
      ),
    ).toThrow(/reserved/u);
  });
});

describe("corporate public coverage", () => {
  it("reports mixed-date publication count without claiming completeness", () => {
    const snapshot = buildPublicCoverageSnapshot(
      {
        county: "rock-island",
        appraisalCount: 65_806,
        corporateCount: 11_741,
        corporateCid: "bafy-corporate-manifest",
        corporateIpnsLabel:
          "oracle-corporate-registration-rock-island",
        corporateFirstSnapshotAt: "2026-07-28T00:00:00.000Z",
        corporateLastSnapshotAt: "2026-07-29T00:00:00.000Z",
        outputPath: "/tmp/coverage.json",
      },
      "2026-08-14T17:23:49.000Z",
    );
    expect(
      snapshot.datasets.find((dataset) => dataset.source === "corporate"),
    ).toEqual({
      county: "rock-island",
      source: "corporate",
      ingested_count: 11_741,
      expected_count: null,
      first_loaded_at: "2026-07-28T00:00:00.000Z",
      last_loaded_at: "2026-07-29T00:00:00.000Z",
      cid: "bafy-corporate-manifest",
      ipns_label: "oracle-corporate-registration-rock-island",
    });
    expect(
      snapshot.datasets.find((dataset) => dataset.source === "permits"),
    ).toMatchObject({ ingested_count: 0, expected_count: null });
    expect(
      snapshot.datasets.find((dataset) => dataset.source === "bbb"),
    ).toMatchObject({ ingested_count: 0, expected_count: null });
  });
});
