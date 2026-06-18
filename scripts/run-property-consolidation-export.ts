import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PropertyConsolidationOptions = {
  readonly limit: number | null;
  readonly outDir: string;
  readonly county: string;
  readonly envFile: string;
};

type AddressShape = {
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
};

type PropertyShape = {
  readonly propertyType: string | null;
  readonly usageType: string | null;
  readonly structureForm: string | null;
  readonly buildStatus: string | null;
  readonly builtYear: number | null;
  readonly effectiveBuiltYear: number | null;
  readonly historicDesignation: boolean | null;
  readonly livableArea: string | null;
  readonly totalArea: string | null;
  readonly areaUnderAir: string | null;
  readonly numberOfUnits: number | null;
  readonly subdivision: string | null;
  readonly zoning: string | null;
  readonly legalDescription: string | null;
};

type ParcelShape = {
  readonly parcelIdentifier: string;
  readonly countyName: string | null;
  readonly stateCode: string | null;
};

type GeometryShape = {
  readonly latitude: string;
  readonly longitude: string;
};

type OwnershipShape = {
  readonly ownedBy: string | null;
  readonly ownershipPercentage: string | null;
  readonly ownerOccupied: boolean | null;
  readonly dateAcquired: string | null;
  readonly dateSold: string | null;
};

type TaxShape = {
  readonly taxYear: number | null;
  readonly assessedValue: string | null;
  readonly marketValue: string | null;
  readonly buildingValue: string | null;
  readonly landValue: string | null;
  readonly taxableValue: string | null;
  readonly yearlyTaxAmount: string | null;
};

type SaleShape = {
  readonly date: string | null;
  readonly price: string | null;
  readonly saleType: string | null;
  readonly instrumentNumber: string | null;
};

type StructureShape = {
  readonly architecturalStyle: string | null;
  readonly attachmentType: string | null;
  readonly exteriorWall: string | null;
  readonly roofCovering: string | null;
  readonly roofDesign: string | null;
  readonly foundationType: string | null;
  readonly numberOfStories: string | null;
  readonly finishedBaseArea: number | null;
};

type LotShape = {
  readonly lotType: string | null;
  readonly lotAreaSqft: string | null;
  readonly lotSizeAcre: string | null;
  readonly landscapingFeatures: string | null;
  readonly view: string | null;
};

type LayoutShape = {
  readonly spaceType: string | null;
  readonly spaceIndex: number | null;
  readonly builtYear: number | null;
  readonly sizeSquareFeet: string | null;
  readonly livableAreaSqFt: string | null;
};

type UtilityShape = {
  readonly coolingSystem: string | null;
  readonly heatingSystem: string | null;
  readonly heatingFuel: string | null;
  readonly sewer: string | null;
  readonly waterSource: string | null;
  readonly solarPanel: boolean | null;
  readonly hvacCapacityTons: string | null;
};

type FloodInfoShape = {
  readonly floodZone: string | null;
  readonly evacuationZone: string | null;
  readonly floodInsuranceRequired: boolean | null;
};

type DeedShape = {
  readonly deedType: string | null;
  readonly book: string | null;
  readonly page: string | null;
  readonly instrumentNumber: string | null;
};

type FileShape = {
  readonly documentType: string | null;
  readonly fileFormat: string | null;
  readonly ipfsUrl: string | null;
  readonly name: string | null;
};

type ValuationShape = {
  readonly valuationDate: string | null;
  readonly avmValue: string | null;
  readonly highValue: string | null;
  readonly lowValue: string | null;
  readonly confidenceScore: number | null;
};

type PermitContactShape = {
  readonly contactRole: string;
  readonly rawName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly licenseNumber: string | null;
};

type PermitCustomFieldShape = {
  readonly fieldGroup: string | null;
  readonly fieldName: string;
  readonly fieldValue: string | null;
};

type PermitEventShape = {
  readonly eventType: string;
  readonly eventStatus: string | null;
  readonly eventDate: string | null;
  readonly actorName: string | null;
  readonly commentText: string | null;
};

type PermitFeeShape = {
  readonly feeCode: string | null;
  readonly feeDescription: string | null;
  readonly feeStatus: string | null;
  readonly assessedAmount: string | null;
  readonly paidAmount: string | null;
};

type PermitLinkShape = {
  readonly linkKind: string;
  readonly text: string | null;
  readonly url: string;
  readonly title: string | null;
};

type InspectionShape = {
  readonly inspectionNumber: string | null;
  readonly inspectionStatus: string | null;
  readonly inspectionType: string | null;
  readonly completedDate: string | null;
  readonly result: string | null;
  readonly resultComment: string | null;
};

type PermitShape = {
  readonly permitNumber: string | null;
  readonly improvementType: string | null;
  readonly completionDate: string | null;
  readonly recordStatus: string | null;
  readonly estimatedJobValue: string | null;
  readonly estimatedSqFt: string | null;
  readonly projectDescription: string | null;
  readonly contacts: readonly PermitContactShape[];
  readonly customFields: readonly PermitCustomFieldShape[];
  readonly events: readonly PermitEventShape[];
  readonly fees: readonly PermitFeeShape[];
  readonly links: readonly PermitLinkShape[];
  readonly inspections: readonly InspectionShape[];
};

type SunbizAddressShape = {
  readonly addressRole: string;
  readonly line1: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
};

type SunbizPartyShape = {
  readonly partyRole: string;
  readonly name: string;
  readonly title: string | null;
  readonly addressSingleLine: string | null;
};

type SunbizAnnualReportShape = {
  readonly reportYear: string | null;
  readonly reportDate: string | null;
};

type SunbizTenantShape = {
  readonly documentNumber: string;
  readonly entityName: string | null;
  readonly status: string | null;
  readonly filingType: string | null;
  readonly filedDate: string | null;
  readonly addresses: readonly SunbizAddressShape[];
  readonly parties: readonly SunbizPartyShape[];
  readonly annualReports: readonly SunbizAnnualReportShape[];
};

type BbbProfileShape = {
  readonly name: string | null;
  readonly profileUrl: string | null;
  readonly bbbRating: string | null;
  readonly isAccredited: boolean | null;
  readonly reviewCount: number | null;
  readonly complaintCount: number | null;
  readonly qualityScore: string | null;
  readonly scoreBand: string | null;
  readonly reviews: readonly BbbReviewShape[];
  readonly complaints: readonly BbbComplaintShape[];
};

type BbbReviewShape = {
  readonly reviewDate: string | null;
  readonly reviewRating: string | null;
  readonly reviewTitle: string | null;
  readonly reviewText: string | null;
  readonly reviewerDisplayName: string | null;
};

type BbbComplaintShape = {
  readonly complaintDate: string | null;
  readonly complaintType: string | null;
  readonly complaintStatus: string | null;
  readonly complaintSummary: string | null;
};

export type ConsolidatedProperty = {
  readonly parcelId: string | null;
  readonly county: string;
  readonly jurisdictionKey: string | null;
  readonly sourceSystem: string | null;
  readonly address: AddressShape;
  readonly property: PropertyShape;
  readonly parcel: ParcelShape;
  readonly geometry: GeometryShape | null;
  readonly ownerships: readonly OwnershipShape[];
  readonly taxes: readonly TaxShape[];
  readonly sales: readonly SaleShape[];
  readonly structures: readonly StructureShape[];
  readonly lots: readonly LotShape[];
  readonly layouts: readonly LayoutShape[];
  readonly utilities: readonly UtilityShape[];
  readonly floodInfo: FloodInfoShape | null;
  readonly deeds: readonly DeedShape[];
  readonly files: readonly FileShape[];
  readonly valuations: readonly ValuationShape[];
  readonly permits: readonly PermitShape[];
  readonly sunbizTenants: readonly SunbizTenantShape[];
  readonly bbbProfiles: readonly BbbProfileShape[];
  readonly collectedAt: string;
};

export type ManifestEntry = {
  readonly parcelIdentifier: string;
  readonly filePath: string;
  readonly fileSizeBytes: number;
  readonly sha256: string;
  readonly cid: string | null;
};

export type ManifestSummary = {
  readonly schemaVersion: "1";
  readonly exportedAt: string;
  readonly completedAt: string;
  readonly county: string;
  readonly propertyCount: number;
  readonly totalBytes: number;
  readonly minBytes: number;
  readonly avgBytes: number;
  readonly maxBytes: number;
  readonly projectedBytes300k: number;
  readonly entries: readonly ManifestEntry[];
};

// ---------------------------------------------------------------------------
// DB row types (raw Postgres result shapes)
// ---------------------------------------------------------------------------

type PropertyRow = {
  property_id: string;
  parcel_id: string | null;
  address_id: string | null;
  parcel_identifier: string;
  property_type: string | null;
  property_usage_type: string | null;
  structure_form: string | null;
  build_status: string | null;
  property_structure_built_year: number | null;
  property_effective_built_year: number | null;
  historic_designation: boolean | null;
  livable_floor_area: string | null;
  total_area: string | null;
  area_under_air: string | null;
  number_of_units: number | null;
  subdivision: string | null;
  zoning: string | null;
  property_legal_description_text: string | null;
  source_system: string | null;
};

type ParcelRow = {
  parcel_id: string;
  parcel_identifier: string;
  county_name: string | null;
  state_code: string | null;
  jurisdiction_key: string | null;
};

type AddressRow = {
  address_id: string;
  street_number: string | null;
  street_name: string | null;
  street_suffix_type: string | null;
  city_name: string | null;
  state_code: string | null;
  postal_code: string | null;
  latitude: string | null;
  longitude: string | null;
  normalized_address_key: string | null;
};

type TaxRow = {
  property_id: string;
  tax_year: number | null;
  property_assessed_value_amount: string | null;
  property_market_value_amount: string | null;
  property_building_amount: string | null;
  property_land_amount: string | null;
  property_taxable_value_amount: string | null;
  yearly_tax_amount: string | null;
};

type SalesHistoryRow = {
  property_id: string;
  ownership_transfer_date: string | null;
  purchase_price_amount: string | null;
  sale_type: string | null;
  instrument_number: string | null;
};

type StructureRow = {
  property_id: string;
  architectural_style_type: string | null;
  attachment_type: string | null;
  exterior_wall_material_primary: string | null;
  roof_covering_material: string | null;
  roof_design_type: string | null;
  foundation_type: string | null;
  number_of_stories: string | null;
  finished_base_area: number | null;
};

type LayoutRow = {
  property_id: string;
  space_type: string | null;
  space_index: number | null;
  built_year: number | null;
  size_square_feet: string | null;
  livable_area_sq_ft: string | null;
};

type LotRow = {
  property_id: string;
  lot_type: string | null;
  lot_area_sqft: string | null;
  lot_size_acre: string | null;
  landscaping_features: string | null;
  view: string | null;
};

type FloodStormRow = {
  property_id: string;
  flood_zone: string | null;
  evacuation_zone: string | null;
  flood_insurance_required: boolean | null;
};

type UtilityRow = {
  property_id: string;
  cooling_system_type: string | null;
  heating_system_type: string | null;
  heating_fuel_type: string | null;
  sewer_type: string | null;
  water_source_type: string | null;
  solar_panel_present: boolean | null;
  hvac_capacity_tons: string | null;
};

type OwnershipRow = {
  property_id: string;
  owned_by: string | null;
  ownership_percentage: string | null;
  owner_occupied_indicator: boolean | null;
  date_acquired: string | null;
  date_sold: string | null;
};

type DeedRow = {
  property_id: string;
  deed_type: string | null;
  book: string | null;
  page: string | null;
  instrument_number: string | null;
};

type FileRow = {
  property_id: string;
  document_type: string | null;
  file_format: string | null;
  ipfs_url: string | null;
  name: string | null;
};

type GeometryRow = {
  property_id: string;
  latitude: string | null;
  longitude: string | null;
};

type ValuationRow = {
  property_id: string;
  valuation_date: string | null;
  current_avm_value: string | null;
  high_value: string | null;
  low_value: string | null;
  confidence_score: number | null;
};

type PermitRow = {
  property_improvement_id: string;
  parcel_identifier: string | null;
  permit_number: string | null;
  improvement_type: string | null;
  completion_date: string | null;
  record_status: string | null;
  estimated_job_value: string | null;
  estimated_sq_ft: string | null;
  project_description: string | null;
  contractor_company_id: string | null;
};

type PermitContactRow = {
  property_improvement_id: string;
  contact_role: string;
  raw_name: string | null;
  phone: string | null;
  email: string | null;
  license_number: string | null;
};

type PermitCustomFieldRow = {
  property_improvement_id: string;
  field_group: string | null;
  field_name: string;
  field_value: string | null;
};

type PermitEventRow = {
  property_improvement_id: string;
  event_type: string;
  event_status: string | null;
  event_date: string | null;
  actor_name: string | null;
  comment_text: string | null;
};

type PermitFeeRow = {
  property_improvement_id: string;
  fee_code: string | null;
  fee_description: string | null;
  fee_status: string | null;
  assessed_amount: string | null;
  paid_amount: string | null;
};

type PermitLinkRow = {
  property_improvement_id: string;
  link_kind: string;
  text: string | null;
  url: string;
  title: string | null;
};

type InspectionRow = {
  property_improvement_id: string;
  inspection_number: string | null;
  inspection_status: string | null;
  inspection_type: string | null;
  completed_date: string | null;
  result: string | null;
  result_comment: string | null;
};

type SunbizRegistrationRow = {
  business_registration_id: string;
  document_number: string;
  entity_name: string | null;
  status: string | null;
  filing_type: string | null;
  filed_date: string | null;
  normalized_address_key: string | null;
};

type SunbizAddressRow = {
  business_registration_id: string;
  address_role: string;
  line_1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

type SunbizPartyRow = {
  business_registration_id: string;
  party_role: string;
  name: string;
  title: string | null;
  address_single_line: string | null;
};

type SunbizAnnualReportRow = {
  business_registration_id: string;
  report_year: string | null;
  report_date: string | null;
};

type BbbProfileRow = {
  business_reputation_profile_id: string;
  company_id: string | null;
  name: string | null;
  profile_url: string | null;
  bbb_rating: string | null;
  is_accredited: boolean | null;
  review_count: number | null;
  complaint_count: number | null;
};

type BbbQualityScoreRow = {
  business_reputation_profile_id: string;
  score: string | null;
  score_band: string | null;
};

type BbbReviewRow = {
  business_reputation_profile_id: string;
  review_date: string | null;
  review_rating: string | null;
  review_title: string | null;
  review_text: string | null;
  reviewer_display_name: string | null;
};

type BbbComplaintRow = {
  business_reputation_profile_id: string;
  complaint_date: string | null;
  complaint_type: string | null;
  complaint_status: string | null;
  complaint_summary: string | null;
};

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into property consolidation export options.
 */
export function parseOptions(argv: readonly string[]): PropertyConsolidationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const limitRaw = values.get("limit");
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : null;

  return {
    limit: limit !== null && !Number.isNaN(limit) ? limit : null,
    outDir: values.get("out-dir") ?? ".property-consolidation-export",
    county: values.get("county") ?? "lee",
    envFile: values.get("env-file") ?? ".env.local",
  };
}

// ---------------------------------------------------------------------------
// Env file loader
// ---------------------------------------------------------------------------

function loadEnvFile(envFile: string): void {
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex);
      const value = trimmed.slice(equalsIndex + 1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && (caught as NodeJS.ErrnoException).code === "ENOENT") return;
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// Hashing utilities
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a file by streaming its contents.
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const readStream = createReadStream(filePath);
  await pipeline(readStream, hash);
  return hash.digest("hex");
}

/**
 * Compute the IPFS CIDv0 of a buffer. Best-effort — returns null on any error.
 */
export async function computeIpfsCid(content: Buffer): Promise<string | null> {
  try {
    // ipfs-only-hash is CommonJS; use createRequire for NodeNext compat
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const ipfsHash = require("ipfs-only-hash") as { of: (content: Buffer) => Promise<string> };
    const cid = await ipfsHash.of(content);
    return cid;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parcel identifier normalization
// ---------------------------------------------------------------------------

function normalizeParcelIdentifier(identifier: string): string {
  return identifier.replace(/[^0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

function groupBy<TRow>(rows: readonly TRow[], keyFn: (row: TRow) => string): Map<string, TRow[]> {
  const map = new Map<string, TRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.push(row);
    } else {
      map.set(key, [row]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pure assembly function
// ---------------------------------------------------------------------------

type AssembleParams = {
  readonly property: PropertyRow;
  readonly parcel: ParcelRow | null;
  readonly address: AddressRow | null;
  readonly taxes: readonly TaxRow[];
  readonly salesHistories: readonly SalesHistoryRow[];
  readonly structures: readonly StructureRow[];
  readonly layouts: readonly LayoutRow[];
  readonly lots: readonly LotRow[];
  readonly floodStorm: readonly FloodStormRow[];
  readonly utilities: readonly UtilityRow[];
  readonly ownerships: readonly OwnershipRow[];
  readonly deeds: readonly DeedRow[];
  readonly files: readonly FileRow[];
  readonly geometries: readonly GeometryRow[];
  readonly valuations: readonly ValuationRow[];
  readonly permits: readonly PermitWithChildren[];
  readonly sunbizTenants: readonly SunbizTenantWithChildren[];
  readonly bbbProfiles: readonly BbbProfileWithChildren[];
  readonly county: string;
  readonly collectedAt: string;
};

type PermitWithChildren = {
  readonly permit: PermitRow;
  readonly contacts: readonly PermitContactRow[];
  readonly customFields: readonly PermitCustomFieldRow[];
  readonly events: readonly PermitEventRow[];
  readonly fees: readonly PermitFeeRow[];
  readonly links: readonly PermitLinkRow[];
  readonly inspections: readonly InspectionRow[];
};

type SunbizTenantWithChildren = {
  readonly registration: SunbizRegistrationRow;
  readonly addresses: readonly SunbizAddressRow[];
  readonly parties: readonly SunbizPartyRow[];
  readonly annualReports: readonly SunbizAnnualReportRow[];
};

type BbbProfileWithChildren = {
  readonly profile: BbbProfileRow;
  readonly qualityScore: BbbQualityScoreRow | null;
  readonly reviews: readonly BbbReviewRow[];
  readonly complaints: readonly BbbComplaintRow[];
};

/**
 * Assemble a ConsolidatedProperty from raw DB row data. Pure function — no DB calls.
 */
export function assemblePropertyRecord(params: AssembleParams): ConsolidatedProperty {
  const { property, parcel, address, county, collectedAt } = params;

  const street = address !== null
    ? [address.street_number, address.street_name, address.street_suffix_type]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(" ") || null
    : null;

  const addressShape: AddressShape = {
    street,
    city: address?.city_name ?? null,
    state: address?.state_code ?? null,
    postalCode: address?.postal_code ?? null,
    latitude: address?.latitude ?? null,
    longitude: address?.longitude ?? null,
  };

  const propertyShape: PropertyShape = {
    propertyType: property.property_type,
    usageType: property.property_usage_type,
    structureForm: property.structure_form,
    buildStatus: property.build_status,
    builtYear: property.property_structure_built_year,
    effectiveBuiltYear: property.property_effective_built_year,
    historicDesignation: property.historic_designation,
    livableArea: property.livable_floor_area,
    totalArea: property.total_area,
    areaUnderAir: property.area_under_air,
    numberOfUnits: property.number_of_units,
    subdivision: property.subdivision,
    zoning: property.zoning,
    legalDescription: property.property_legal_description_text,
  };

  const parcelShape: ParcelShape = {
    parcelIdentifier: property.parcel_identifier,
    countyName: parcel?.county_name ?? null,
    stateCode: parcel?.state_code ?? null,
  };

  const firstGeometry = params.geometries[0] ?? null;
  const geometry: GeometryShape | null =
    firstGeometry !== null &&
    firstGeometry.latitude !== null &&
    firstGeometry.longitude !== null
      ? { latitude: firstGeometry.latitude, longitude: firstGeometry.longitude }
      : null;

  const ownerships: readonly OwnershipShape[] = params.ownerships.map((row) => ({
    ownedBy: row.owned_by,
    ownershipPercentage: row.ownership_percentage,
    ownerOccupied: row.owner_occupied_indicator,
    dateAcquired: row.date_acquired,
    dateSold: row.date_sold,
  }));

  const taxes: readonly TaxShape[] = params.taxes.map((row) => ({
    taxYear: row.tax_year,
    assessedValue: row.property_assessed_value_amount,
    marketValue: row.property_market_value_amount,
    buildingValue: row.property_building_amount,
    landValue: row.property_land_amount,
    taxableValue: row.property_taxable_value_amount,
    yearlyTaxAmount: row.yearly_tax_amount,
  }));

  const sales: readonly SaleShape[] = params.salesHistories.map((row) => ({
    date: row.ownership_transfer_date,
    price: row.purchase_price_amount,
    saleType: row.sale_type,
    instrumentNumber: row.instrument_number,
  }));

  const structures: readonly StructureShape[] = params.structures.map((row) => ({
    architecturalStyle: row.architectural_style_type,
    attachmentType: row.attachment_type,
    exteriorWall: row.exterior_wall_material_primary,
    roofCovering: row.roof_covering_material,
    roofDesign: row.roof_design_type,
    foundationType: row.foundation_type,
    numberOfStories: row.number_of_stories,
    finishedBaseArea: row.finished_base_area,
  }));

  const lots: readonly LotShape[] = params.lots.map((row) => ({
    lotType: row.lot_type,
    lotAreaSqft: row.lot_area_sqft,
    lotSizeAcre: row.lot_size_acre,
    landscapingFeatures: row.landscaping_features,
    view: row.view,
  }));

  const layouts: readonly LayoutShape[] = params.layouts.map((row) => ({
    spaceType: row.space_type,
    spaceIndex: row.space_index,
    builtYear: row.built_year,
    sizeSquareFeet: row.size_square_feet,
    livableAreaSqFt: row.livable_area_sq_ft,
  }));

  const utilities: readonly UtilityShape[] = params.utilities.map((row) => ({
    coolingSystem: row.cooling_system_type,
    heatingSystem: row.heating_system_type,
    heatingFuel: row.heating_fuel_type,
    sewer: row.sewer_type,
    waterSource: row.water_source_type,
    solarPanel: row.solar_panel_present,
    hvacCapacityTons: row.hvac_capacity_tons,
  }));

  const firstFlood = params.floodStorm[0] ?? null;
  const floodInfo: FloodInfoShape | null = firstFlood !== null
    ? {
        floodZone: firstFlood.flood_zone,
        evacuationZone: firstFlood.evacuation_zone,
        floodInsuranceRequired: firstFlood.flood_insurance_required,
      }
    : null;

  const deeds: readonly DeedShape[] = params.deeds.map((row) => ({
    deedType: row.deed_type,
    book: row.book,
    page: row.page,
    instrumentNumber: row.instrument_number,
  }));

  const files: readonly FileShape[] = params.files.map((row) => ({
    documentType: row.document_type,
    fileFormat: row.file_format,
    ipfsUrl: row.ipfs_url,
    name: row.name,
  }));

  const valuations: readonly ValuationShape[] = params.valuations.map((row) => ({
    valuationDate: row.valuation_date,
    avmValue: row.current_avm_value,
    highValue: row.high_value,
    lowValue: row.low_value,
    confidenceScore: row.confidence_score,
  }));

  const permits: readonly PermitShape[] = params.permits.map(({ permit, contacts, customFields, events, fees, links, inspections }) => ({
    permitNumber: permit.permit_number,
    improvementType: permit.improvement_type,
    completionDate: permit.completion_date,
    recordStatus: permit.record_status,
    estimatedJobValue: permit.estimated_job_value,
    estimatedSqFt: permit.estimated_sq_ft,
    projectDescription: permit.project_description,
    contacts: contacts.map((c) => ({
      contactRole: c.contact_role,
      rawName: c.raw_name,
      phone: c.phone,
      email: c.email,
      licenseNumber: c.license_number,
    })),
    customFields: customFields.map((f) => ({
      fieldGroup: f.field_group,
      fieldName: f.field_name,
      fieldValue: f.field_value,
    })),
    events: events.map((e) => ({
      eventType: e.event_type,
      eventStatus: e.event_status,
      eventDate: e.event_date !== null ? String(e.event_date) : null,
      actorName: e.actor_name,
      commentText: e.comment_text,
    })),
    fees: fees.map((f) => ({
      feeCode: f.fee_code,
      feeDescription: f.fee_description,
      feeStatus: f.fee_status,
      assessedAmount: f.assessed_amount,
      paidAmount: f.paid_amount,
    })),
    links: links.map((l) => ({
      linkKind: l.link_kind,
      text: l.text,
      url: l.url,
      title: l.title,
    })),
    inspections: inspections.map((i) => ({
      inspectionNumber: i.inspection_number,
      inspectionStatus: i.inspection_status,
      inspectionType: i.inspection_type,
      completedDate: i.completed_date,
      result: i.result,
      resultComment: i.result_comment,
    })),
  }));

  const sunbizTenants: readonly SunbizTenantShape[] = params.sunbizTenants.map(({ registration, addresses, parties, annualReports }) => ({
    documentNumber: registration.document_number,
    entityName: registration.entity_name,
    status: registration.status,
    filingType: registration.filing_type,
    filedDate: registration.filed_date,
    addresses: addresses.map((a) => ({
      addressRole: a.address_role,
      line1: a.line_1,
      city: a.city,
      state: a.state,
      zip: a.zip,
    })),
    parties: parties.map((p) => ({
      partyRole: p.party_role,
      name: p.name,
      title: p.title,
      addressSingleLine: p.address_single_line,
    })),
    annualReports: annualReports.map((r) => ({
      reportYear: r.report_year,
      reportDate: r.report_date,
    })),
  }));

  const bbbProfiles: readonly BbbProfileShape[] = params.bbbProfiles.map(({ profile, qualityScore, reviews, complaints }) => ({
    name: profile.name,
    profileUrl: profile.profile_url,
    bbbRating: profile.bbb_rating,
    isAccredited: profile.is_accredited,
    reviewCount: profile.review_count,
    complaintCount: profile.complaint_count,
    qualityScore: qualityScore?.score ?? null,
    scoreBand: qualityScore?.score_band ?? null,
    reviews: reviews.map((r) => ({
      reviewDate: r.review_date,
      reviewRating: r.review_rating,
      reviewTitle: r.review_title,
      reviewText: r.review_text,
      reviewerDisplayName: r.reviewer_display_name,
    })),
    complaints: complaints.map((c) => ({
      complaintDate: c.complaint_date,
      complaintType: c.complaint_type,
      complaintStatus: c.complaint_status,
      complaintSummary: c.complaint_summary,
    })),
  }));

  return {
    parcelId: property.parcel_id,
    county,
    jurisdictionKey: parcel?.jurisdiction_key ?? null,
    sourceSystem: property.source_system,
    address: addressShape,
    property: propertyShape,
    parcel: parcelShape,
    geometry,
    ownerships,
    taxes,
    sales,
    structures,
    lots,
    layouts,
    utilities,
    floodInfo,
    deeds,
    files,
    valuations,
    permits,
    sunbizTenants,
    bbbProfiles,
    collectedAt,
  };
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

/**
 * Build a single manifest entry from file metadata.
 */
export function buildManifestEntry(params: {
  readonly parcelIdentifier: string;
  readonly filePath: string;
  readonly fileSizeBytes: number;
  readonly sha256: string;
  readonly cid: string | null;
}): ManifestEntry {
  return {
    parcelIdentifier: params.parcelIdentifier,
    filePath: params.filePath,
    fileSizeBytes: params.fileSizeBytes,
    sha256: params.sha256,
    cid: params.cid,
  };
}

/**
 * Build the manifest summary from all entries and timing info.
 */
export function buildManifestSummary(
  entries: readonly ManifestEntry[],
  startedAt: string,
  completedAt: string,
  county: string,
): ManifestSummary {
  const count = entries.length;
  const totalBytes = entries.reduce((sum, e) => sum + e.fileSizeBytes, 0);
  const minBytes = count > 0 ? Math.min(...entries.map((e) => e.fileSizeBytes)) : 0;
  const maxBytes = count > 0 ? Math.max(...entries.map((e) => e.fileSizeBytes)) : 0;
  const avgBytes = count > 0 ? Math.round(totalBytes / count) : 0;
  const projectedBytes300k = count > 0 ? Math.round((totalBytes / count) * 300_000) : 0;

  return {
    schemaVersion: "1",
    exportedAt: startedAt,
    completedAt,
    county,
    propertyCount: count,
    totalBytes,
    minBytes,
    avgBytes,
    maxBytes,
    projectedBytes300k,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Bulk DB query helpers
// ---------------------------------------------------------------------------

async function fetchProperties(pool: Pool, limit: number | null): Promise<PropertyRow[]> {
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  const result = await pool.query<PropertyRow>(`
    SELECT
      property_id, parcel_id, address_id, parcel_identifier,
      property_type, property_usage_type, structure_form, build_status,
      property_structure_built_year, property_effective_built_year,
      historic_designation, livable_floor_area, total_area, area_under_air,
      number_of_units, subdivision, zoning, property_legal_description_text,
      source_system
    FROM properties
    WHERE source_system = 'lee_appraiser'
    ORDER BY property_id
    ${limitClause}
  `);
  return result.rows;
}

async function fetchParcels(pool: Pool, parcelIds: readonly string[]): Promise<ParcelRow[]> {
  if (parcelIds.length === 0) return [];
  const result = await pool.query<ParcelRow>(
    `SELECT parcel_id, parcel_identifier, county_name, state_code, jurisdiction_key
     FROM parcels WHERE parcel_id = ANY($1::uuid[])`,
    [parcelIds],
  );
  return result.rows;
}

async function fetchAddresses(pool: Pool, addressIds: readonly string[]): Promise<AddressRow[]> {
  if (addressIds.length === 0) return [];
  const result = await pool.query<AddressRow>(
    `SELECT address_id, street_number, street_name, street_suffix_type,
            city_name, state_code, postal_code, latitude, longitude, normalized_address_key
     FROM addresses WHERE address_id = ANY($1::uuid[])`,
    [addressIds],
  );
  return result.rows;
}

async function fetchTaxes(pool: Pool, propertyIds: readonly string[]): Promise<TaxRow[]> {
  const result = await pool.query<TaxRow>(
    `SELECT property_id, tax_year, property_assessed_value_amount, property_market_value_amount,
            property_building_amount, property_land_amount, property_taxable_value_amount, yearly_tax_amount
     FROM taxes WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchSalesHistories(pool: Pool, propertyIds: readonly string[]): Promise<SalesHistoryRow[]> {
  const result = await pool.query<SalesHistoryRow>(
    `SELECT property_id, ownership_transfer_date, purchase_price_amount, sale_type, instrument_number
     FROM sales_histories WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchStructures(pool: Pool, propertyIds: readonly string[]): Promise<StructureRow[]> {
  const result = await pool.query<StructureRow>(
    `SELECT property_id, architectural_style_type, attachment_type, exterior_wall_material_primary,
            roof_covering_material, roof_design_type, foundation_type, number_of_stories, finished_base_area
     FROM structures WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchLayouts(pool: Pool, propertyIds: readonly string[]): Promise<LayoutRow[]> {
  const result = await pool.query<LayoutRow>(
    `SELECT property_id, space_type, space_index, built_year, size_square_feet, livable_area_sq_ft
     FROM layouts WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchLots(pool: Pool, propertyIds: readonly string[]): Promise<LotRow[]> {
  const result = await pool.query<LotRow>(
    `SELECT property_id, lot_type, lot_area_sqft, lot_size_acre, landscaping_features, view
     FROM lots WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchFloodStorm(pool: Pool, propertyIds: readonly string[]): Promise<FloodStormRow[]> {
  const result = await pool.query<FloodStormRow>(
    `SELECT property_id, flood_zone, evacuation_zone, flood_insurance_required
     FROM flood_storm_information WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchUtilities(pool: Pool, propertyIds: readonly string[]): Promise<UtilityRow[]> {
  const result = await pool.query<UtilityRow>(
    `SELECT property_id, cooling_system_type, heating_system_type, heating_fuel_type,
            sewer_type, water_source_type, solar_panel_present, hvac_capacity_tons
     FROM utilities WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchOwnerships(pool: Pool, propertyIds: readonly string[]): Promise<OwnershipRow[]> {
  const result = await pool.query<OwnershipRow>(
    `SELECT property_id, owned_by, ownership_percentage, owner_occupied_indicator, date_acquired, date_sold
     FROM ownerships WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchDeeds(pool: Pool, propertyIds: readonly string[]): Promise<DeedRow[]> {
  const result = await pool.query<DeedRow>(
    `SELECT property_id, deed_type, book, page, instrument_number
     FROM deeds WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchFiles(pool: Pool, propertyIds: readonly string[]): Promise<FileRow[]> {
  const result = await pool.query<FileRow>(
    `SELECT property_id, document_type, file_format, ipfs_url, name
     FROM files WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchGeometries(pool: Pool, propertyIds: readonly string[]): Promise<GeometryRow[]> {
  const result = await pool.query<GeometryRow>(
    `SELECT property_id, latitude, longitude
     FROM geometries WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchValuations(pool: Pool, propertyIds: readonly string[]): Promise<ValuationRow[]> {
  const result = await pool.query<ValuationRow>(
    `SELECT property_id, valuation_date, current_avm_value, high_value, low_value, confidence_score
     FROM property_valuations WHERE property_id = ANY($1::uuid[])`,
    [propertyIds],
  );
  return result.rows;
}

async function fetchPermits(pool: Pool, normalizedParcelIds: readonly string[]): Promise<PermitRow[]> {
  if (normalizedParcelIds.length === 0) return [];
  const result = await pool.query<PermitRow>(
    `SELECT property_improvement_id, parcel_identifier, permit_number, improvement_type,
            completion_date, record_status, estimated_job_value, estimated_sq_ft,
            project_description, contractor_company_id
     FROM property_improvements WHERE parcel_identifier = ANY($1)`,
    [normalizedParcelIds],
  );
  return result.rows;
}

async function fetchPermitContacts(pool: Pool, permitIds: readonly string[]): Promise<PermitContactRow[]> {
  if (permitIds.length === 0) return [];
  const result = await pool.query<PermitContactRow>(
    `SELECT property_improvement_id, contact_role, raw_name, phone, email, license_number
     FROM permit_contacts WHERE property_improvement_id = ANY($1::uuid[])`,
    [permitIds],
  );
  return result.rows;
}

async function fetchPermitCustomFields(pool: Pool, permitIds: readonly string[]): Promise<PermitCustomFieldRow[]> {
  if (permitIds.length === 0) return [];
  const result = await pool.query<PermitCustomFieldRow>(
    `SELECT property_improvement_id, field_group, field_name, field_value
     FROM permit_custom_fields WHERE property_improvement_id = ANY($1::uuid[])`,
    [permitIds],
  );
  return result.rows;
}

async function fetchPermitEvents(pool: Pool, permitIds: readonly string[]): Promise<PermitEventRow[]> {
  if (permitIds.length === 0) return [];
  const result = await pool.query<PermitEventRow>(
    `SELECT property_improvement_id, event_type, event_status, event_date, actor_name, comment_text
     FROM permit_events WHERE property_improvement_id = ANY($1::uuid[])`,
    [permitIds],
  );
  return result.rows;
}

async function fetchPermitFees(pool: Pool, permitIds: readonly string[]): Promise<PermitFeeRow[]> {
  if (permitIds.length === 0) return [];
  const result = await pool.query<PermitFeeRow>(
    `SELECT property_improvement_id, fee_code, fee_description, fee_status, assessed_amount, paid_amount
     FROM permit_fees WHERE property_improvement_id = ANY($1::uuid[])`,
    [permitIds],
  );
  return result.rows;
}

async function fetchPermitLinks(pool: Pool, permitIds: readonly string[]): Promise<PermitLinkRow[]> {
  if (permitIds.length === 0) return [];
  const result = await pool.query<PermitLinkRow>(
    `SELECT property_improvement_id, link_kind, text, url, title
     FROM permit_links WHERE property_improvement_id = ANY($1::uuid[])`,
    [permitIds],
  );
  return result.rows;
}

async function fetchInspections(pool: Pool, permitIds: readonly string[]): Promise<InspectionRow[]> {
  if (permitIds.length === 0) return [];
  const result = await pool.query<InspectionRow>(
    `SELECT property_improvement_id, inspection_number, inspection_status, inspection_type,
            completed_date, result, result_comment
     FROM inspections WHERE property_improvement_id = ANY($1::uuid[])`,
    [permitIds],
  );
  return result.rows;
}

async function fetchSunbizRegistrations(
  pool: Pool,
  normalizedAddressKeys: readonly string[],
): Promise<SunbizRegistrationRow[]> {
  if (normalizedAddressKeys.length === 0) return [];
  const result = await pool.query<SunbizRegistrationRow>(
    `SELECT br.business_registration_id, br.document_number, br.entity_name, br.status,
            br.filing_type, br.filed_date, a_prop.normalized_address_key
     FROM business_registrations br
     JOIN business_registration_addresses bra ON bra.business_registration_id = br.business_registration_id
       AND bra.address_role = 'PRINCIPAL'
     JOIN addresses a_sun ON a_sun.address_id = bra.address_id
     JOIN addresses a_prop ON a_prop.normalized_address_key = a_sun.normalized_address_key
     WHERE a_prop.normalized_address_key = ANY($1)`,
    [normalizedAddressKeys],
  );
  return result.rows;
}

async function fetchSunbizAddresses(pool: Pool, registrationIds: readonly string[]): Promise<SunbizAddressRow[]> {
  if (registrationIds.length === 0) return [];
  const result = await pool.query<SunbizAddressRow>(
    `SELECT business_registration_id, address_role, line_1, city, state, zip
     FROM business_registration_addresses WHERE business_registration_id = ANY($1::uuid[])`,
    [registrationIds],
  );
  return result.rows;
}

async function fetchSunbizParties(pool: Pool, registrationIds: readonly string[]): Promise<SunbizPartyRow[]> {
  if (registrationIds.length === 0) return [];
  const result = await pool.query<SunbizPartyRow>(
    `SELECT business_registration_id, party_role, name, title, address_single_line
     FROM business_registration_parties WHERE business_registration_id = ANY($1::uuid[])`,
    [registrationIds],
  );
  return result.rows;
}

async function fetchSunbizAnnualReports(pool: Pool, registrationIds: readonly string[]): Promise<SunbizAnnualReportRow[]> {
  if (registrationIds.length === 0) return [];
  const result = await pool.query<SunbizAnnualReportRow>(
    `SELECT business_registration_id, report_year, report_date
     FROM business_registration_annual_reports WHERE business_registration_id = ANY($1::uuid[])`,
    [registrationIds],
  );
  return result.rows;
}

async function fetchBbbProfiles(pool: Pool, companyIds: readonly string[]): Promise<BbbProfileRow[]> {
  if (companyIds.length === 0) return [];
  const result = await pool.query<BbbProfileRow>(
    `SELECT business_reputation_profile_id, company_id, name, profile_url,
            bbb_rating, is_accredited, review_count, complaint_count
     FROM business_reputation_profiles WHERE company_id = ANY($1::uuid[])`,
    [companyIds],
  );
  return result.rows;
}

async function fetchBbbQualityScores(pool: Pool, profileIds: readonly string[]): Promise<BbbQualityScoreRow[]> {
  if (profileIds.length === 0) return [];
  const result = await pool.query<BbbQualityScoreRow>(
    `SELECT business_reputation_profile_id, score, score_band
     FROM contractor_quality_scores WHERE business_reputation_profile_id = ANY($1::uuid[])`,
    [profileIds],
  );
  return result.rows;
}

async function fetchBbbReviews(pool: Pool, profileIds: readonly string[]): Promise<BbbReviewRow[]> {
  if (profileIds.length === 0) return [];
  const result = await pool.query<BbbReviewRow>(
    `SELECT business_reputation_profile_id, review_date, review_rating, review_title, review_text, reviewer_display_name
     FROM business_reputation_reviews WHERE business_reputation_profile_id = ANY($1::uuid[])`,
    [profileIds],
  );
  return result.rows;
}

async function fetchBbbComplaints(pool: Pool, profileIds: readonly string[]): Promise<BbbComplaintRow[]> {
  if (profileIds.length === 0) return [];
  const result = await pool.query<BbbComplaintRow>(
    `SELECT business_reputation_profile_id, complaint_date, complaint_type, complaint_status, complaint_summary
     FROM business_reputation_complaints WHERE business_reputation_profile_id = ANY($1::uuid[])`,
    [profileIds],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile} or the environment`);
  }

  const startedAt = new Date().toISOString();

  console.log(JSON.stringify({
    event: "property_consolidation_export_started",
    county: options.county,
    limit: options.limit,
    outDir: options.outDir,
    startedAt,
  }));

  const pg = new Pool({
    application_name: "elephant-property-consolidation-export",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 5,
  });

  pg.on("error", (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "database_pool_error", error: message }));
  });

  try {
    const propertiesDir = join(options.outDir, "properties");
    await mkdir(propertiesDir, { recursive: true });

    // 1. Fetch all properties
    const properties = await fetchProperties(pg, options.limit);
    const propertyCount = properties.length;

    console.log(JSON.stringify({ event: "properties_fetched", count: propertyCount }));

    if (propertyCount === 0) {
      const completedAt = new Date().toISOString();
      const manifest = buildManifestSummary([], startedAt, completedAt, options.county);
      await writeFile(join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(JSON.stringify({ event: "property_consolidation_export_finished", count: 0 }));
      return;
    }

    const propertyIds = properties.map((p) => p.property_id);
    const parcelIdSet = new Set(properties.map((p) => p.parcel_id).filter((id): id is string => id !== null));
    const addressIdSet = new Set(properties.map((p) => p.address_id).filter((id): id is string => id !== null));
    const rawParcelIdentifiers = [...new Set(properties.map((p) => p.parcel_identifier))];
    const normalizedParcelIdentifiers = [...new Set(rawParcelIdentifiers.map(normalizeParcelIdentifier))];

    // 2. Bulk fetch all related data in parallel where possible
    const [
      parcels,
      addresses,
      taxes,
      salesHistories,
      structures,
      layouts,
      lots,
      floodStorm,
      utilities,
      ownerships,
      deeds,
      files,
      geometries,
      valuations,
      permits,
    ] = await Promise.all([
      fetchParcels(pg, [...parcelIdSet]),
      fetchAddresses(pg, [...addressIdSet]),
      fetchTaxes(pg, propertyIds),
      fetchSalesHistories(pg, propertyIds),
      fetchStructures(pg, propertyIds),
      fetchLayouts(pg, propertyIds),
      fetchLots(pg, propertyIds),
      fetchFloodStorm(pg, propertyIds),
      fetchUtilities(pg, propertyIds),
      fetchOwnerships(pg, propertyIds),
      fetchDeeds(pg, propertyIds),
      fetchFiles(pg, propertyIds),
      fetchGeometries(pg, propertyIds),
      fetchValuations(pg, propertyIds),
      fetchPermits(pg, normalizedParcelIdentifiers),
    ]);

    // 3. Fetch permit children and Sunbiz/BBB data
    const permitIds = permits.map((p) => p.property_improvement_id);
    const companyIds = [
      ...new Set(permits.map((p) => p.contractor_company_id).filter((id): id is string => id !== null)),
    ];

    const addressMap = new Map(addresses.map((a) => [a.address_id, a]));
    const normalizedAddressKeys = [
      ...new Set(
        properties
          .map((p) => (p.address_id !== null ? addressMap.get(p.address_id)?.normalized_address_key : null))
          .filter((key): key is string => key !== null && key !== undefined && key.length > 0),
      ),
    ];

    const [
      permitContacts,
      permitCustomFields,
      permitEvents,
      permitFees,
      permitLinks,
      inspections,
      sunbizRegistrations,
      bbbProfiles,
    ] = await Promise.all([
      fetchPermitContacts(pg, permitIds),
      fetchPermitCustomFields(pg, permitIds),
      fetchPermitEvents(pg, permitIds),
      fetchPermitFees(pg, permitIds),
      fetchPermitLinks(pg, permitIds),
      fetchInspections(pg, permitIds),
      fetchSunbizRegistrations(pg, normalizedAddressKeys),
      fetchBbbProfiles(pg, companyIds),
    ]);

    const sunbizRegistrationIds = sunbizRegistrations.map((r) => r.business_registration_id);
    const bbbProfileIds = bbbProfiles.map((p) => p.business_reputation_profile_id);

    const [
      sunbizAddresses,
      sunbizParties,
      sunbizAnnualReports,
      bbbQualityScores,
      bbbReviews,
      bbbComplaints,
    ] = await Promise.all([
      fetchSunbizAddresses(pg, sunbizRegistrationIds),
      fetchSunbizParties(pg, sunbizRegistrationIds),
      fetchSunbizAnnualReports(pg, sunbizRegistrationIds),
      fetchBbbQualityScores(pg, bbbProfileIds),
      fetchBbbReviews(pg, bbbProfileIds),
      fetchBbbComplaints(pg, bbbProfileIds),
    ]);

    // 4. Build in-memory lookup maps
    const parcelMap = new Map(parcels.map((p) => [p.parcel_id, p]));
    const taxMap = groupBy(taxes, (r) => r.property_id);
    const salesMap = groupBy(salesHistories, (r) => r.property_id);
    const structureMap = groupBy(structures, (r) => r.property_id);
    const layoutMap = groupBy(layouts, (r) => r.property_id);
    const lotMap = groupBy(lots, (r) => r.property_id);
    const floodMap = groupBy(floodStorm, (r) => r.property_id);
    const utilityMap = groupBy(utilities, (r) => r.property_id);
    const ownershipMap = groupBy(ownerships, (r) => r.property_id);
    const deedMap = groupBy(deeds, (r) => r.property_id);
    const fileMap = groupBy(files, (r) => r.property_id);
    const geometryMap = groupBy(geometries, (r) => r.property_id);
    const valuationMap = groupBy(valuations, (r) => r.property_id);

    // Permit maps: keyed by normalized parcel_identifier
    const permitsByNormalizedParcel = groupBy(permits, (r) =>
      r.parcel_identifier !== null ? r.parcel_identifier : "",
    );
    const permitContactMap = groupBy(permitContacts, (r) => r.property_improvement_id);
    const permitCustomFieldMap = groupBy(permitCustomFields, (r) => r.property_improvement_id);
    const permitEventMap = groupBy(permitEvents, (r) => r.property_improvement_id);
    const permitFeeMap = groupBy(permitFees, (r) => r.property_improvement_id);
    const permitLinkMap = groupBy(permitLinks, (r) => r.property_improvement_id);
    const inspectionMap = groupBy(inspections, (r) => r.property_improvement_id);

    // Sunbiz maps: keyed by normalized_address_key
    const sunbizByAddressKey = groupBy(sunbizRegistrations, (r) => r.normalized_address_key ?? "");
    const sunbizAddressMap = groupBy(sunbizAddresses, (r) => r.business_registration_id);
    const sunbizPartyMap = groupBy(sunbizParties, (r) => r.business_registration_id);
    const sunbizAnnualReportMap = groupBy(sunbizAnnualReports, (r) => r.business_registration_id);

    // BBB maps: keyed by company_id and profile_id
    const bbbProfilesByCompany = groupBy(bbbProfiles, (r) => r.company_id ?? "");
    const bbbQualityScoreMap = new Map(bbbQualityScores.map((s) => [s.business_reputation_profile_id, s]));
    const bbbReviewMap = groupBy(bbbReviews, (r) => r.business_reputation_profile_id);
    const bbbComplaintMap = groupBy(bbbComplaints, (r) => r.business_reputation_profile_id);

    // 5. Assemble and write each property file
    const collectedAt = new Date().toISOString();
    const manifestEntries: ManifestEntry[] = [];
    let processedCount = 0;

    for (const property of properties) {
      const parcel = property.parcel_id !== null ? (parcelMap.get(property.parcel_id) ?? null) : null;
      const address = property.address_id !== null ? (addressMap.get(property.address_id) ?? null) : null;
      const propertyNormalizedParcel = normalizeParcelIdentifier(property.parcel_identifier);
      const propertyPermits = permitsByNormalizedParcel.get(propertyNormalizedParcel) ?? [];

      const permitsWithChildren: PermitWithChildren[] = propertyPermits.map((permit) => ({
        permit,
        contacts: permitContactMap.get(permit.property_improvement_id) ?? [],
        customFields: permitCustomFieldMap.get(permit.property_improvement_id) ?? [],
        events: permitEventMap.get(permit.property_improvement_id) ?? [],
        fees: permitFeeMap.get(permit.property_improvement_id) ?? [],
        links: permitLinkMap.get(permit.property_improvement_id) ?? [],
        inspections: inspectionMap.get(permit.property_improvement_id) ?? [],
      }));

      const addressKey = address?.normalized_address_key ?? null;
      const sunbizRegs = addressKey !== null ? (sunbizByAddressKey.get(addressKey) ?? []) : [];
      const sunbizTenantsWithChildren: SunbizTenantWithChildren[] = sunbizRegs.map((reg) => ({
        registration: reg,
        addresses: sunbizAddressMap.get(reg.business_registration_id) ?? [],
        parties: sunbizPartyMap.get(reg.business_registration_id) ?? [],
        annualReports: sunbizAnnualReportMap.get(reg.business_registration_id) ?? [],
      }));

      const propertyCompanyIds = [...new Set(propertyPermits.map((p) => p.contractor_company_id).filter((id): id is string => id !== null))];
      const bbbProfilesForProperty = propertyCompanyIds.flatMap((cid) => bbbProfilesByCompany.get(cid) ?? []);
      const bbbProfilesWithChildren: BbbProfileWithChildren[] = bbbProfilesForProperty.map((profile) => ({
        profile,
        qualityScore: bbbQualityScoreMap.get(profile.business_reputation_profile_id) ?? null,
        reviews: bbbReviewMap.get(profile.business_reputation_profile_id) ?? [],
        complaints: bbbComplaintMap.get(profile.business_reputation_profile_id) ?? [],
      }));

      const consolidated = assemblePropertyRecord({
        property,
        parcel,
        address,
        taxes: taxMap.get(property.property_id) ?? [],
        salesHistories: salesMap.get(property.property_id) ?? [],
        structures: structureMap.get(property.property_id) ?? [],
        layouts: layoutMap.get(property.property_id) ?? [],
        lots: lotMap.get(property.property_id) ?? [],
        floodStorm: floodMap.get(property.property_id) ?? [],
        utilities: utilityMap.get(property.property_id) ?? [],
        ownerships: ownershipMap.get(property.property_id) ?? [],
        deeds: deedMap.get(property.property_id) ?? [],
        files: fileMap.get(property.property_id) ?? [],
        geometries: geometryMap.get(property.property_id) ?? [],
        valuations: valuationMap.get(property.property_id) ?? [],
        permits: permitsWithChildren,
        sunbizTenants: sunbizTenantsWithChildren,
        bbbProfiles: bbbProfilesWithChildren,
        county: options.county,
        collectedAt,
      });

      const json = `${JSON.stringify(consolidated, null, 2)}\n`;
      const buffer = Buffer.from(json, "utf8");
      const safeParcelIdentifier = property.parcel_identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = join(propertiesDir, `${safeParcelIdentifier}.json`);

      await writeFile(filePath, buffer);

      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const cid = await computeIpfsCid(buffer);

      manifestEntries.push(buildManifestEntry({
        parcelIdentifier: property.parcel_identifier,
        filePath,
        fileSizeBytes: buffer.length,
        sha256,
        cid,
      }));

      processedCount += 1;
      if (processedCount % 100 === 0) {
        console.log(JSON.stringify({
          event: "property_consolidation_progress",
          processed: processedCount,
          total: propertyCount,
        }));
      }
    }

    // 6. Write manifest
    const completedAt = new Date().toISOString();
    const manifest = buildManifestSummary(manifestEntries, startedAt, completedAt, options.county);
    await writeFile(join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(JSON.stringify({
      event: "property_consolidation_export_finished",
      count: processedCount,
      totalBytes: manifest.totalBytes,
      minBytes: manifest.minBytes,
      avgBytes: manifest.avgBytes,
      maxBytes: manifest.maxBytes,
      projectedBytes300k: manifest.projectedBytes300k,
    }));
  } finally {
    await pg.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ event: "property_consolidation_export_failed", error: message }));
  process.exit(1);
});
