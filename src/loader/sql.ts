import type {
  BatchUpsertCounters,
  BatchUpsertOptions,
  JsonObject,
  LogicalTableName,
  PreparedRow,
  QueryClient,
  SourceSystem,
  TableWriteSpec,
  UpsertStatement,
} from "./types.js";

const JSONB_COLUMNS = new Set<string>([
  "entry_http_request",
  "factor_payload",
  "field_payload",
  "more_details",
  "source_http_request",
  "source_payload",
  "source_search_result",
]);

const TEXT_ARRAY_COLUMNS = new Set<string>([
  "matched_address_roles",
  "matched_zip_prefixes",
]);

const TABLES_WITH_UPDATED_AT = new Set<LogicalTableName>([
  "addresses",
  "business_registration_addresses",
  "business_registration_parties",
  "business_registrations",
  "business_reputation_alternate_names",
  "business_reputation_categories",
  "business_reputation_complaint_events",
  "business_reputation_complaints",
  "business_reputation_contacts",
  "business_reputation_external_links",
  "business_reputation_licenses",
  "business_reputation_locations",
  "business_reputation_media",
  "business_reputation_profiles",
  "business_reputation_rating_reasons",
  "business_reputation_reviews",
  "business_reputation_service_areas",
  "companies",
  "contractor_quality_scores",
  "deeds",
  "fact_sheets",
  "files",
  "flood_storm_information",
  "geometries",
  "layouts",
  "lots",
  "ownerships",
  "parcels",
  "people",
  "property_improvements",
  "property_valuations",
  "properties",
  "sales_histories",
  "structures",
  "taxes",
  "unnormalized_addresses",
  "utilities",
]);

const TABLES_WITH_ADDRESS_ID = new Set<LogicalTableName>([
  "business_reputation_locations",
  "business_reputation_profiles",
  "business_reputation_service_areas",
  "business_registration_addresses",
  "business_registration_parties",
  "permit_contacts",
  "properties",
  "property_improvements",
]);

const TABLES_WITH_BUSINESS_REGISTRATION_ID = new Set<LogicalTableName>([
  "business_registration_addresses",
  "business_registration_annual_reports",
  "business_registration_events",
  "business_registration_parties",
]);

const TABLES_WITH_COMPANY_ID = new Set<LogicalTableName>([
  "business_registrations",
  "business_reputation_profiles",
  "contractor_quality_scores",
  "permit_contacts",
]);

const TABLES_WITH_CONTRACTOR_COMPANY_ID = new Set<LogicalTableName>(["property_improvements"]);

const TABLES_WITH_OWNER_COMPANY_ID = new Set<LogicalTableName>(["ownerships"]);

const TABLES_WITH_DEED_ID = new Set<LogicalTableName>(["files"]);

const TABLES_WITH_PARCEL_ID = new Set<LogicalTableName>([
  "properties",
  "property_improvements",
]);

const TABLES_WITH_PERSON_ID = new Set<LogicalTableName>([
  "business_reputation_contacts",
  "permit_contacts",
]);

const TABLES_WITH_OWNER_PERSON_ID = new Set<LogicalTableName>(["ownerships"]);

const TABLES_WITH_PROPERTY_ID = new Set<LogicalTableName>([
  "deeds",
  "fact_sheets",
  "files",
  "flood_storm_information",
  "geometries",
  "layouts",
  "lots",
  "ownerships",
  "property_improvements",
  "property_valuations",
  "sales_histories",
  "structures",
  "taxes",
  "utilities",
]);

const TABLES_WITH_PROPERTY_IMPROVEMENT_ID = new Set<LogicalTableName>([
  "inspections",
  "permit_contacts",
  "permit_custom_fields",
  "permit_events",
  "permit_fees",
  "permit_links",
]);

const TABLES_WITH_BUSINESS_REPUTATION_PROFILE_ID = new Set<LogicalTableName>([
  "business_reputation_alternate_names",
  "business_reputation_categories",
  "business_reputation_complaints",
  "business_reputation_contacts",
  "business_reputation_external_links",
  "business_reputation_licenses",
  "business_reputation_locations",
  "business_reputation_media",
  "business_reputation_rating_reasons",
  "business_reputation_reviews",
  "business_reputation_service_areas",
  "contractor_quality_scores",
]);

const TABLES_WITH_BUSINESS_REPUTATION_COMPLAINT_ID = new Set<LogicalTableName>([
  "business_reputation_complaint_events",
]);

export const DEFAULT_TABLE_WRITE_SPECS: ReadonlyMap<LogicalTableName, TableWriteSpec> =
  new Map<LogicalTableName, TableWriteSpec>([
    ["addresses", defaultSpec("addresses", ["address_id"])],
    ["business_registration_addresses", defaultSpec("business_registration_addresses", ["business_registration_address_id"])],
    ["business_registration_annual_reports", defaultSpec("business_registration_annual_reports", ["business_registration_annual_report_id"])],
    ["business_registration_events", defaultSpec("business_registration_events", ["business_registration_event_id"])],
    ["business_registration_parties", defaultSpec("business_registration_parties", ["business_registration_party_id"])],
    ["business_registrations", defaultSpec("business_registrations", ["business_registration_id"])],
    ["business_reputation_alternate_names", defaultSpec("business_reputation_alternate_names", ["business_reputation_alternate_name_id"])],
    ["business_reputation_categories", defaultSpec("business_reputation_categories", ["business_reputation_category_id"])],
    ["business_reputation_complaint_events", defaultSpec("business_reputation_complaint_events", ["business_reputation_complaint_event_id"])],
    ["business_reputation_complaints", defaultSpec("business_reputation_complaints", ["business_reputation_complaint_id"])],
    ["business_reputation_contacts", defaultSpec("business_reputation_contacts", ["business_reputation_contact_id"])],
    ["business_reputation_external_links", defaultSpec("business_reputation_external_links", ["business_reputation_external_link_id"])],
    ["business_reputation_licenses", defaultSpec("business_reputation_licenses", ["business_reputation_license_id"])],
    ["business_reputation_locations", defaultSpec("business_reputation_locations", ["business_reputation_location_id"])],
    ["business_reputation_media", defaultSpec("business_reputation_media", ["business_reputation_media_id"])],
    ["business_reputation_profiles", defaultSpec("business_reputation_profiles", ["business_reputation_profile_id"])],
    ["business_reputation_rating_reasons", defaultSpec("business_reputation_rating_reasons", ["business_reputation_rating_reason_id"])],
    ["business_reputation_reviews", defaultSpec("business_reputation_reviews", ["business_reputation_review_id"])],
    ["business_reputation_service_areas", defaultSpec("business_reputation_service_areas", ["business_reputation_service_area_id"])],
    ["companies", defaultSpec("companies", ["company_id"])],
    ["contractor_quality_scores", defaultSpec("contractor_quality_scores", ["contractor_quality_score_id"])],
    ["deeds", defaultSpec("deeds", ["deed_id"])],
    ["fact_sheets", defaultSpec("fact_sheets", ["fact_sheet_id"])],
    ["files", defaultSpec("files", ["file_id"])],
    ["flood_storm_information", defaultSpec("flood_storm_information", ["flood_storm_information_id"])],
    ["geometries", defaultSpec("geometries", ["geometry_id"])],
    ["inspections", defaultSpec("inspections", ["inspection_id"])],
    ["layouts", defaultSpec("layouts", ["layout_id"])],
    ["lots", defaultSpec("lots", ["lot_id"])],
    ["ownerships", defaultSpec("ownerships", ["ownership_id"])],
    [
      "parcels",
      {
        ...defaultSpec("parcels", ["parcel_id"]),
        conflictColumns: ["jurisdiction_key", "request_identifier"],
      },
    ],
    ["people", defaultSpec("people", ["person_id"])],
    ["permit_contacts", defaultSpec("permit_contacts", ["permit_contact_id"])],
    ["permit_custom_fields", defaultSpec("permit_custom_fields", ["permit_custom_field_id"])],
    ["permit_events", defaultSpec("permit_events", ["permit_event_id"])],
    ["permit_fees", defaultSpec("permit_fees", ["permit_fee_id"])],
    [
      "permit_links",
      {
        ...defaultSpec("permit_links", ["permit_link_id"]),
        conflictColumns: ["property_improvement_id", "link_kind", "url"],
      },
    ],
    ["permit_list_windows", defaultSpec("permit_list_windows", ["permit_list_window_id"])],
    ["property_improvements", defaultSpec("property_improvements", ["property_improvement_id"])],
    ["property_valuations", defaultSpec("property_valuations", ["property_valuation_id"])],
    ["properties", defaultSpec("properties", ["property_id"])],
    ["sales_histories", defaultSpec("sales_histories", ["sales_history_id"])],
    ["structures", defaultSpec("structures", ["structure_id"])],
    ["sunbiz_extraction_chunks", defaultSpec("sunbiz_extraction_chunks", ["sunbiz_extraction_chunk_id"])],
    ["taxes", defaultSpec("taxes", ["tax_id"])],
    ["unnormalized_addresses", defaultSpec("unnormalized_addresses", ["unnormalized_address_id"])],
    ["utilities", defaultSpec("utilities", ["utility_id"])],
  ]);

function defaultSpec(
  tableName: LogicalTableName,
  returningColumns: readonly string[],
): TableWriteSpec {
  return {
    tableName,
    conflictColumns: ["source_system", "source_record_key"],
    returningColumns,
    jsonbColumns: JSONB_COLUMNS,
    textArrayColumns: TEXT_ARRAY_COLUMNS,
  };
}

const UPDATE_GUARD_COLUMNS_BY_TABLE: ReadonlyMap<LogicalTableName, readonly string[]> =
  buildUpdateGuardColumnsByTable();

/**
 * Build table-specific derived-column guards for idempotent upserts.
 *
 * Source payload hashes should remain the fast no-op path, but direct foreign
 * keys are derived during loading and can become resolvable after a parent row
 * is backfilled. These columns must therefore be allowed to refresh even when
 * the source record hash is unchanged.
 *
 * @returns Mapping of logical table names to FK columns that should participate in the update guard.
 */
function buildUpdateGuardColumnsByTable(): ReadonlyMap<LogicalTableName, readonly string[]> {
  const columnsByTable = new Map<LogicalTableName, Set<string>>();
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_ADDRESS_ID, ["address_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_BUSINESS_REGISTRATION_ID, ["business_registration_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_BUSINESS_REPUTATION_PROFILE_ID, ["business_reputation_profile_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_BUSINESS_REPUTATION_COMPLAINT_ID, ["business_reputation_complaint_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_COMPANY_ID, ["company_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_CONTRACTOR_COMPANY_ID, ["contractor_company_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_OWNER_COMPANY_ID, ["owner_company_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_DEED_ID, ["deed_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_PARCEL_ID, ["parcel_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_PERSON_ID, ["person_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_OWNER_PERSON_ID, ["owner_person_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_PROPERTY_ID, ["property_id"]);
  addUpdateGuardColumns(columnsByTable, TABLES_WITH_PROPERTY_IMPROVEMENT_ID, ["property_improvement_id"]);
  return new Map(
    [...columnsByTable.entries()].map(([tableName, columnNames]) => [
      tableName,
      [...columnNames].sort(),
    ]),
  );
}

function addUpdateGuardColumns(
  columnsByTable: Map<LogicalTableName, Set<string>>,
  tableNames: ReadonlySet<LogicalTableName>,
  columnNames: readonly string[],
): void {
  for (const tableName of tableNames) {
    const existing = columnsByTable.get(tableName) ?? new Set<string>();
    for (const columnName of columnNames) existing.add(columnName);
    columnsByTable.set(tableName, existing);
  }
}

/**
 * Build the idempotent one-row `INSERT ... ON CONFLICT DO UPDATE` statement for a prepared row.
 *
 * @param row - Prepared logical table row including source metadata and typed columns.
 * @param spec - Optional table write spec; defaults to the table's registered write spec.
 * @returns SQL text and bound values. JSONB and text-array columns are explicitly cast.
 */
export function buildUpsertStatement(
  row: PreparedRow,
  spec: TableWriteSpec = mustGetSpec(row.tableName),
): UpsertStatement {
  const columns = Object.keys(row.values).sort();
  if (columns.length === 0) {
    throw new Error(`Cannot upsert empty row into ${row.tableName}`);
  }

  const values: unknown[] = [];
  const placeholders = columns.map((columnName, index) => {
    values.push(prepareValue(row.values[columnName], columnName, spec));
    const placeholder = `$${index + 1}`;
    if (spec.jsonbColumns.has(columnName)) return `${placeholder}::jsonb`;
    if (spec.textArrayColumns.has(columnName)) return `${placeholder}::text[]`;
    return placeholder;
  });

  const updateColumns = columns.filter(
    (columnName) => !spec.conflictColumns.includes(columnName) && columnName !== "created_at",
  );
  const assignments = updateColumns.map(
    (columnName) => `${quoteIdentifier(columnName)} = EXCLUDED.${quoteIdentifier(columnName)}`,
  );
  if (columns.includes("loaded_at") === false) {
    assignments.push("loaded_at = now()");
  }
  if (TABLES_WITH_UPDATED_AT.has(row.tableName)) {
    assignments.push("updated_at = now()");
  }

  const returningClause =
    spec.returningColumns.length > 0
      ? ` RETURNING ${spec.returningColumns.map(quoteIdentifier).join(", ")}`
      : "";
  const updateGuard = buildUpdateGuard({ tableName: row.tableName, columns });

  return {
    text: [
      `INSERT INTO ${quoteIdentifier(row.tableName)} (${columns.map(quoteIdentifier).join(", ")})`,
      `VALUES (${placeholders.join(", ")})`,
      `ON CONFLICT (${spec.conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET`,
      assignments.join(", "),
      updateGuard,
      returningClause,
    ].join(" "),
    values,
  };
}

/**
 * Build the `ON CONFLICT DO UPDATE` guard for a single prepared-row upsert.
 *
 * @param params - Target table and insert column names present in this upsert.
 * @returns SQL `WHERE` clause that updates on source-hash or derived-FK changes, or an empty string.
 */
function buildUpdateGuard(params: {
  readonly tableName: LogicalTableName;
  readonly columns: readonly string[];
}): string {
  const insertColumns = new Set(params.columns);
  const conditions: string[] = [];
  const targetTableSql = quoteIdentifier(params.tableName);
  if (insertColumns.has("source_record_hash")) {
    conditions.push(
      `${targetTableSql}."source_record_hash" IS DISTINCT FROM EXCLUDED."source_record_hash"`,
    );
  }
  for (const columnName of UPDATE_GUARD_COLUMNS_BY_TABLE.get(params.tableName) ?? []) {
    if (!insertColumns.has(columnName)) continue;
    const columnSql = quoteIdentifier(columnName);
    conditions.push(`${targetTableSql}.${columnSql} IS DISTINCT FROM EXCLUDED.${columnSql}`);
  }
  if (conditions.length === 0) return "";
  return ` WHERE ${conditions.join(" OR ")}`;
}

/**
 * Execute one prepared-row upsert without resolving foreign-key references.
 *
 * @param client - Query client with a `query` method compatible with `pg`-style clients.
 * @param row - Prepared logical table row to write.
 * @returns Rows returned by the table write spec, or an empty array when the source hash is unchanged.
 */
export async function upsertPreparedRow<Row extends JsonObject = JsonObject>(
  client: QueryClient,
  row: PreparedRow,
): Promise<readonly Row[]> {
  const statement = buildUpsertStatement(row);
  const result = await client.query<Row>(statement.text, statement.values);
  return result.rows;
}

/**
 * Resolve source-key references into direct foreign-key columns before a row is written.
 *
 * @param client - Query client used for small source-key lookup queries.
 * @param row - Prepared logical row from a source-specific mapper.
 * @param options - Missing-reference behavior. Defaults to throwing before the upsert.
 * @returns A prepared row with resolvable direct FK columns added to `values`.
 */
export async function resolvePreparedRowReferences(
  client: QueryClient,
  row: PreparedRow,
  options: BatchUpsertOptions = {},
): Promise<PreparedRow> {
  if (row.references === undefined) return row;

  const missingReferenceBehavior = options.missingReferenceBehavior ?? "throw";
  const values: JsonObject = { ...row.values };

  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.addressSourceRecordKey,
    targetColumnName: "address_id",
    targetIdColumnName: "address_id",
    targetTableName: "addresses",
    targetTables: TABLES_WITH_ADDRESS_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.companySourceRecordKey,
    targetColumnName: "company_id",
    targetIdColumnName: "company_id",
    targetTableName: "companies",
    targetTables: TABLES_WITH_COMPANY_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.companySourceRecordKey,
    targetColumnName: "contractor_company_id",
    targetIdColumnName: "company_id",
    targetTableName: "companies",
    targetTables: TABLES_WITH_CONTRACTOR_COMPANY_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.companySourceRecordKey,
    targetColumnName: "owner_company_id",
    targetIdColumnName: "company_id",
    targetTableName: "companies",
    targetTables: TABLES_WITH_OWNER_COMPANY_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.deedSourceRecordKey,
    targetColumnName: "deed_id",
    targetIdColumnName: "deed_id",
    targetTableName: "deeds",
    targetTables: TABLES_WITH_DEED_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.parcelSourceRecordKey,
    targetColumnName: "parcel_id",
    targetIdColumnName: "parcel_id",
    targetTableName: "parcels",
    targetTables: TABLES_WITH_PARCEL_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.personSourceRecordKey,
    targetColumnName: "person_id",
    targetIdColumnName: "person_id",
    targetTableName: "people",
    targetTables: TABLES_WITH_PERSON_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.personSourceRecordKey,
    targetColumnName: "owner_person_id",
    targetIdColumnName: "person_id",
    targetTableName: "people",
    targetTables: TABLES_WITH_OWNER_PERSON_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.propertyImprovementSourceRecordKey,
    targetColumnName: "property_improvement_id",
    targetIdColumnName: "property_improvement_id",
    targetTableName: "property_improvements",
    targetTables: TABLES_WITH_PROPERTY_IMPROVEMENT_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.propertySourceRecordKey,
    targetColumnName: "property_id",
    targetIdColumnName: "property_id",
    targetTableName: "properties",
    targetTables: TABLES_WITH_PROPERTY_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.businessReputationProfileSourceRecordKey,
    targetColumnName: "business_reputation_profile_id",
    targetIdColumnName: "business_reputation_profile_id",
    targetTableName: "business_reputation_profiles",
    targetTables: TABLES_WITH_BUSINESS_REPUTATION_PROFILE_ID,
    missingReferenceBehavior,
  });
  await setSourceKeyReference({
    client,
    row,
    values,
    referenceSourceRecordKey: row.references.businessReputationComplaintSourceRecordKey,
    targetColumnName: "business_reputation_complaint_id",
    targetIdColumnName: "business_reputation_complaint_id",
    targetTableName: "business_reputation_complaints",
    targetTables: TABLES_WITH_BUSINESS_REPUTATION_COMPLAINT_ID,
    missingReferenceBehavior,
  });

  if (
    row.references.businessRegistrationSourceRecordKey !== undefined &&
    TABLES_WITH_BUSINESS_REGISTRATION_ID.has(row.tableName)
  ) {
    await setResolvedColumnFromSourceKey({
      client,
      values,
      referenceSourceRecordKey: row.references.businessRegistrationSourceRecordKey,
      targetColumnName: "business_registration_id",
      targetIdColumnName: "business_registration_id",
      targetTableName: "business_registrations",
      missingReferenceBehavior,
    });
  } else if (
    row.references.businessRegistrationDocumentNumber !== undefined &&
    TABLES_WITH_BUSINESS_REGISTRATION_ID.has(row.tableName)
  ) {
    const sourceSystem = readSourceSystem(values.source_system) ?? "sunbiz";
    const registrationId = await findBusinessRegistrationIdByDocumentNumber(
      client,
      sourceSystem,
      row.references.businessRegistrationDocumentNumber,
    );
    if (registrationId === null && missingReferenceBehavior === "throw") {
      throw new Error(
        `Missing business registration for document ${row.references.businessRegistrationDocumentNumber}`,
      );
    }
    if (registrationId !== null) values.business_registration_id = registrationId;
  }

  return { ...row, values };
}

/**
 * Upsert prepared rows sequentially after resolving direct foreign-key references.
 *
 * @param client - Query client used for reference lookups and upserts.
 * @param rows - Prepared logical rows in dependency order.
 * @param options - Reference-resolution options for missing parents.
 * @returns Counters for attempted, changed, and unchanged upsert outcomes.
 */
export async function upsertPreparedRows(
  client: QueryClient,
  rows: readonly PreparedRow[],
  options: BatchUpsertOptions = {},
): Promise<BatchUpsertCounters> {
  let changedRows = 0;
  let unchangedRows = 0;
  for (const row of rows) {
    const resolvedRow = await resolvePreparedRowReferences(client, row, options);
    const resultRows = await upsertPreparedRow(client, resolvedRow);
    if (resultRows.length > 0) changedRows += 1;
    else unchangedRows += 1;
  }
  return {
    attemptedRows: rows.length,
    changedRows,
    unchangedRows,
  };
}

export function mustGetSpec(tableName: LogicalTableName): TableWriteSpec {
  const spec = DEFAULT_TABLE_WRITE_SPECS.get(tableName);
  if (spec === undefined) {
    throw new Error(`Missing table write spec for ${tableName}`);
  }
  return spec;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function setSourceKeyReference(params: {
  readonly client: QueryClient;
  readonly row: PreparedRow;
  readonly values: JsonObject;
  readonly referenceSourceRecordKey: string | undefined;
  readonly targetColumnName: string;
  readonly targetIdColumnName: string;
  readonly targetTableName: LogicalTableName;
  readonly targetTables: ReadonlySet<LogicalTableName>;
  readonly missingReferenceBehavior: "throw" | "omit";
}): Promise<void> {
  if (params.referenceSourceRecordKey === undefined) return;
  if (params.targetTables.has(params.row.tableName) === false) return;
  await setResolvedColumnFromSourceKey({
    client: params.client,
    values: params.values,
    referenceSourceRecordKey: params.referenceSourceRecordKey,
    targetColumnName: params.targetColumnName,
    targetIdColumnName: params.targetIdColumnName,
    targetTableName: params.targetTableName,
    missingReferenceBehavior: params.missingReferenceBehavior,
  });
}

async function setResolvedColumnFromSourceKey(params: {
  readonly client: QueryClient;
  readonly values: JsonObject;
  readonly referenceSourceRecordKey: string;
  readonly targetColumnName: string;
  readonly targetIdColumnName: string;
  readonly targetTableName: LogicalTableName;
  readonly missingReferenceBehavior: "throw" | "omit";
}): Promise<void> {
  const id = await findIdBySourceRecordKey(
    params.client,
    params.targetTableName,
    params.targetIdColumnName,
    params.referenceSourceRecordKey,
  );
  if (id === null && params.missingReferenceBehavior === "throw") {
    throw new Error(
      `Missing ${params.targetTableName} row for source key ${params.referenceSourceRecordKey}`,
    );
  }
  if (id !== null) params.values[params.targetColumnName] = id;
}

async function findIdBySourceRecordKey(
  client: QueryClient,
  tableName: LogicalTableName,
  idColumnName: string,
  sourceRecordKey: string,
): Promise<string | null> {
  const sourceSystem = inferSourceSystemFromSourceRecordKey(sourceRecordKey);
  const selectId = quoteIdentifier(idColumnName);
  const table = quoteIdentifier(tableName);
  const result =
    sourceSystem === null
      ? await client.query<JsonObject>(
          `SELECT ${selectId} FROM ${table} WHERE "source_record_key" = $1 LIMIT 1`,
          [sourceRecordKey],
        )
      : await client.query<JsonObject>(
          `SELECT ${selectId} FROM ${table} WHERE "source_system" = $1 AND "source_record_key" = $2 LIMIT 1`,
          [sourceSystem, sourceRecordKey],
        );
  const firstRow = result.rows[0];
  if (firstRow === undefined) return null;
  const value = firstRow[idColumnName];
  return typeof value === "string" ? value : null;
}

async function findBusinessRegistrationIdByDocumentNumber(
  client: QueryClient,
  sourceSystem: SourceSystem,
  documentNumber: string,
): Promise<string | null> {
  const result = await client.query<JsonObject>(
    `SELECT "business_registration_id" FROM "business_registrations" WHERE "source_system" = $1 AND "document_number" = $2 LIMIT 1`,
    [sourceSystem, documentNumber],
  );
  const firstRow = result.rows[0];
  if (firstRow === undefined) return null;
  const value = firstRow.business_registration_id;
  return typeof value === "string" ? value : null;
}

function inferSourceSystemFromSourceRecordKey(sourceRecordKey: string): SourceSystem | null {
  if (sourceRecordKey.startsWith("bbb:")) return "bbb";
  if (sourceRecordKey.startsWith("lee_appraiser:")) return "lee_appraiser";
  if (sourceRecordKey.startsWith("lee_accela:")) return "lee_accela";
  if (sourceRecordKey.startsWith("sunbiz:")) return "sunbiz";
  return null;
}

function readSourceSystem(value: unknown): SourceSystem | null {
  if (value === "bbb" || value === "lee_appraiser" || value === "lee_accela" || value === "sunbiz") return value;
  return null;
}

function prepareValue(
  value: unknown,
  columnName: string,
  spec: TableWriteSpec,
): unknown {
  if (value === undefined) return null;
  if (spec.jsonbColumns.has(columnName)) return JSON.stringify(value ?? {});
  if (spec.textArrayColumns.has(columnName)) {
    return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
  }
  return value;
}
