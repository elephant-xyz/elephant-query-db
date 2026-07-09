export type JsonObject = Record<string, unknown>;

// Appraiser and permit source systems are county-parameterized: the bulk loader
// derives them from the `--jurisdiction-key` / `--permit-source-system` CLI
// options (defaulting to `lee_appraiser` / `lee_accela`). The template-literal
// arms admit any `<county>_appraiser` / `<county>_accela` value (e.g.
// `orange_appraiser`) while still excluding unrelated strings. The
// `<county>_permits` arm covers bulk city permit-portal pulls that are not
// Accela harvests (e.g. `santa_clara_permits`). `bbb` and `sunbiz` remain
// fixed. Existing `lee_appraiser` / `lee_accela` literals stay assignable via
// the template arms.
export type SourceSystem =
  | "bbb"
  | "sunbiz"
  | `${string}_appraiser`
  | `${string}_accela`
  | `${string}_permits`;

export type LogicalTableName =
  | "addresses"
  | "business_registration_addresses"
  | "business_registration_annual_reports"
  | "business_registration_events"
  | "business_registration_parties"
  | "business_registrations"
  | "business_reputation_alternate_names"
  | "business_reputation_categories"
  | "business_reputation_complaint_events"
  | "business_reputation_complaints"
  | "business_reputation_contacts"
  | "business_reputation_external_links"
  | "business_reputation_licenses"
  | "business_reputation_locations"
  | "business_reputation_media"
  | "business_reputation_profiles"
  | "business_reputation_rating_reasons"
  | "business_reputation_reviews"
  | "business_reputation_service_areas"
  | "companies"
  | "contractor_quality_scores"
  | "deeds"
  | "fact_sheets"
  | "files"
  | "flood_storm_information"
  | "geometries"
  | "inspections"
  | "layouts"
  | "lots"
  | "ownerships"
  | "parcels"
  | "people"
  | "permit_contacts"
  | "permit_custom_fields"
  | "permit_events"
  | "permit_fees"
  | "permit_links"
  | "permit_list_windows"
  | "property_improvements"
  | "property_valuations"
  | "properties"
  | "sales_histories"
  | "structures"
  | "sunbiz_extraction_chunks"
  | "taxes"
  | "unnormalized_addresses"
  | "utilities";

export type SourceMetadata = {
  readonly source_system: SourceSystem;
  readonly source_record_key: string;
  readonly source_record_hash: string;
  readonly source_artifact_uri: string | null;
};

export type PreparedRow = {
  readonly tableName: LogicalTableName;
  readonly values: JsonObject;
  readonly references?: PreparedRowReferences;
};

export type PreparedRowReferences = {
  readonly addressSourceRecordKey?: string;
  readonly businessReputationComplaintSourceRecordKey?: string;
  readonly businessReputationProfileSourceRecordKey?: string;
  readonly companySourceRecordKey?: string;
  readonly deedSourceRecordKey?: string;
  readonly parcelSourceRecordKey?: string;
  readonly personSourceRecordKey?: string;
  readonly propertyImprovementSourceRecordKey?: string;
  readonly businessRegistrationDocumentNumber?: string;
  readonly businessRegistrationSourceRecordKey?: string;
  readonly propertySourceRecordKey?: string;
};

export type PreparedRowBundle = {
  readonly rows: readonly PreparedRow[];
  readonly skippedRecords: readonly SkippedSourceRecord[];
};

export type SkippedSourceRecord = {
  readonly artifactUri: string | null;
  readonly reason: string;
  readonly sourcePayload: JsonObject;
};

export type TableWriteSpec = {
  readonly tableName: LogicalTableName;
  readonly conflictColumns: readonly string[];
  readonly returningColumns: readonly string[];
  readonly jsonbColumns: ReadonlySet<string>;
  readonly textArrayColumns: ReadonlySet<string>;
};

export type UpsertStatement = {
  readonly text: string;
  readonly values: readonly unknown[];
};

export type QueryRowsResult<Row extends JsonObject> = {
  readonly rows: readonly Row[];
};

export type QueryClient = {
  readonly query: <Row extends JsonObject = JsonObject>(
    text: string,
    values: readonly unknown[],
  ) => Promise<QueryRowsResult<Row>>;
};

export type LoaderCounters = {
  readonly inputRecords: number;
  readonly preparedRows: number;
  readonly skippedRecords: number;
};

export type MissingReferenceBehavior = "throw" | "omit";

export type BatchUpsertOptions = {
  readonly missingReferenceBehavior?: MissingReferenceBehavior;
};

export type BatchUpsertCounters = {
  readonly attemptedRows: number;
  readonly changedRows: number;
  readonly unchangedRows: number;
};
