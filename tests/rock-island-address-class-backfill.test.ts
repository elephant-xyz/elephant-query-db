import { describe, expect, it } from "vitest";

import {
  PROPERTY_CLASS_DEFINITIONS,
  ROCK_ISLAND_ADDRESS_PACKAGE_CONTRACT,
  buildAddressClassRollbackSql,
  mapRockIslandPropertyClass,
  parseAddressClassBackfillOptions,
  parseAddressPackage,
  readRockIslandRawClass,
} from "../scripts/backfill-rock-island-address-class.js";

describe("Rock Island address/class backfill", () => {
  it("pins the reviewed private package without loading local artifacts", () => {
    expect(ROCK_ISLAND_ADDRESS_PACKAGE_CONTRACT).toEqual({
      packageId: "rock-island-site-address-backfill-v1",
      recordsSha256:
        "94e5a720ba91a827b752929879170d740b2d135674f1c181bb4c99f3f4d790b6",
      expectedRecordCount: 25,
      expectedFoundCount: 19,
      expectedNotFoundCount: 6,
    });
  });

  it("rejects any package content outside the pinned digest", () => {
    expect(() =>
      parseAddressPackage({
        packageId: ROCK_ISLAND_ADDRESS_PACKAGE_CONTRACT.packageId,
        recordsSha256:
          ROCK_ISLAND_ADDRESS_PACKAGE_CONTRACT.recordsSha256,
        recordsByFolio: {},
      }),
    ).toThrow(/SHA-256/u);
  });

  it("retains all 22 official definitions and conservative unknowns", () => {
    expect(Object.keys(PROPERTY_CLASS_DEFINITIONS).sort()).toEqual([
      "0010",
      "0011",
      "0020",
      "0021",
      "0028",
      "0029",
      "0030",
      "0032",
      "0040",
      "0041",
      "0050",
      "0052",
      "0060",
      "0062",
      "0065",
      "0070",
      "0072",
      "0080",
      "0081",
      "0082",
      "0085",
      "0090",
    ]);
    expect(mapRockIslandPropertyClass("0081")).toMatchObject({
      rawCode: "0081",
      officialLabel: "Industrial Vacant Land",
      propertyUsageType: "Industrial",
      dictionaryStatus: "authoritative_definition",
    });
    expect(mapRockIslandPropertyClass("0020")).toMatchObject({
      officialLabel: "Rural Non-Farmland Vacant",
      propertyUsageType: "Unknown",
    });
    expect(mapRockIslandPropertyClass("0090")).toMatchObject({
      officialLabel: "Tax Exempt",
      propertyUsageType: "Unknown",
    });
    expect(mapRockIslandPropertyClass("9999")).toMatchObject({
      rawCode: "9999",
      officialLabel: null,
      propertyUsageType: "Unknown",
      dictionaryStatus: "unmapped_source_code",
    });
  });

  it("reads raw ArcGIS class evidence before an existing mapping fallback", () => {
    expect(
      readRockIslandRawClass({
        source_payload: {
          classification: { rawCode: "0090" },
          response: {
            features: [
              {
                properties: { class: "0081" },
              },
            ],
          },
        },
      }),
    ).toBe("0081");
    expect(
      readRockIslandRawClass({
        source_payload: {
          classification: { rawCode: "0011" },
        },
      }),
    ).toBe("0011");
    expect(readRockIslandRawClass({ source_payload: {} })).toBeNull();
  });

  it("defaults to dry-run and requires bounded checkpoint identifiers", () => {
    expect(
      parseAddressClassBackfillOptions([
        "--address-package",
        "/tmp/address.json",
        "--manifest",
        "/tmp/manifest.json",
        "--run-id",
        "apply_20260814",
      ]),
    ).toMatchObject({ apply: false, runId: "apply_20260814" });
    expect(
      parseAddressClassBackfillOptions([
        "--address-package",
        "/tmp/address.json",
        "--manifest",
        "/tmp/manifest.json",
        "--run-id",
        "apply_20260814",
        "--apply",
      ]),
    ).toMatchObject({ apply: true });
    expect(() =>
      parseAddressClassBackfillOptions([
        "--address-package",
        "/tmp/address.json",
        "--manifest",
        "/tmp/manifest.json",
        "--run-id",
        "Unsafe-Name",
      ]),
    ).toThrow(/run-id/u);
  });

  it("generates a targeted reversible checkpoint without cascade", () => {
    const rollback = buildAddressClassRollbackSql(
      "ri_address_class_apply_20260814",
    );

    expect(rollback).toContain(
      'FROM "ri_address_class_apply_20260814".addresses_before',
    );
    expect(rollback).toContain(
      'FROM "ri_address_class_apply_20260814".properties_before',
    );
    expect(rollback).toContain(
      'USING "ri_address_class_apply_20260814".target_folios',
    );
    expect(rollback).toContain(
      "target.source_system = 'rock_island_appraiser'",
    );
    expect(rollback).not.toContain("TRUNCATE");
    expect(rollback).not.toContain("CASCADE");
  });
});
