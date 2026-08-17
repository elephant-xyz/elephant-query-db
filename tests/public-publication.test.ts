import { describe, expect, it } from "vitest";

import {
  assertRockIslandArcGisOutFields,
  assertPublicNonPii,
  parsePublicPropertyOptions,
  sourceSystemForCounty,
} from "../scripts/run-public-property-export.js";
import {
  buildPublicQueryTableRow,
  readVerifiedGeometryCoordinate,
  type PublicQueryTableSourceRow,
} from "../scripts/run-public-query-table-export.js";
import {
  buildPublicCoverageSnapshot,
} from "../scripts/write-public-coverage-snapshot.js";
import {
  assertPublishedCoverageTrack,
  buildValuationCountByFolioSql,
  countSourceClasses,
  selectDeterministicSample,
} from "../scripts/validate-publication-dry-run.js";
import {
  buildExactMultiPolygon,
  canonicalJsonSha256,
  geometrySourceRecordKey,
  readSourcePolygons,
} from "../scripts/public-geometry.js";
import {
  buildMissingGeometryInsertSql,
  geometryPayloadNeedsRepair,
  isGeometrySidecar,
  parseGeometryRepairOptions,
} from "../scripts/repair-rock-island-geometry-source-payload.js";
import {
  parsePreExportOptions,
  selectPreExportSample,
} from "../scripts/validate-rock-island-pre-export.js";
import {
  assertPropertyCheckpointCid,
  assertRemoteIndexAgreement,
} from "../scripts/upload-consolidation-to-filebase.js";
import { computeIpfsCid } from "../scripts/run-property-consolidation-export.js";

describe("public property export safety", () => {
  it("rejects denied PII recursively inside source payload", () => {
    expect(() =>
      assertPublicNonPii({
        sourcePayload: {
          response: {
            features: [{ attributes: { taxbill_name: "PRIVATE" } }],
          },
        },
      }),
    ).toThrow(/Denied public-data field/u);
  });

  it("accepts appraisal-only property and geometry provenance", () => {
    expect(() =>
      assertPublicNonPii({
        requestIdentifier: "1710408032",
        sourcePayload: { response: { features: [] } },
        parcelPolygon: { type: "MultiPolygon", coordinates: [] },
      }),
    ).not.toThrow();
  });

  it.each([
    "owner1_name",
    "purchased_email_primary",
    "purchased_phone_mobile",
    "contact_suppression_reason",
    "campaign_history_2026",
    "owner_responses_latest",
  ])("rejects nested private family %s", (privateKey) => {
    expect(() =>
      assertPublicNonPii({
        sourcePayload: {
          nested: {
            [privateKey]: "PRIVATE",
          },
        },
      }),
    ).toThrow(/Denied public-data field/u);
  });

  it("allows nested non-PII taxbill_year", () => {
    expect(() =>
      assertPublicNonPii({
        sourcePayload: {
          response: {
            features: [{ properties: { taxbill_year: 2025 } }],
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    "taxbill_name",
    "taxbill_addr",
    "taxbill_addr1",
    "taxbill_csz",
    "Taxbill_CS",
    "Taxbill_zip",
    "TAXBILL_NAME",
    "taxbill_unrecognized",
  ])("rejects restricted or unrecognized taxbill field %s", (privateKey) => {
    expect(() =>
      assertPublicNonPii({
        nested: {
          deeper: {
            [privateKey]: "PRIVATE",
          },
        },
      }),
    ).toThrow(/Denied public-data field/u);
  });

  it("rejects unexpected ArcGIS outFields recursively", () => {
    expect(() =>
      assertRockIslandArcGisOutFields({
        request: {
          queryStringParameters: {
            outFields: "PIN,site_address,owner1_name",
          },
        },
      }),
    ).toThrow(/Unexpected ArcGIS outField owner1_name/u);
  });

  it("accepts only approved Rock Island ArcGIS fields", () => {
    expect(() =>
      assertRockIslandArcGisOutFields({
        request: {
          outFields: [
            "PIN,site_address,Site_City,Site_Zip,taxbill_year",
          ],
        },
      }),
    ).not.toThrow();
  });

  it("normalizes county configuration and strict defaults", () => {
    expect(sourceSystemForCounty("rock-island")).toBe(
      "rock_island_appraiser",
    );
    expect(parsePublicPropertyOptions(["--county", "rock-island"])).toMatchObject({
      county: "rock-island",
      batchSize: 500,
      shardSize: 10_000,
    });
  });
});

describe("public query-table redaction", () => {
  const row: PublicQueryTableSourceRow = {
    property_id: "parcel-uuid",
    request_identifier: "1710408032",
    parcel_identifier: "1710408032",
    source_system: "rock_island_appraiser",
    county_name: "Rock Island",
    state_code: "IL",
    address_street: "100 MAIN ST",
    address_city: "MOLINE",
    address_zip: "61265",
    address_unnormalized: "100 MAIN ST, MOLINE, IL 61265",
    latitude: "41.5",
    longitude: "-90.5",
    geometry_source_payload: {
      source_payload: { latitude: "41.5", longitude: "-90.5" },
    },
    lot_size_acre: "1.5",
    lot_area_sqft: "65340",
    exterior_wall_material: null,
    roof_covering_material: null,
    property_type: "RESIDENTIAL",
    property_usage_type: "SINGLE_FAMILY",
    built_year: 1980,
    livable_floor_area: "1800",
    total_area: "2200",
    assessed_value: "100000",
    market_value: "300000",
    land_value: "50000",
    avm_value: "300000",
    last_sale_date: "2025-01-01",
    last_sale_price: "250000",
    subdivision: "TEST",
  };

  it("hard-codes every unavailable or denied track to null/false", () => {
    expect(buildPublicQueryTableRow(row, "QmCid")).toMatchObject({
      property_cid: "QmCid",
      owner_name: null,
      owners_text: null,
      owner_count: null,
      owner_occupied: null,
      has_permits: false,
      permit_count: 0,
      has_sunbiz_tenant: false,
      has_bbb_contractor: false,
    });
  });

  it("recovers city and ZIP only from a site address", () => {
    const recovered = buildPublicQueryTableRow(
      {
        ...row,
        address_city: null,
        address_zip: null,
        address_unnormalized: "100 MAIN ST, ROCK ISLAND, IL 61201",
      },
      "QmCid",
    );
    expect(recovered.address_city).toBe("ROCK ISLAND");
    expect(recovered.address_zip).toBe("61201");
  });

  it("uses verified nested source coordinates", () => {
    expect(
      readVerifiedGeometryCoordinate({
        source_payload: { longitude: "-90.6", latitude: "41.6" },
      }),
    ).toEqual({ longitude: -90.6, latitude: 41.6 });
  });
});

describe("public coverage contract", () => {
  it("accepts exact published enrichment counts only with CID/IPNS provenance", () => {
    expect(() =>
      assertPublishedCoverageTrack(
        "permits",
        {
          ingested_count: 24_786,
          expected_count: 24_786,
          cid: "QmPermit",
          ipns_label: "oracle-permit-query-rock-island",
        },
        24_786,
      ),
    ).not.toThrow();
    expect(() =>
      assertPublishedCoverageTrack(
        "corporate",
        {
          ingested_count: 11_741,
          expected_count: null,
          cid: "QmCorporate",
          ipns_label: "oracle-corporate-registration-rock-island",
        },
        11_741,
      ),
    ).not.toThrow();
    expect(() =>
      assertPublishedCoverageTrack(
        "permits",
        {
          ingested_count: 24_786,
          expected_count: 24_786,
          cid: null,
          ipns_label: null,
        },
        24_786,
      ),
    ).toThrow(/provenance/u);
    expect(() =>
      assertPublishedCoverageTrack(
        "bbb",
        {
          ingested_count: 1,
          expected_count: null,
          cid: "QmUnexpected",
          ipns_label: "unexpected",
        },
        0,
      ),
    ).toThrow(/count/u);
  });

  it("reports appraisal complete and every absent enrichment as unknown/incomplete", () => {
    const snapshot = buildPublicCoverageSnapshot(
      {
        county: "rock-island",
        appraisalCount: 65_806,
        outputPath: "/tmp/coverage.json",
      },
      "2026-08-12T00:00:00.000Z",
    );
    expect(snapshot.datasets).toEqual([
      expect.objectContaining({
        source: "appraisal",
        ingested_count: 65_806,
        expected_count: 65_806,
      }),
      expect.objectContaining({
        source: "permits",
        ingested_count: 0,
        expected_count: null,
      }),
      expect.objectContaining({
        source: "corporate",
        ingested_count: 0,
        expected_count: null,
      }),
      expect.objectContaining({
        source: "bbb",
        ingested_count: 0,
        expected_count: null,
      }),
      expect.objectContaining({
        source: "overture_places",
        ingested_count: 0,
        expected_count: null,
      }),
    ]);
  });
});

describe("publication source sampling helpers", () => {
  it("counts transformed classes without counting relationship files", () => {
    expect(
      countSourceClasses([
        "data/property.json",
        "data/address.json",
        "data/geometry_1.json",
        "data/geometry_2.json",
        "data/tax_1.json",
        "data/sales_history_1.json",
        "data/relationship_property_tax_1.json",
      ]),
    ).toMatchObject({
      properties: 1,
      addresses: 1,
      geometries: 2,
      taxes: 1,
      property_valuations: 1,
      sales_histories: 1,
    });
  });

  it("selects a stable non-repeating twelve-record sample", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      propertyId: `property-${index}`,
      parcelIdentifier: `folio-${index}`,
      filePath: `/tmp/property-${index}.json`,
      fileSizeBytes: index,
      sha256: String(index),
      cid: `cid-${index}`,
    }));
    const first = selectDeterministicSample(entries, 12);
    const second = selectDeterministicSample(entries, 12);
    expect(first).toEqual(second);
    expect(new Set(first.map((entry) => entry.propertyId))).toHaveLength(12);
  });
});

describe("lossless geometry provenance", () => {
  const exteriorRing = [
    { longitude: -90.5, latitude: 41.5 },
    { longitude: -90.4, latitude: 41.5 },
    { longitude: -90.4, latitude: 41.6 },
    { longitude: -90.5, latitude: 41.5 },
  ];

  it("preserves point order in Rock Island component polygons", () => {
    expect(readSourcePolygons({ polygon: exteriorRing })).toEqual([
      [
        [
          [-90.5, 41.5],
          [-90.4, 41.5],
          [-90.4, 41.6],
          [-90.5, 41.5],
        ],
      ],
    ]);
  });

  it("preserves every polygon and interior ring in GeoJSON", () => {
    const coordinates = [
      [
        [
          [-90.5, 41.5],
          [-90.4, 41.5],
          [-90.4, 41.6],
          [-90.5, 41.5],
        ],
        [
          [-90.48, 41.52],
          [-90.46, 41.52],
          [-90.46, 41.54],
          [-90.48, 41.52],
        ],
      ],
      [
        [
          [-90.3, 41.4],
          [-90.2, 41.4],
          [-90.2, 41.5],
          [-90.3, 41.4],
        ],
      ],
    ];
    expect(
      buildExactMultiPolygon([
        { type: "MultiPolygon", coordinates },
      ]),
    ).toEqual({ type: "MultiPolygon", coordinates });
  });

  it("prefers nested raw sidecar topology over transformed geometry", () => {
    const rawCoordinates = [
      [
        [
          [-90.5, 41.5],
          [-90.4, 41.5],
          [-90.4, 41.6],
          [-90.5, 41.5],
        ],
        [
          [-90.48, 41.52],
          [-90.46, 41.52],
          [-90.46, 41.54],
          [-90.48, 41.52],
        ],
      ],
    ];
    const payload = {
      polygon: exteriorRing,
      source_payload: {
        parcel_polygon: JSON.stringify({
          type: "MultiPolygon",
          coordinates: rawCoordinates,
        }),
      },
    };
    expect(readSourcePolygons(payload)).toEqual(rawCoordinates);
    expect(buildExactMultiPolygon([payload])).toEqual({
      type: "MultiPolygon",
      coordinates: rawCoordinates,
    });
  });

  it("preserves holes from the real ArcGIS source sidecar shape", () => {
    const coordinates = [
      [
        [-90.5, 41.5],
        [-90.4, 41.5],
        [-90.4, 41.6],
        [-90.5, 41.5],
      ],
      [
        [-90.48, 41.52],
        [-90.46, 41.52],
        [-90.46, 41.54],
        [-90.48, 41.52],
      ],
    ];
    const payload = {
      polygon: exteriorRing,
      source_payload: {
        request_identifier: "folio-1",
        response: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { PIN: "folio-1" },
              geometry: { type: "Polygon", coordinates },
            },
            {
              type: "Feature",
              properties: { PIN: "folio-1" },
              geometry: { type: "Polygon", coordinates: [[]] },
            },
          ],
        },
      },
    };
    expect(readSourcePolygons(payload)).toEqual([coordinates]);
  });

  it("fails closed instead of synthesizing an open ring", () => {
    expect(() =>
      buildExactMultiPolygon([
        { polygon: exteriorRing.slice(0, -1) },
      ]),
    ).toThrow(/Invalid geometry source_payload/u);
  });

  it("derives canonical sidecar keys and stable payload hashes", () => {
    expect(
      geometrySourceRecordKey(
        "rock_island_appraiser",
        "0132400001",
        "data/geometry_2.json",
      ),
    ).toBe(
      "rock_island_appraiser:0132400001:geometry:geometry_2",
    );
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(
      canonicalJsonSha256({ a: 1, b: 2 }),
    );
  });
});

describe("bounded geometry repair", () => {
  it("recognizes only geometry data sidecars", () => {
    expect(isGeometrySidecar("data/geometry_1.json")).toBe(true);
    expect(isGeometrySidecar("data/relationship_geometry_1.json")).toBe(
      false,
    );
  });

  it("repairs payloads missing verified nested raw geometry", () => {
    const rawRing: ReadonlyArray<readonly [number, number]> = [
      [-90.5, 41.5],
      [-90.4, 41.5],
      [-90.4, 41.6],
      [-90.5, 41.5],
    ];
    expect(geometryPayloadNeedsRepair(null)).toBe(true);
    expect(geometryPayloadNeedsRepair({})).toBe(true);
    expect(
      geometryPayloadNeedsRepair({
        polygon: [
          { longitude: -90.5, latitude: 41.5 },
          { longitude: -90.4, latitude: 41.5 },
          { longitude: -90.4, latitude: 41.6 },
          { longitude: -90.5, latitude: 41.5 },
        ],
      }),
    ).toBe(true);
    expect(
      geometryPayloadNeedsRepair({
        polygon: rawRing.map(([longitude, latitude]) => ({
          longitude,
          latitude,
        })),
        source_payload: {
          response: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "Polygon",
                  coordinates: [rawRing],
                },
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("requires explicit apply and refuses another source system", () => {
    expect(
      parseGeometryRepairOptions([
        "--manifest",
        "/tmp/repair.json",
      ]),
    ).toMatchObject({
      sourceSystem: "rock_island_appraiser",
      apply: false,
    });
    expect(() =>
      parseGeometryRepairOptions([
        "--source-system",
        "another_appraiser",
        "--manifest",
        "/tmp/repair.json",
      ]),
    ).toThrow(/scoped only/u);
  });
});

describe("child cardinality SQL", () => {
  it("counts valuations through one source-scoped property-id join", () => {
    const sql = buildValuationCountByFolioSql();
    expect(sql.match(/JOIN properties/gu)).toHaveLength(1);
    expect(sql).toContain(
      "property.property_id = valuation.property_id",
    );
    expect(sql).toContain(
      "property.source_system = valuation.source_system",
    );
    expect(sql.match(/source_system = \$1/gu)).toHaveLength(2);
    expect(sql).not.toMatch(
      /JOIN (taxes|sales_histories|geometries|lots)/u,
    );
  });

  it("retains parcel-only geometry through a nullable property link", () => {
    const sql = buildMissingGeometryInsertSql();
    expect(sql).toContain("LEFT JOIN properties property");
    expect(sql).not.toContain("FROM repair\n         JOIN properties");
    expect(sql).toContain("property.source_system = $2");
    expect(sql).toContain(
      "property.request_identifier = repair.request_identifier",
    );
  });
});

describe("pre-export validation helpers", () => {
  it("selects the same twelve source rows without duplicates", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      request_identifier: `folio-${index}`,
      source_artifact_uri: `/data/artifacts/${index}.zip`,
      source_payload: { folio: index },
    }));
    const first = selectPreExportSample(rows);
    const second = selectPreExportSample(rows);
    expect(first).toEqual(second);
    expect(
      new Set(first.map((row) => row.request_identifier)),
    ).toHaveLength(12);
  });

  it("requires repair and report evidence paths", () => {
    expect(
      parsePreExportOptions([
        "--repair-manifest",
        "/tmp/repair.json",
        "--report",
        "/tmp/report.json",
      ]),
    ).toMatchObject({
      repairManifestPath: "/tmp/repair.json",
      reportPath: "/tmp/report.json",
      concurrency: 12,
    });
  });
});

describe("property upload checkpoints", () => {
  it("fails a stale checkpoint with changed content CID", () => {
    expect(() =>
      assertPropertyCheckpointCid(
        {
          key: "properties/parcel-1.json",
          cid: "old-cid",
          uploadedAt: "2026-08-12T00:00:00.000Z",
        },
        "new-cid",
        "properties/parcel-1.json",
      ),
    ).toThrow(/Stale property checkpoint CID mismatch/u);
  });

  it("requires remote CID and property-count agreement", async () => {
    const body = Buffer.from('{"propertyCount":65806}\n');
    const cid = await computeIpfsCid(body);
    if (cid === null) throw new Error("CID test fixture failed");
    await expect(
      assertRemoteIndexAgreement(body, cid, 65_806),
    ).resolves.toBeUndefined();
    await expect(
      assertRemoteIndexAgreement(body, cid, 1),
    ).rejects.toThrow(/CID\/propertyCount agreement/u);
  });
});
