import { describe, expect, it } from "vitest";

import { mapNormalizedCityPermit, buildNormalizedCityPermitSourceRecordKey } from "../src/loader/permits.js";
import { parseOptions } from "../scripts/run-permits-local-load.js";

describe("run-permits-local-load", () => {
  it("parses CLI options with Chester defaults", () => {
    expect(parseOptions(["--env-file", ".env.local", "--input", "permits.jsonl"])).toEqual({
      envFile: ".env.local",
      inputPath: "permits.jsonl",
      permitSourceSystem: "chester_permits",
      limit: null,
      dryRun: false,
    });
  });

  it("maps a West Chester normalized permit row", () => {
    const bundle = mapNormalizedCityPermit({
      artifactUri: "file:///tmp/normalized-permits.jsonl",
      sourceSystem: "chester_permits",
      record: {
        source_system: "westchester_permits",
        source_url:
          "https://bor-westchester-pa.smartgovcommunity.com/Public/ApplicationSearch/Detail/uuid",
        city: "West Chester Borough",
        permit_number: "190364",
        parcel_identifier: "1-4-124",
        work_location: "27 E MARSHALL ST, WEST CHESTER, PA",
        permit_issue_date: "2019-09-18",
        record_status: "Issued",
        record_type: "Residential Addition-Alteration-Repair",
        project_description: null,
        is_roof_permit: false,
        raw: { detail_id: "uuid", upi: "1-4-124" },
        request_identifier: "1-4-124",
      },
    });

    expect(bundle.skippedRecords).toEqual([]);
    expect(bundle.rows.map((row) => row.tableName)).toEqual([
      "addresses",
      "property_improvements",
    ]);
    const permit = bundle.rows.find((row) => row.tableName === "property_improvements");
    expect(permit?.values.source_system).toBe("chester_permits");
    expect(permit?.values.source_record_key).toBe(
      "chester_permits:permit:westchester_permits:uuid",
    );
    expect(permit?.references?.parcelSourceRecordKey).toBe(
      "chester_appraiser:1-4-124:parcel:property_seed",
    );
    expect(permit?.references?.propertySourceRecordKey).toBe(
      "chester_appraiser:1-4-124:property:property",
    );
  });

  it("disambiguates duplicate permit numbers with SmartGov detail ids", () => {
    const base = {
      source_system: "westchester_permits",
      permit_number: "25-0002",
      parcel_identifier: "1-9-127",
      request_identifier: "1-9-127",
      raw: { detail_id: "eb6fc3ec-17ae-4f77-8183-b2b801268154" },
    };
    const other = {
      ...base,
      parcel_identifier: "1-5-15",
      request_identifier: "1-5-15",
      raw: { detail_id: "658c9ff5-6079-41ff-8a4f-b25900d1d623" },
    };
    const left = buildNormalizedCityPermitSourceRecordKey(
      "chester_permits",
      "westchester_permits",
      "25-0002",
      base,
    );
    const right = buildNormalizedCityPermitSourceRecordKey(
      "chester_permits",
      "westchester_permits",
      "25-0002",
      other,
    );
    expect(left).not.toBe(right);
  });
});
