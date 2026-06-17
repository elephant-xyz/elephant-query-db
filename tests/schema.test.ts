import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  addresses,
  businessRegistrationAddresses,
  businessRegistrationAnnualReports,
  businessRegistrationEvents,
  businessRegistrationParties,
  businessRegistrations,
  companies,
  deeds,
  factSheets,
  files,
  floodStormInformation,
  geometries,
  inspections,
  layouts,
  lexiconClasses,
  lexiconRelationshipTypes,
  lots,
  ownerships,
  parcels,
  people,
  permitContacts,
  permitCustomFields,
  permitEvents,
  permitFees,
  permitLinks,
  permitListWindows,
  propertyImprovements,
  propertyValuations,
  properties,
  salesHistories,
  structures,
  sunbizExtractionChunks,
  taxes,
  unnormalizedAddresses,
  utilities,
} from "../src/index.js";

const sourceTrackedTables = [
  addresses,
  businessRegistrationAddresses,
  businessRegistrationAnnualReports,
  businessRegistrationEvents,
  businessRegistrationParties,
  businessRegistrations,
  companies,
  deeds,
  factSheets,
  files,
  floodStormInformation,
  geometries,
  inspections,
  layouts,
  lots,
  ownerships,
  parcels,
  people,
  permitContacts,
  permitCustomFields,
  permitEvents,
  permitFees,
  permitLinks,
  permitListWindows,
  propertyImprovements,
  propertyValuations,
  properties,
  salesHistories,
  structures,
  sunbizExtractionChunks,
  taxes,
  unnormalizedAddresses,
  utilities,
] as const;

describe("query database schema", () => {
  it("includes generated lexicon metadata for the active ingestion tracks", () => {
    const classTypes = new Set(lexiconClasses.map((entry) => entry.type));
    expect(classTypes).toContain("parcel");
    expect(classTypes).toContain("property");
    expect(classTypes).toContain("property_improvement");
    expect(classTypes).toContain("inspection");
    expect(classTypes).toContain("business_registration");
    expect(classTypes).toContain("business_registration_address");
    expect(classTypes).toContain("business_registration_party");
    expect(classTypes).toContain("flood_storm_information");
    expect(classTypes).toContain("utility");
    expect(classTypes).toContain("layout");
    expect(classTypes).toContain("lot");
    expect(classTypes).toContain("fact_sheet");
    expect(classTypes).toContain("geometry");
    expect(classTypes).toContain("deed");
    expect(classTypes).toContain("file");

    const relationshipTypes = new Set(
      lexiconRelationshipTypes.map((entry) => entry.relationshipType),
    );
    expect(relationshipTypes).toContain("property_has_parcel");
    expect(relationshipTypes).toContain("property_has_property_improvement");
    expect(relationshipTypes).toContain("property_improvement_has_inspection");
    expect(relationshipTypes).toContain("company_has_business_registration");
    expect(relationshipTypes).toContain("business_registration_has_party");
    expect(relationshipTypes).toContain("property_has_flood_storm_information");
    expect(relationshipTypes).toContain("property_has_utility");
    expect(relationshipTypes).toContain("property_has_layout");
    expect(relationshipTypes).toContain("property_has_lot");
  });

  it("keeps source payload columns on every source-specific projection", () => {
    expect(parcels.sourcePayload.name).toBe("source_payload");
    expect(properties.sourcePayload.name).toBe("source_payload");
    expect(taxes.sourcePayload.name).toBe("source_payload");
    expect(factSheets.sourcePayload.name).toBe("source_payload");
    expect(geometries.sourcePayload.name).toBe("source_payload");
    expect(deeds.sourcePayload.name).toBe("source_payload");
    expect(files.sourcePayload.name).toBe("source_payload");
    expect(floodStormInformation.sourcePayload.name).toBe("source_payload");
    expect(utilities.sourcePayload.name).toBe("source_payload");
    expect(layouts.sourcePayload.name).toBe("source_payload");
    expect(lots.sourcePayload.name).toBe("source_payload");
    expect(propertyImprovements.sourcePayload.name).toBe("source_payload");
    expect(inspections.sourcePayload.name).toBe("source_payload");
    expect(permitContacts.sourcePayload.name).toBe("source_payload");
    expect(permitEvents.sourcePayload.name).toBe("source_payload");
    expect(permitFees.sourcePayload.name).toBe("source_payload");
    expect(permitLinks.sourcePayload.name).toBe("source_payload");
    expect(permitCustomFields.fieldPayload.name).toBe("field_payload");
    expect(permitCustomFields.sourcePayload.name).toBe("source_payload");
    expect(businessRegistrations.sourcePayload.name).toBe("source_payload");
    expect(businessRegistrationAddresses.sourcePayload.name).toBe("source_payload");
    expect(businessRegistrationParties.sourcePayload.name).toBe("source_payload");
    expect(sunbizExtractionChunks.sourcePayload.name).toBe("source_payload");
  });

  it("puts idempotent source metadata directly on logical tables", () => {
    for (const table of sourceTrackedTables) {
      expect(table.sourceSystem.name).toBe("source_system");
      expect(table.sourceRecordKey.name).toBe("source_record_key");
      expect(table.sourceRecordHash.name).toBe("source_record_hash");
      expect(table.sourceArtifactUri.name).toBe("source_artifact_uri");
      expect(table.loadedAt.name).toBe("loaded_at");
    }

    expect(properties.propertyId.name).toBe("property_id");
    expect(properties.addressId.name).toBe("address_id");
    expect(addresses.normalizedAddressHash.name).toBe("normalized_address_hash");
    expect(propertyImprovements.propertyImprovementId.name).toBe("property_improvement_id");
    expect(businessRegistrations.businessRegistrationId.name).toBe("business_registration_id");
  });

  it("keeps generic registry tables out of the generated migration", () => {
    const migrationFile = readdirSync("migrations").find((fileName) => fileName.endsWith(".sql"));

    if (migrationFile === undefined) {
      throw new Error("Expected a generated SQL migration file");
    }

    const migrationSql = readFileSync(`migrations/${migrationFile}`, "utf8");

    expect(migrationSql).not.toContain("raw_records");
    expect(migrationSql).not.toContain("load_jobs");
    expect(migrationSql).not.toContain("source_artifacts");
    expect(migrationSql).not.toContain("lexicon");
    expect(migrationSql).not.toContain("entity_matches");
    expect(migrationSql).not.toContain("canonical_entity");
  });

  it("models permit and Sunbiz fields that are not first-class lexicon concepts yet", () => {
    expect(propertyImprovements.accelaRecordId.name).toBe("accela_record_id");
    expect(propertyImprovements.moreDetails.name).toBe("more_details");
    expect(propertyImprovements.processingStatusRawText.name).toBe("processing_status_raw_text");
    expect(permitContacts.licenseNumber.name).toBe("license_number");
    expect(permitFees.balanceAmount.name).toBe("balance_amount");
    expect(businessRegistrations.documentNumber.name).toBe("document_number");
    expect(businessRegistrations.feiNumber.name).toBe("fei_number");
    expect(businessRegistrationParties.officerOrdinal.name).toBe("officer_ordinal");
  });
});
