import { describe, expect, it } from "vitest";

import {
  buildPaDosUnnormalizedAddress,
  mapPaDosEntity,
  paDosSourceRecordKey,
} from "../src/loader/paDos.js";

describe("paDos loader", () => {
  it("maps one PA DOS entity into business-registration rows", () => {
    const bundle = mapPaDosEntity({
      artifactUri: "file:///tmp/entities.jsonl",
      entity: {
        filingNumber: "0003129565",
        businessName: "Fire First Defense, Llc",
        addressLine1: "305 N High St",
        city: "West Chester",
        state: "PA",
        zip: "19380-0",
        entityType: "Domestic Limited Liability Company",
        partyType: "Governor",
        creationDate: "2010-01-01",
        countyName: "Chester",
      },
    });

    expect(bundle.rows.map((row) => row.tableName)).toEqual([
      "addresses",
      "companies",
      "business_registrations",
      "business_registration_addresses",
    ]);
    expect(paDosSourceRecordKey("0003129565", "company")).toBe(
      "pa_dos:0003129565:company",
    );
    expect(buildPaDosUnnormalizedAddress({
      filingNumber: "0003129565",
      businessName: "Fire First Defense, Llc",
      addressLine1: "305 N High St",
      city: "West Chester",
      state: "PA",
      zip: "19380",
      entityType: null,
      partyType: null,
      creationDate: null,
      countyName: "Chester",
    })).toBe("305 N HIGH ST, WEST CHESTER PA, 19380");
  });
});
