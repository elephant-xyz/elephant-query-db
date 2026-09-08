import { describe, expect, it } from "vitest";

import {
  assertRegisteredApprovedAvmSource,
  mapApprovedAvmRecord,
  type ApprovedAvmSource,
} from "../src/loader/avm.js";

const approval: ApprovedAvmSource = {
  sourceProfileId: "attom-duval-v1",
  provider: "ATTOM",
  countyFips: "12031",
  licenseReviewReference: "contract-review:approved-123",
  publicationPermitted: true,
  publicationApprovedAt: "2026-09-08T16:00:00.000Z",
  sourceManifestSha256: "a".repeat(64),
  sourceRecordsSha256: "b".repeat(64),
};

const record = {
  request_identifier: "1646340000",
  parcel_identifier: "164634-0000",
  vendor_apn: "1646340000",
  county_fips: "12031",
  current_avm_value: 231_000,
  valuation_date: "2026-08-15",
  valuation_method_type: "attom-avm",
  confidence_score: 85,
  valuation_low: 218_000,
  valuation_high: 245_000,
  vendor_property_id: "vendor-1",
};

describe("approved AVM loader", () => {
  it("has no production source registered before contract approval", () => {
    expect(() => assertRegisteredApprovedAvmSource(approval)).toThrow(
      /not registered/i,
    );
  });

  it("maps a licensed exact-APN valuation with immutable approval provenance", () => {
    const row = mapApprovedAvmRecord({
      record,
      approval,
      artifactUri: "s3://approved/duval-avm.jsonl",
      sourceSystem: "attom_avm",
      propertySourceSystem: "duval_appraiser",
    });

    expect(row.tableName).toBe("property_valuations");
    expect(row.references?.propertySourceRecordKey).toBe(
      "duval_appraiser:1646340000:property:property",
    );
    expect(row.values).toMatchObject({
      source_system: "attom_avm",
      source_record_key: "attom_avm:12031:vendor-1:2026-08-15",
      request_identifier: "1646340000",
      provider: "ATTOM",
      vendor_property_id: "vendor-1",
      county_fips: "12031",
      source_profile_id: "attom-duval-v1",
      publication_permitted: true,
      current_avm_value: 231_000,
      confidence_score: 85,
      low_value: 218_000,
      high_value: 245_000,
    });
  });

  it("rejects unapproved publication and incomplete provenance", () => {
    expect(() =>
      mapApprovedAvmRecord({
        record,
        approval: { ...approval, publicationPermitted: false },
        artifactUri: null,
        sourceSystem: "attom_avm",
        propertySourceSystem: "duval_appraiser",
      }),
    ).toThrow(/publication approval/i);
    expect(() =>
      mapApprovedAvmRecord({
        record,
        approval: { ...approval, sourceManifestSha256: "not-a-digest" },
        artifactUri: null,
        sourceSystem: "attom_avm",
        propertySourceSystem: "duval_appraiser",
      }),
    ).toThrow(/sourceManifestSha256/i);
  });

  it("rejects FIPS/APN disagreement and appraiser-value substitution", () => {
    for (const candidate of [
      { ...record, county_fips: "12086" },
      { ...record, request_identifier: "0969250000" },
      { ...record, vendor_apn: "0969250000" },
      { ...record, valuation_method_type: "appraisal_market_value" },
    ]) {
      expect(() =>
        mapApprovedAvmRecord({
          record: candidate,
          approval,
          artifactUri: null,
          sourceSystem: "attom_avm",
          propertySourceSystem: "duval_appraiser",
        }),
      ).toThrow();
    }
  });

  it("requires confidence and coherent valuation bounds", () => {
    for (const candidate of [
      { ...record, confidence_score: null },
      { ...record, valuation_low: 240_000 },
      { ...record, valuation_high: 220_000 },
    ]) {
      expect(() =>
        mapApprovedAvmRecord({
          record: candidate,
          approval,
          artifactUri: null,
          sourceSystem: "attom_avm",
          propertySourceSystem: "duval_appraiser",
        }),
      ).toThrow();
    }
  });
});
