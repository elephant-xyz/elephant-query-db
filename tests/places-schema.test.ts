import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  businessLocationCategories,
  businessLocationParcelLinks,
  businessLocationSources,
  businessLocations,
  overturePlaceExtractions,
} from "../src/schema/places.js";
import { PUBLICATION_HONESTLY_INCOMPLETE_TRACKS } from "../scripts/validate-publication-dry-run.js";

describe("Overture places schema", () => {
  it("registers the five places tables including the parcel-link stub", () => {
    expect(getTableName(businessLocations)).toBe("business_locations");
    expect(getTableName(businessLocationCategories)).toBe("business_location_categories");
    expect(getTableName(businessLocationSources)).toBe("business_location_sources");
    expect(getTableName(overturePlaceExtractions)).toBe("overture_place_extractions");
    expect(getTableName(businessLocationParcelLinks)).toBe("business_location_parcel_links");
  });

  it("keeps company_id off the ingest column set that the loader writes", () => {
    const columns = Object.keys(businessLocations);
    expect(columns).toContain("companyId");
    expect(columns).toContain("addressId");
    expect(columns).toContain("legacyCategoryPrimary");
    expect(columns).toContain("taxonomyHierarchy");
    expect(columns).toContain("isHostedService");
    expect(columns).toContain("firstSeenRelease");
    expect(columns).toContain("lastSeenRelease");
    expect(columns).toContain("isCurrent");
  });
});

describe("publication honestly-incomplete tracks", () => {
  it("includes overture_places with the same spelling as Neon", () => {
    expect(PUBLICATION_HONESTLY_INCOMPLETE_TRACKS).toEqual([
      "permits",
      "corporate",
      "bbb",
      "overture_places",
    ]);
  });
});
