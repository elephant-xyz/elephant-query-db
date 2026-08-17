import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildGeometryRingInserts,
  buildGeometryRingRollbackSql,
  parseGeometryRingBackfillOptions,
} from "../scripts/backfill-rock-island-geometry-rings.js";

const exterior = [
  [-90.5, 41.5],
  [-90.4, 41.5],
  [-90.4, 41.6],
  [-90.5, 41.5],
];

const interior = [
  [-90.48, 41.52],
  [-90.46, 41.52],
  [-90.46, 41.54],
  [-90.48, 41.52],
];

const secondExterior = [
  [-90.3, 41.4],
  [-90.2, 41.4],
  [-90.2, 41.5],
  [-90.3, 41.4],
];

describe("Rock Island geometry-ring backfill", () => {
  it("derives exact exterior and interior rows from repaired raw provenance", () => {
    const inserts = buildGeometryRingInserts({
      geometry_id: "00000000-0000-0000-0000-000000000001",
      request_identifier: "0012345678",
      source_artifact_uri:
        "file:///srv/ingest/data/artifacts/rock-island/0012345678.zip",
      source_record_key:
        "rock_island_appraiser:0012345678:geometry:geometry_1",
      source_payload: {
        request_identifier: "0012345678",
        polygon: exterior.map(([longitude, latitude]) => ({
          latitude,
          longitude,
        })),
        source_payload: {
          response: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { PIN: "0012345678" },
                geometry: {
                  type: "MultiPolygon",
                  coordinates: [[exterior, interior]],
                },
              },
            ],
          },
        },
      },
    });

    expect(inserts).toHaveLength(2);
    expect(inserts).toEqual([
      expect.objectContaining({
        coordinates: exterior,
        polygon_index: 0,
        ring_index: 0,
        ring_role: "exterior",
        source_geometry_type: "MultiPolygon",
      }),
      expect.objectContaining({
        coordinates: interior,
        polygon_index: 0,
        ring_index: 1,
        ring_role: "interior",
        source_geometry_type: "MultiPolygon",
      }),
    ]);
    expect(new Set(inserts.map((insert) => insert.source_record_key))).toHaveLength(
      2,
    );
  });

  it("counts shared raw MultiPolygon payloads once per normalized component", () => {
    const sharedSourcePayload = {
      request_identifier: "0012345678",
      source_payload: {
        response: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { PIN: "0012345678" },
              geometry: {
                type: "MultiPolygon",
                coordinates: [
                  [exterior, interior],
                  [secondExterior],
                ],
              },
            },
          ],
        },
      },
    };
    const first = buildGeometryRingInserts({
      geometry_id: "00000000-0000-0000-0000-000000000001",
      request_identifier: "0012345678",
      source_artifact_uri: "s3://bucket/0012345678.zip",
      source_record_key:
        "rock_island_appraiser:0012345678:geometry:geometry_1",
      source_payload: {
        ...sharedSourcePayload,
        polygon: exterior,
      },
    });
    const second = buildGeometryRingInserts({
      geometry_id: "00000000-0000-0000-0000-000000000002",
      request_identifier: "0012345678",
      source_artifact_uri: "s3://bucket/0012345678.zip",
      source_record_key:
        "rock_island_appraiser:0012345678:geometry:geometry_2",
      source_payload: {
        ...sharedSourcePayload,
        polygon: secondExterior,
      },
    });
    const rings = [...first, ...second];

    expect(rings).toHaveLength(3);
    expect(rings.filter((ring) => ring.ring_role === "exterior")).toHaveLength(2);
    expect(rings.filter((ring) => ring.ring_role === "interior")).toHaveLength(1);
    expect(rings.map((ring) => ring.polygon_index)).toEqual([0, 0, 1]);
  });

  it("requires explicit apply while keeping checkpoint identifiers bounded", () => {
    expect(
      parseGeometryRingBackfillOptions([
        "--manifest",
        "/tmp/geometry.json",
        "--run-id",
        "run_20260814",
      ]),
    ).toMatchObject({ apply: false, runId: "run_20260814" });
    expect(
      parseGeometryRingBackfillOptions([
        "--manifest",
        "/tmp/geometry.json",
        "--run-id",
        "run_20260814",
        "--apply",
      ]),
    ).toMatchObject({ apply: true });
    expect(() =>
      parseGeometryRingBackfillOptions([
        "--manifest",
        "/tmp/geometry.json",
        "--run-id",
        "Unsafe-Name",
      ]),
    ).toThrow(/run-id/u);
  });

  it("generates a source-scoped rollback with no destructive cascade", () => {
    const sql = buildGeometryRingRollbackSql(
      "ri_geometry_rings_run_20260814",
    );

    expect(sql).toContain(
      "DELETE FROM public.geometry_rings WHERE source_system = 'rock_island_appraiser'",
    );
    expect(sql).toContain(
      'FROM "ri_geometry_rings_run_20260814".geometry_rings_before',
    );
    expect(sql).not.toContain("TRUNCATE");
    expect(sql).not.toContain("CASCADE");
  });

  it("ships the additive migration with parent and uniqueness constraints", () => {
    const migration = readFileSync(
      "migrations/0009_rock_island_geometry_illinois_sos.sql",
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "geometry_rings"');
    expect(migration).toContain(
      'REFERENCES "public"."geometries"("geometry_id") ON DELETE cascade',
    );
    expect(migration).toContain(
      '"geometry_rings_geometry_polygon_ring_unique"',
    );
    expect(migration).not.toContain('ALTER TABLE "geometries"');
  });
});
