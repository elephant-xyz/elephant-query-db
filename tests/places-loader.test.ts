import { describe, expect, it } from "vitest";

import {
  assertApprovedPlaceDatasets,
  expandOverturePlaceRecords,
  mapOverturePlace,
  mapOverturePlaceExtraction,
  parsePlacesDeactivationManifest,
} from "../src/loader/places.js";
import { PUBLIC_COVERAGE_ENRICHMENT_TRACKS } from "../scripts/write-public-coverage-snapshot.js";
import {
  COVERAGE_SOURCES,
  GLOBAL_COVERAGE_SOURCES,
  countySlugFromArtifactUri,
  isGlobalCoverageSource,
} from "../scripts/oracle-dataset-coverage-upsert.js";

const SAMPLE_PLACE = {
  record_kind: "overture_place",
  gers_id: "08f44a6a-1111-2222-3333-444444444444",
  county_key: "lee",
  county_fips: "12071",
  name_primary: "Example Salon",
  taxonomy_primary: "nail_salon",
  taxonomy_hierarchy: ["beauty_and_spa", "nail_salon"],
  taxonomy_hierarchy_path: "beauty_and_spa/nail_salon",
  taxonomy_alternate: ["beauty_salon"],
  basic_category: "salon",
  legacy_category_primary: "nail_salon",
  operating_status: "open",
  confidence: 0.91,
  address_freeform: "123 Main St",
  address_locality: "Fort Myers",
  address_region: "FL",
  address_postcode: "33901",
  address_country: "US",
  longitude: -81.87,
  latitude: 26.64,
  overture_release: "2026-07-22.0",
  is_hosted_service: false,
  sources: [
    { dataset: "meta", record_id: "m1", confidence: 0.9 },
    { dataset: "foursquare", record_id: "fsq1" },
  ],
};

describe("Overture places loader mapping", () => {
  it("maps a place into location, address, categories, and sources without companies", () => {
    const bundle = mapOverturePlace({
      record: SAMPLE_PLACE,
      artifactUri: "s3://bucket/overture-places/lee/2026-07-22.0/places/places-part-0001.jsonl",
    });
    expect(bundle.skippedRecords).toEqual([]);
    expect(bundle.rows.map((row) => row.tableName)).toEqual([
      "addresses",
      "business_locations",
      "business_location_categories",
      "business_location_categories",
      "business_location_sources",
      "business_location_sources",
    ]);
    const location = bundle.rows.find((row) => row.tableName === "business_locations");
    expect(location?.values.company_id).toBeUndefined();
    expect(location?.values.source_system).toBe("overture_places");
    expect(location?.values.source_record_key).toBe(
      "overture_places:08f44a6a-1111-2222-3333-444444444444",
    );
    expect(location?.values.taxonomy_hierarchy).toEqual(["beauty_and_spa", "nail_salon"]);
    expect(location?.values.first_seen_release).toBe("2026-07-22.0");
    expect(location?.values.is_current).toBe(true);
    expect(location?.values.basic_category).toBe("salon");
    expect(location?.references?.addressSourceRecordKey).toBeTruthy();
    expect(bundle.rows.some((row) => row.tableName === "companies")).toBe(false);
  });

  it("maps an extract summary into overture_place_extractions", () => {
    const bundle = mapOverturePlaceExtraction({
      record: {
        county: "lee",
        countyFips: "12071",
        overtureRelease: "2026-07-22.0",
        boundarySource: "tiger/tl_2024_us_county",
        tigerYear: "2024",
        bboxCount: 41200,
        clipCount: 40190,
        distinctTaxonomyPrimary: 1200,
        distinctSourceDatasets: ["meta", "foursquare"],
        licenceGate: { passed: true },
        extractionLocation: "laptop",
      },
      artifactUri: "s3://bucket/overture-places/lee/2026-07-22.0/manifest/summary.json",
    });
    expect(bundle.rows).toHaveLength(1);
    expect(bundle.rows[0]?.tableName).toBe("overture_place_extractions");
    expect(bundle.rows[0]?.values.clip_count).toBe(40190);
    expect(bundle.rows[0]?.values.licence_gate_passed).toBe(true);
  });

  it("skips summary envelopes when expanding place records", () => {
    expect(
      expandOverturePlaceRecords({ schemaVersion: "v1", clipCount: 10, county: "lee" }),
    ).toEqual([]);
    expect(expandOverturePlaceRecords(SAMPLE_PLACE)).toEqual([SAMPLE_PLACE]);
  });
});

describe("places licence gate helper", () => {
  it("passes approved providers and fails osm", () => {
    expect(assertApprovedPlaceDatasets(["meta", "foursquare"]).passed).toBe(true);
    expect(assertApprovedPlaceDatasets(["Overture", "Overture-signals"]).passed).toBe(true);
    expect(assertApprovedPlaceDatasets(["osm"]).passed).toBe(false);
    expect(assertApprovedPlaceDatasets(["osm"]).osmPresent).toBe(true);
    expect(assertApprovedPlaceDatasets(["not-a-provider"]).passed).toBe(false);
  });
});

describe("places incremental refresh", () => {
  it("accepts only explicit removed and moved-out deactivations", () => {
    expect(
      parsePlacesDeactivationManifest({
        schemaVersion: "overture-places-deactivation/v1",
        county: "lee",
        release: "2026-08-19.0",
        records: [
          { gersId: "removed-1", reason: "removed" },
          { gersId: "moved-1", reason: "moved_out" },
        ],
      }),
    ).toMatchObject({
      county: "lee",
      records: [
        { gersId: "removed-1", reason: "removed" },
        { gersId: "moved-1", reason: "moved_out" },
      ],
    });
  });

  it("rejects absence-based and duplicate deactivations", () => {
    expect(() =>
      parsePlacesDeactivationManifest({
        schemaVersion: "overture-places-deactivation/v1",
        county: "lee",
        release: "2026-08-19.0",
        records: [{ gersId: "missing-1", reason: "absent" }],
      }),
    ).toThrow(/invalid/);
    expect(() =>
      parsePlacesDeactivationManifest({
        schemaVersion: "overture-places-deactivation/v1",
        county: "lee",
        release: "2026-08-19.0",
        records: [
          { gersId: "duplicate-1", reason: "removed" },
          { gersId: "duplicate-1", reason: "moved_out" },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it("hard-stops mapping before load when a changed row contains OSM", () => {
    expect(() =>
      mapOverturePlace({
        artifactUri: "s3://internal/places.jsonl",
        record: {
          gers_id: "gers-osm",
          overture_release: "2026-08-19.0",
          county_key: "lee",
          sources: [{ dataset: "OpenStreetMap" }],
        },
      }),
    ).toThrow(/licence gate FAILED/);
  });
});

describe("overture_places coverage source", () => {
  it("registers overture_places as a global source with one spelling", () => {
    expect(COVERAGE_SOURCES).toEqual([
      "appraisal",
      "permits",
      "sunbiz",
      "bbb",
      "overture_places",
    ]);
    expect(GLOBAL_COVERAGE_SOURCES).toContain("overture_places");
    expect(isGlobalCoverageSource("overture_places")).toBe(true);
    expect(
      countySlugFromArtifactUri(
        "overture_places",
        "s3://bucket/overture-places/lee/2026-07-22.0/places/places-part-0001.jsonl",
      ),
    ).toBe("lee");
  });

  it("emits overture_places in the public snapshot enrichment list with null expected_count", () => {
    expect(PUBLIC_COVERAGE_ENRICHMENT_TRACKS).toEqual([
      "permits",
      "corporate",
      "bbb",
      "overture_places",
    ]);
  });
});
