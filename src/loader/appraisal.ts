import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  extractPostalCodeFromAddress,
  hashNormalizedAddressKey,
  isJsonObject,
  normalizeName,
  normalizeParcelIdentifier,
  readBoolean,
  readDate,
  readInteger,
  readNumber,
  readString,
} from "./normalizers.js";
import type { JsonObject, LogicalTableName, PreparedRow, PreparedRowBundle } from "./types.js";

const APPRAISER_SOURCE_SYSTEM = "lee_appraiser";

const PROPERTY_COLUMNS = [
  "property_legal_description_text",
  "property_structure_built_year",
  "property_effective_built_year",
  "ownership_estate_type",
  "build_status",
  "structure_form",
  "property_usage_type",
  "property_type",
  "livable_floor_area",
  "area_under_air",
  "total_area",
  "number_of_units",
  "number_of_units_type",
  "subdivision",
  "zoning",
] as const;

const TAX_COLUMNS = [
  "tax_year",
  "property_assessed_value_amount",
  "property_market_value_amount",
  "property_building_amount",
  "property_land_amount",
  "property_exemption_amount",
  "property_taxable_value_amount",
  "city_taxable_value_amount",
  "county_taxable_value_amount",
  "college_taxable_value_amount",
  "hospital_taxable_value_amount",
  "school_taxable_value_amount",
  "special_district_taxable_value_amount",
  "agricultural_valuation_amount",
  "homestead_cap_loss_amount",
  "building_replacement_cost_amount",
  "building_depreciated_value_amount",
  "millage_rate",
  "monthly_tax_amount",
  "yearly_tax_amount",
  "period_start_date",
  "period_end_date",
  "first_year_on_tax_roll",
  "first_year_building_on_tax_roll",
] as const;

const PROPERTY_VALUATION_COLUMNS = [
  "valuation_date",
  "valuation_method_type",
  "confidence_score",
  "current_avm_value",
  "high_value",
  "low_value",
  "standard_deviation",
  "area_min_property_price_psf",
  "area_max_property_price_psf",
] as const;

const SALES_HISTORY_COLUMNS = [
  "ownership_transfer_date",
  "purchase_price_amount",
  "sale_type",
  "deed_book",
  "deed_page",
  "instrument_number",
] as const;

const APPRAISAL_PROPERTY_IMPROVEMENT_COLUMNS = [
  "permit_number",
  "improvement_type",
  "improvement_status",
  "improvement_action",
  "contractor_type",
  "permit_required",
  "completion_date",
] as const;

const STRUCTURE_COLUMNS = [
  "architectural_style_type",
  "attachment_type",
  "exterior_wall_material_primary",
  "exterior_wall_material_secondary",
  "exterior_wall_condition",
  "exterior_wall_condition_primary",
  "exterior_wall_condition_secondary",
  "exterior_wall_insulation_type",
  "exterior_wall_insulation_type_primary",
  "exterior_wall_insulation_type_secondary",
  "roof_covering_material",
  "roof_material_type",
  "roof_design_type",
  "roof_condition",
  "roof_age_years",
  "roof_date",
  "roof_underlayment_type",
  "roof_structure_material",
  "foundation_type",
  "foundation_material",
  "foundation_condition",
  "foundation_waterproofing",
  "flooring_material_primary",
  "flooring_material_secondary",
  "flooring_condition",
  "subfloor_material",
  "interior_wall_structure_material",
  "interior_wall_structure_material_primary",
  "interior_wall_structure_material_secondary",
  "interior_wall_surface_material_primary",
  "interior_wall_surface_material_secondary",
  "interior_wall_finish_primary",
  "interior_wall_finish_secondary",
  "interior_wall_condition",
  "gutters_material",
  "gutters_condition",
  "ceiling_structure_material",
  "ceiling_surface_material",
  "ceiling_insulation_type",
  "ceiling_height_average",
  "ceiling_condition",
  "exterior_door_material",
  "interior_door_material",
  "window_frame_material",
  "window_glazing_type",
  "window_operation_type",
  "window_screen_material",
  "primary_framing_material",
  "secondary_framing_material",
  "structural_damage_indicators",
  "number_of_stories",
  "finished_base_area",
  "unfinished_base_area",
  "finished_basement_area",
  "unfinished_basement_area",
  "finished_upper_story_area",
  "unfinished_upper_story_area",
] as const;

const UTILITY_COLUMNS = [
  "cooling_system_type",
  "heating_system_type",
  "heating_fuel_type",
  "public_utility_type",
  "sewer_type",
  "water_source_type",
  "plumbing_system_type",
  "plumbing_system_type_other_description",
  "electrical_panel_capacity",
  "electrical_wiring_type",
  "electrical_wiring_type_other_description",
  "hvac_condensing_unit_present",
  "hvac_unit_condition",
  "hvac_unit_issues",
  "hvac_capacity_kw",
  "hvac_capacity_tons",
  "hvac_seer_rating",
  "hvac_system_configuration",
  "hvac_equipment_component",
  "hvac_equipment_manufacturer",
  "hvac_equipment_model",
  "hvac_installation_date",
  "solar_panel_present",
  "solar_panel_type",
  "solar_panel_type_other_description",
  "solar_installation_date",
  "solar_inverter_visible",
  "solar_inverter_manufacturer",
  "solar_inverter_model",
  "solar_inverter_installation_date",
  "smart_home_features",
  "smart_home_features_other_description",
  "plumbing_fixture_count",
  "plumbing_fixture_quality",
  "plumbing_fixture_type_primary",
  "plumbing_system_installation_date",
  "electrical_panel_installation_date",
  "electrical_rewire_date",
  "sewer_connection_date",
  "water_connection_date",
  "water_heater_manufacturer",
  "water_heater_model",
  "water_heater_installation_date",
  "well_installation_date",
] as const;

const LAYOUT_COLUMNS = [
  "space_type",
  "space_index",
  "space_type_index",
  "building_number",
  "story_type",
  "floor_level",
  "built_year",
  "installation_date",
  "size_square_feet",
  "livable_area_sq_ft",
  "total_area_sq_ft",
  "heated_area_sq_ft",
  "area_under_air_sq_ft",
  "adjustable_area_sq_ft",
  "flooring_material_type",
  "flooring_installation_date",
  "has_windows",
  "window_design_type",
  "window_material_type",
  "window_treatment_type",
  "is_finished",
  "furnished",
  "paint_condition",
  "flooring_wear",
  "clutter_level",
  "visible_damage",
  "countertop_material",
  "cabinet_style",
  "fixture_finish_quality",
  "design_style",
  "natural_light_quality",
  "decor_elements",
  "kitchen_renovation_date",
  "bathroom_renovation_date",
  "pool_type",
  "pool_equipment",
  "pool_condition",
  "pool_surface_type",
  "pool_water_quality",
  "pool_installation_date",
  "spa_type",
  "spa_installation_date",
  "safety_features",
  "view_type",
  "lighting_features",
  "condition_issues",
  "is_exterior",
] as const;

const LOT_COLUMNS = [
  "lot_type",
  "lot_length_feet",
  "lot_width_feet",
  "lot_area_sqft",
  "lot_size_acre",
  "landscaping_features",
  "view",
  "fencing_type",
  "fence_height",
  "fence_length",
  "driveway_material",
  "driveway_condition",
  "lot_condition_issues",
  "paving_area_sqft",
  "paving_installation_date",
  "paving_type",
  "site_lighting_fixture_count",
  "site_lighting_installation_date",
  "site_lighting_type",
] as const;

const FLOOD_COLUMNS = [
  "community_id",
  "panel_number",
  "map_version",
  "effective_date",
  "evacuation_zone",
  "flood_zone",
  "flood_insurance_required",
  "fema_search_url",
] as const;

const APPRAISAL_INTEGER_COLUMNS = new Set<string>([
  "built_year",
  "finished_base_area",
  "finished_basement_area",
  "finished_upper_story_area",
  "first_year_building_on_tax_roll",
  "first_year_on_tax_roll",
  "number_of_units",
  "plumbing_fixture_count",
  "property_effective_built_year",
  "property_structure_built_year",
  "roof_age_years",
  "site_lighting_fixture_count",
  "space_index",
  "space_type_index",
  "tax_year",
  "unfinished_base_area",
  "unfinished_basement_area",
  "unfinished_upper_story_area",
]);

const APPRAISAL_NUMERIC_COLUMNS = new Set<string>([
  "adjustable_area_sq_ft",
  "agricultural_valuation_amount",
  "area_max_property_price_psf",
  "area_min_property_price_psf",
  "area_under_air_sq_ft",
  "building_depreciated_value_amount",
  "building_replacement_cost_amount",
  "ceiling_height_average",
  "city_taxable_value_amount",
  "college_taxable_value_amount",
  "county_taxable_value_amount",
  "current_avm_value",
  "fence_height",
  "fence_length",
  "finished_base_area",
  "finished_basement_area",
  "finished_upper_story_area",
  "heated_area_sq_ft",
  "high_value",
  "homestead_cap_loss_amount",
  "hospital_taxable_value_amount",
  "hvac_capacity_kw",
  "hvac_capacity_tons",
  "hvac_seer_rating",
  "latitude",
  "livable_area_sq_ft",
  "longitude",
  "lot_area_sqft",
  "lot_length_feet",
  "lot_size_acre",
  "lot_width_feet",
  "low_value",
  "millage_rate",
  "monthly_tax_amount",
  "number_of_stories",
  "ownership_percentage",
  "paving_area_sqft",
  "property_assessed_value_amount",
  "property_building_amount",
  "property_exemption_amount",
  "property_land_amount",
  "property_market_value_amount",
  "property_taxable_value_amount",
  "purchase_price_amount",
  "school_taxable_value_amount",
  "size_square_feet",
  "special_district_taxable_value_amount",
  "standard_deviation",
  "total_area_sq_ft",
  "unfinished_base_area",
  "unfinished_basement_area",
  "unfinished_upper_story_area",
  "yearly_tax_amount",
]);

const APPRAISAL_DATE_COLUMNS = new Set<string>([
  "bathroom_renovation_date",
  "completion_date",
  "date_acquired",
  "date_sold",
  "effective_date",
  "electrical_panel_installation_date",
  "electrical_rewire_date",
  "flooring_installation_date",
  "hvac_installation_date",
  "installation_date",
  "kitchen_renovation_date",
  "ownership_transfer_date",
  "paving_installation_date",
  "period_end_date",
  "period_start_date",
  "plumbing_system_installation_date",
  "pool_installation_date",
  "sewer_connection_date",
  "site_lighting_installation_date",
  "solar_installation_date",
  "solar_inverter_installation_date",
  "spa_installation_date",
  "valuation_date",
  "water_connection_date",
  "water_heater_installation_date",
  "well_installation_date",
]);

const APPRAISAL_BOOLEAN_COLUMNS = new Set<string>([
  "flood_insurance_required",
  "furnished",
  "has_windows",
  "historic_designation",
  "hvac_condensing_unit_present",
  "is_exterior",
  "is_finished",
  "owner_occupied_indicator",
  "permit_required",
  "solar_inverter_visible",
  "solar_panel_present",
  "veteran_status",
]);

/**
 * Map one Lee appraiser transformed JSON file into a logical query-db row bundle.
 *
 * @param params - Transformed file name, parsed payload, artifact URI, and optional request identifier.
 * @returns Prepared rows for recognized appraisal files, or a skipped-record entry for unsupported files.
 */
export function mapAppraisalTransformedFile(params: {
  readonly filePath: string;
  readonly record: unknown;
  readonly artifactUri: string | null;
  readonly requestIdentifier?: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return skipped(params, "appraisal transformed file is not a JSON object", { value: params.record });
  }
  const fileName = params.filePath.split("/").pop() ?? params.filePath;
  if (fileName.startsWith("relationship_")) {
    return skipped(params, "relationship files are represented through direct foreign-key references", params.record);
  }

  const requestIdentifier =
    readString(params.record.request_identifier) ?? params.requestIdentifier ?? null;
  if (requestIdentifier === null) {
    return skipped(params, "appraisal record is missing request_identifier", params.record);
  }

  const rows = mapKnownAppraisalRecord(fileName, params.record, requestIdentifier, params.artifactUri);
  return rows === null
    ? skipped(params, `unrecognized appraisal transformed file: ${fileName}`, params.record)
    : { rows, skippedRecords: [] };
}

function mapKnownAppraisalRecord(
  fileName: string,
  record: JsonObject,
  requestIdentifier: string,
  artifactUri: string | null,
): readonly PreparedRow[] | null {
  if (fileName === "property_seed.json") return [mapParcel(record, requestIdentifier, artifactUri)];
  if (fileName === "property.json") return [mapProperty(record, requestIdentifier, artifactUri)];
  if (fileName === "unnormalized_address.json") {
    return [mapUnnormalizedAddress(record, requestIdentifier, artifactUri)];
  }
  if (fileName === "address.json" || /^mailing_address_\d+\.json$/.test(fileName)) {
    return [mapAddress(record, fileName, requestIdentifier, artifactUri)];
  }
  if (/^person_\d+\.json$/.test(fileName)) return mapAppraisalPersonOwnerRows(record, fileName, requestIdentifier, artifactUri);
  if (/^company_\d+\.json$/.test(fileName)) return mapAppraisalCompanyOwnerRows(record, fileName, requestIdentifier, artifactUri);
  if (/^tax_/.test(fileName)) return mapTaxRows(record, fileName, requestIdentifier, artifactUri);
  if (/^property_valuation_/.test(fileName)) {
    return [mapPropertyChild("property_valuations", record, fileName, requestIdentifier, artifactUri, PROPERTY_VALUATION_COLUMNS)];
  }
  if (/^(sales_history_|sales_)/.test(fileName)) {
    return [mapPropertyChild("sales_histories", record, fileName, requestIdentifier, artifactUri, SALES_HISTORY_COLUMNS)];
  }
  if (/^property_improvement_/.test(fileName)) {
    return [mapAppraisalPropertyImprovement(record, fileName, requestIdentifier, artifactUri)];
  }
  if (/^structure_/.test(fileName)) return [mapPropertyChild("structures", record, fileName, requestIdentifier, artifactUri, STRUCTURE_COLUMNS)];
  if (/^utility_/.test(fileName)) return [mapPropertyChild("utilities", record, fileName, requestIdentifier, artifactUri, UTILITY_COLUMNS)];
  if (/^layout_/.test(fileName)) return [mapPropertyChild("layouts", record, fileName, requestIdentifier, artifactUri, LAYOUT_COLUMNS)];
  if (fileName === "lot.json" || /^lot_/.test(fileName)) {
    return [mapPropertyChild("lots", record, fileName, requestIdentifier, artifactUri, LOT_COLUMNS)];
  }
  if (/^flood_storm_information/.test(fileName)) {
    return [mapPropertyChild("flood_storm_information", record, fileName, requestIdentifier, artifactUri, FLOOD_COLUMNS)];
  }
  if (fileName === "fact_sheet.json") return [mapFactSheet(record, requestIdentifier, artifactUri)];
  if (fileName === "geometry.json") return [mapGeometry(record, requestIdentifier, artifactUri)];
  if (/^deed_/.test(fileName)) return [mapDeed(record, fileName, requestIdentifier, artifactUri)];
  if (/^file_/.test(fileName)) return [mapFile(record, fileName, requestIdentifier, artifactUri)];
  return null;
}

function mapParcel(
  record: JsonObject,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "parcel", "property_seed");
  return {
    tableName: "parcels",
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      request_identifier: requestIdentifier,
      // Store the RAW STRAP so letters (e.g. condo units `…0001A`) are preserved
      // for display/reference. Parcel dedup keys on `request_identifier` (folio),
      // NOT this column, so the raw value never collapses distinct parcels. The
      // digits-only `normalizeParcelIdentifier` form is still used for cross-source
      // matching at read time (see scoped-load.ts).
      parcel_identifier: readString(record.parcel_id) ?? requestIdentifier,
      county_name: readCountyName(record),
      state_code: "FL",
      jurisdiction_key: "lee_appraiser",
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function mapProperty(
  record: JsonObject,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "property", "property");
  return {
    tableName: "properties",
    references: {
      addressSourceRecordKey: sourceKey(requestIdentifier, "address", "site"),
      parcelSourceRecordKey: sourceKey(requestIdentifier, "parcel", "property_seed"),
    },
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      ...pick(record, PROPERTY_COLUMNS),
      request_identifier: requestIdentifier,
      parcel_identifier: normalizeParcelIdentifier(record.parcel_identifier ?? requestIdentifier),
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function mapUnnormalizedAddress(
  record: JsonObject,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "unnormalized_address", "site");
  return {
    tableName: "unnormalized_addresses",
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      request_identifier: requestIdentifier,
      full_address: readString(record.full_address),
      county_jurisdiction: readString(record.county_jurisdiction),
      latitude: normalizeAppraisalColumnValue("latitude", record.latitude),
      longitude: normalizeAppraisalColumnValue("longitude", record.longitude),
      source_http_request: jsonObjectOrNull(record.source_http_request),
      entry_http_request: jsonObjectOrNull(record.entry_http_request),
      source_payload: record,
    }),
  };
}

function mapAddress(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const addressRole = fileName === "address.json" ? "site" : fileName.replace(/\.json$/, "");
  const sourceRecordKey = sourceKey(requestIdentifier, "address", addressRole);
  const unnormalizedAddress = readString(record.unnormalized_address);
  const normalizedAddressKey = buildNormalizedAddressKey(unnormalizedAddress);
  const values = compactObject({
    ...metadata(sourceRecordKey, record, artifactUri),
    request_identifier: requestIdentifier,
    unnormalized_address: unnormalizedAddress,
    normalized_address_key: normalizedAddressKey,
    normalized_address_hash: hashNormalizedAddressKey(normalizedAddressKey),
    postal_code: extractPostalCodeFromAddress(unnormalizedAddress),
    state_code: /\bFL\b/i.test(unnormalizedAddress ?? "") ? "FL" : null,
    county_name: readString(record.county_name),
    country_code: readString(record.country_code) ?? "US",
    township: readString(record.township),
    range: readString(record.range),
    section: readString(record.section),
    latitude: normalizeAppraisalColumnValue("latitude", record.latitude),
    longitude: normalizeAppraisalColumnValue("longitude", record.longitude),
    source_http_request: jsonObjectOrNull(record.source_http_request),
    source_payload: record,
  });
  if (addressRole !== "site") {
    return {
      tableName: "addresses",
      values,
    };
  }
  return {
    tableName: "addresses",
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values,
  };
}

function mapPerson(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "person", fileName.replace(/\.json$/, ""));
  const fullName = [record.first_name, record.middle_name, record.last_name]
    .map(readString)
    .filter((value): value is string => value !== null)
    .join(" ");
  return {
    tableName: "people",
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      request_identifier: requestIdentifier,
      prefix_name: readString(record.prefix_name),
      first_name: readString(record.first_name),
      middle_name: readString(record.middle_name),
      last_name: readString(record.last_name),
      suffix_name: readString(record.suffix_name),
      full_name: fullName.length > 0 ? fullName : null,
      normalized_name: normalizeName(fullName),
      birth_date: readString(record.birth_date),
      us_citizenship_status: readString(record.us_citizenship_status),
      veteran_status: record.veteran_status,
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

/**
 * Map one appraiser current-owner person file into a person row and direct ownership row.
 *
 * The Lee transform writes current owners as `person_N.json` when the owner
 * looks like an individual. The original relationship file links that owner to
 * the latest sale for legacy compatibility, but the query database needs a
 * direct `ownerships.property_id` edge for property profile queries.
 *
 * @param record - Parsed `person_N.json` owner payload from the Lee transform.
 * @param fileName - Source data file name such as `person_1.json`.
 * @param requestIdentifier - Lee appraiser folio/request identifier.
 * @param artifactUri - S3 URI of the transformed output ZIP.
 * @returns Prepared person and ownership rows with source-key references.
 */
function mapAppraisalPersonOwnerRows(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): readonly PreparedRow[] {
  const person = mapPerson(record, fileName, requestIdentifier, artifactUri);
  const ownerKeyPart = fileName.replace(/\.json$/, "");
  const fullName = readString(person.values.full_name) ?? readString(person.values.normalized_name);
  return [
    person,
    mapOwnership({
      artifactUri,
      ownerKeyPart,
      ownedBy: fullName,
      ownerReference: { personSourceRecordKey: sourceKey(requestIdentifier, "person", ownerKeyPart) },
      record,
      requestIdentifier,
    }),
  ];
}

/**
 * Map one appraiser current-owner company file into a company row and direct ownership row.
 *
 * @param record - Parsed `company_N.json` owner payload from the Lee transform.
 * @param fileName - Source data file name such as `company_1.json`.
 * @param requestIdentifier - Lee appraiser folio/request identifier.
 * @param artifactUri - S3 URI of the transformed output ZIP.
 * @returns Prepared company and ownership rows with source-key references.
 */
function mapAppraisalCompanyOwnerRows(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): readonly PreparedRow[] {
  const companyKeyPart = fileName.replace(/\.json$/, "");
  const name = readString(record.name) ?? readString(record.company_name);
  return [
    {
      tableName: "companies",
      values: compactObject({
        ...metadata(sourceKey(requestIdentifier, "company", companyKeyPart), record, artifactUri),
        request_identifier: requestIdentifier,
        name,
        normalized_name: normalizeName(name),
        source_http_request: jsonObjectOrNull(record.source_http_request),
        source_payload: record,
      }),
    },
    mapOwnership({
      artifactUri,
      ownerKeyPart: companyKeyPart,
      ownedBy: name,
      ownerReference: { companySourceRecordKey: sourceKey(requestIdentifier, "company", companyKeyPart) },
      record,
      requestIdentifier,
    }),
  ];
}

/**
 * Build an ownership row for a Lee appraiser current-owner person or company file.
 *
 * @param params - Owner source payload, identity key, foreign-key references, and provenance.
 * @returns Prepared ownership row linked to the appraiser property and owner entity.
 */
function mapOwnership(params: {
  readonly artifactUri: string | null;
  readonly ownerKeyPart: string;
  readonly ownedBy: string | null;
  readonly ownerReference: Pick<NonNullable<PreparedRow["references"]>, "companySourceRecordKey" | "personSourceRecordKey">;
  readonly record: JsonObject;
  readonly requestIdentifier: string;
}): PreparedRow {
  return {
    tableName: "ownerships",
    references: {
      propertySourceRecordKey: sourceKey(params.requestIdentifier, "property", "property"),
      ...params.ownerReference,
    },
    values: compactObject({
      ...metadata(sourceKey(params.requestIdentifier, "ownership", params.ownerKeyPart), params.record, params.artifactUri),
      ownership_identifier: params.ownerKeyPart,
      owned_by: params.ownedBy,
      source_payload: params.record,
    }),
  };
}

/**
 * Map a Lee appraiser tax file and a valuation projection from the same value row.
 *
 * The tax roll's just/market value is also useful as the county-assessed
 * valuation point for parcel detail screens, so one `tax_YYYY.json` source row
 * produces both `taxes` and `property_valuations` when value data exists.
 *
 * @param record - Parsed `tax_YYYY.json` payload.
 * @param fileName - Source data file name.
 * @param requestIdentifier - Lee appraiser folio/request identifier.
 * @param artifactUri - S3 URI of the transformed output ZIP.
 * @returns Prepared tax row plus a derived property valuation row when possible.
 */
function mapTaxRows(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): readonly PreparedRow[] {
  const taxRow = mapPropertyChild("taxes", record, fileName, requestIdentifier, artifactUri, TAX_COLUMNS);
  const valuationRow = mapCountyValuationFromTax(record, fileName, requestIdentifier, artifactUri);
  return valuationRow === null ? [taxRow] : [taxRow, valuationRow];
}

/**
 * Project county-assessed value fields from a tax source row into a property valuation row.
 *
 * @param record - Parsed `tax_YYYY.json` source payload containing market or assessed value fields.
 * @param fileName - Tax source data file name used to build a stable source key.
 * @param requestIdentifier - Lee appraiser folio/request identifier.
 * @param artifactUri - S3 URI of the transformed output ZIP.
 * @returns Prepared valuation row when the source includes a usable value; otherwise `null`.
 */
function mapCountyValuationFromTax(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow | null {
  const marketValue = normalizeAppraisalColumnValue("property_market_value_amount", record.property_market_value_amount);
  const assessedValue = normalizeAppraisalColumnValue("property_assessed_value_amount", record.property_assessed_value_amount);
  const currentAvmValue = marketValue ?? assessedValue;
  if (currentAvmValue === null || currentAvmValue === undefined) return null;
  const taxYear = readInteger(record.tax_year);
  const valuationPayload = compactObject({
    request_identifier: requestIdentifier,
    source_file_name: fileName,
    tax_year: taxYear,
    current_avm_value: currentAvmValue,
    valuation_date: taxYear === null ? null : `${String(taxYear)}-01-01`,
    valuation_method_type: "LEE_APPRAISER_TAX_ROLL_JUST_VALUE",
    source_tax_payload: record,
  });
  return {
    tableName: "property_valuations",
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values: compactObject({
      ...metadata(
        sourceKey(requestIdentifier, "property_valuation", fileName.replace(/\.json$/, "")),
        valuationPayload,
        artifactUri,
      ),
      valuation_date: valuationPayload.valuation_date,
      valuation_method_type: valuationPayload.valuation_method_type,
      current_avm_value: currentAvmValue,
      source_payload: valuationPayload,
    }),
  };
}

function mapPropertyChild(
  tableName: LogicalTableName,
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
  columns: readonly string[],
): PreparedRow {
  const className = tableName.endsWith("ies")
    ? tableName.slice(0, -3) + "y"
    : tableName.replace(/s$/, "");
  const sourceRecordKey = sourceKey(requestIdentifier, className, fileName.replace(/\.json$/, ""));
  return {
    tableName,
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      ...pick(record, columns),
      request_identifier: requestIdentifier,
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function mapAppraisalPropertyImprovement(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "property_improvement", fileName.replace(/\.json$/, ""));
  return {
    tableName: "property_improvements",
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      ...pick(record, APPRAISAL_PROPERTY_IMPROVEMENT_COLUMNS),
      request_identifier: requestIdentifier,
      more_details: {},
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function mapFactSheet(
  record: JsonObject,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "fact_sheet", "fact_sheet");
  return {
    tableName: "fact_sheets",
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      request_identifier: requestIdentifier,
      ipfs_url: readString(record.ipfs_url),
      full_generation_command: readString(record.full_generation_command),
      source_payload: record,
    }),
  };
}

function mapGeometry(
  record: JsonObject,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const sourceRecordKey = sourceKey(requestIdentifier, "geometry", "geometry");
  return {
    tableName: "geometries",
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      request_identifier: requestIdentifier,
      latitude: normalizeAppraisalColumnValue("latitude", record.latitude),
      longitude: normalizeAppraisalColumnValue("longitude", record.longitude),
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function mapDeed(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const deedKeyPart = fileName.replace(/\.json$/, "");
  const sourceRecordKey = sourceKey(requestIdentifier, "deed", deedKeyPart);
  return {
    tableName: "deeds",
    references: { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") },
    values: compactObject({
      ...metadata(sourceRecordKey, record, artifactUri),
      request_identifier: requestIdentifier,
      deed_type: readString(record.deed_type),
      book: readString(record.book),
      page: readString(record.page),
      instrument_number: readString(record.instrument_number),
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function mapFile(
  record: JsonObject,
  fileName: string,
  requestIdentifier: string,
  artifactUri: string | null,
): PreparedRow {
  const fileKeyPart = fileName.replace(/\.json$/, "");
  const deedOrdinal = /file_(\d+)/.exec(fileName)?.[1] ?? null;
  const references =
    deedOrdinal === null
      ? { propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property") }
      : {
          propertySourceRecordKey: sourceKey(requestIdentifier, "property", "property"),
          deedSourceRecordKey: sourceKey(requestIdentifier, "deed", `deed_${deedOrdinal}`),
        };
  return {
    tableName: "files",
    references,
    values: compactObject({
      ...metadata(sourceKey(requestIdentifier, "file", fileKeyPart), record, artifactUri),
      request_identifier: requestIdentifier,
      document_type: readString(record.document_type),
      file_format: readString(record.file_format),
      ipfs_url: readString(record.ipfs_url),
      name: readString(record.name),
      original_url: readString(record.original_url),
      source_http_request: jsonObjectOrNull(record.source_http_request),
      source_payload: record,
    }),
  };
}

function skipped(
  params: { readonly filePath: string; readonly artifactUri: string | null },
  reason: string,
  sourcePayload: JsonObject,
): PreparedRowBundle {
  return {
    rows: [],
    skippedRecords: [
      {
        artifactUri: params.artifactUri,
        reason: `${reason} (${params.filePath})`,
        sourcePayload,
      },
    ],
  };
}

function pick(record: JsonObject, columns: readonly string[]): JsonObject {
  return Object.fromEntries(columns.map((column) => [column, normalizeAppraisalColumnValue(column, record[column])]));
}

function normalizeAppraisalColumnValue(columnName: string, value: unknown): unknown {
  if (APPRAISAL_INTEGER_COLUMNS.has(columnName)) return readInteger(value);
  if (APPRAISAL_NUMERIC_COLUMNS.has(columnName)) return readNumber(value);
  if (APPRAISAL_DATE_COLUMNS.has(columnName)) return readDate(value);
  if (APPRAISAL_BOOLEAN_COLUMNS.has(columnName)) return readBoolean(value);
  return value;
}

function metadata(sourceRecordKey: string, record: JsonObject, artifactUri: string | null): JsonObject {
  return buildSourceMetadata({
    sourceSystem: APPRAISER_SOURCE_SYSTEM,
    sourceRecordKey,
    sourcePayload: record,
    sourceArtifactUri: artifactUri,
  });
}

function sourceKey(requestIdentifier: string, classType: string, localKey: string): string {
  return `lee_appraiser:${requestIdentifier}:${classType}:${localKey}`;
}

function readCountyName(record: JsonObject): string | null {
  const entryHttpRequest = isJsonObject(record.entry_http_request) ? record.entry_http_request : null;
  const multiValueQueryString = isJsonObject(entryHttpRequest?.multiValueQueryString)
    ? entryHttpRequest.multiValueQueryString
    : null;
  const appValues = Array.isArray(multiValueQueryString?.App)
    ? multiValueQueryString.App
    : [];
  const appName = readString(appValues[0]);
  return appName?.replace(/CountyFL$/i, "") ?? null;
}

function jsonObjectOrNull(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}
