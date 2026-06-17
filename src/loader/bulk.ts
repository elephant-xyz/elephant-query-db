import { DEFAULT_TABLE_WRITE_SPECS } from "./sql.js";
import { stableJsonStringify } from "./normalizers.js";
import type {
  JsonObject,
  LogicalTableName,
  PreparedRow,
  PreparedRowReferences,
  QueryClient,
} from "./types.js";

export const BULK_STAGE_COLUMNS = [
  "row_index",
  "table_name",
  "source_system",
  "source_record_key",
  "source_record_hash",
  "source_artifact_uri",
  "values_json",
  "references_json",
] as const;

export type BulkStageColumnName = (typeof BULK_STAGE_COLUMNS)[number];

export type BulkStageCsvRow = {
  readonly rowIndex: number;
  readonly row: PreparedRow;
};

export type BulkTableColumn = JsonObject & {
  readonly table_name: LogicalTableName;
  readonly column_name: string;
  readonly ordinal_position: number;
};

export type BulkMergeResult = {
  readonly tableName: LogicalTableName;
  readonly attemptedRows: number;
  readonly dedupedRows: number;
  readonly changedRows: number;
};

type BulkMergeResultRow = JsonObject & {
  readonly attempted_rows: number;
  readonly deduped_rows: number;
  readonly changed_rows: number;
};

type ReferenceResolution = {
  readonly referenceJsonKey: keyof PreparedRowReferences;
  readonly targetColumnName: string;
  readonly targetIdColumnName: string;
  readonly targetTableName: LogicalTableName;
  readonly targetTables: ReadonlySet<LogicalTableName>;
  readonly alias: string;
};

type JsonHydrationColumn = {
  readonly targetColumnName: string;
  readonly fallbackExpression: string;
};

const GENERATED_OR_DEFAULT_COLUMNS = new Set<string>([
  "created_at",
  "updated_at",
  "loaded_at",
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

const SOURCE_KEY_REFERENCE_RESOLUTIONS: readonly ReferenceResolution[] = [
  {
    referenceJsonKey: "addressSourceRecordKey",
    targetColumnName: "address_id",
    targetIdColumnName: "address_id",
    targetTableName: "addresses",
    targetTables: TABLES_WITH_ADDRESS_ID,
    alias: "ref_address",
  },
  {
    referenceJsonKey: "companySourceRecordKey",
    targetColumnName: "company_id",
    targetIdColumnName: "company_id",
    targetTableName: "companies",
    targetTables: TABLES_WITH_COMPANY_ID,
    alias: "ref_company",
  },
  {
    referenceJsonKey: "companySourceRecordKey",
    targetColumnName: "contractor_company_id",
    targetIdColumnName: "company_id",
    targetTableName: "companies",
    targetTables: TABLES_WITH_CONTRACTOR_COMPANY_ID,
    alias: "ref_contractor_company",
  },
  {
    referenceJsonKey: "companySourceRecordKey",
    targetColumnName: "owner_company_id",
    targetIdColumnName: "company_id",
    targetTableName: "companies",
    targetTables: TABLES_WITH_OWNER_COMPANY_ID,
    alias: "ref_owner_company",
  },
  {
    referenceJsonKey: "deedSourceRecordKey",
    targetColumnName: "deed_id",
    targetIdColumnName: "deed_id",
    targetTableName: "deeds",
    targetTables: TABLES_WITH_DEED_ID,
    alias: "ref_deed",
  },
  {
    referenceJsonKey: "parcelSourceRecordKey",
    targetColumnName: "parcel_id",
    targetIdColumnName: "parcel_id",
    targetTableName: "parcels",
    targetTables: TABLES_WITH_PARCEL_ID,
    alias: "ref_parcel",
  },
  {
    referenceJsonKey: "personSourceRecordKey",
    targetColumnName: "person_id",
    targetIdColumnName: "person_id",
    targetTableName: "people",
    targetTables: TABLES_WITH_PERSON_ID,
    alias: "ref_person",
  },
  {
    referenceJsonKey: "personSourceRecordKey",
    targetColumnName: "owner_person_id",
    targetIdColumnName: "person_id",
    targetTableName: "people",
    targetTables: TABLES_WITH_OWNER_PERSON_ID,
    alias: "ref_owner_person",
  },
  {
    referenceJsonKey: "propertyImprovementSourceRecordKey",
    targetColumnName: "property_improvement_id",
    targetIdColumnName: "property_improvement_id",
    targetTableName: "property_improvements",
    targetTables: TABLES_WITH_PROPERTY_IMPROVEMENT_ID,
    alias: "ref_property_improvement",
  },
  {
    referenceJsonKey: "propertySourceRecordKey",
    targetColumnName: "property_id",
    targetIdColumnName: "property_id",
    targetTableName: "properties",
    targetTables: TABLES_WITH_PROPERTY_ID,
    alias: "ref_property",
  },
  {
    referenceJsonKey: "businessReputationProfileSourceRecordKey",
    targetColumnName: "business_reputation_profile_id",
    targetIdColumnName: "business_reputation_profile_id",
    targetTableName: "business_reputation_profiles",
    targetTables: TABLES_WITH_BUSINESS_REPUTATION_PROFILE_ID,
    alias: "ref_business_reputation_profile",
  },
  {
    referenceJsonKey: "businessReputationComplaintSourceRecordKey",
    targetColumnName: "business_reputation_complaint_id",
    targetIdColumnName: "business_reputation_complaint_id",
    targetTableName: "business_reputation_complaints",
    targetTables: TABLES_WITH_BUSINESS_REPUTATION_COMPLAINT_ID,
    alias: "ref_business_reputation_complaint",
  },
];

const BUSINESS_REGISTRATION_ADDRESS_HYDRATION_COLUMNS: readonly JsonHydrationColumn[] = [
  {
    targetColumnName: "line_1",
    fallbackExpression: `"ref_address"."unnormalized_address"`,
  },
  {
    targetColumnName: "city",
    fallbackExpression: `"ref_address"."city_name"`,
  },
  {
    targetColumnName: "state",
    fallbackExpression: `"ref_address"."state_code"`,
  },
  {
    targetColumnName: "zip",
    fallbackExpression: `"ref_address"."postal_code"`,
  },
  {
    targetColumnName: "country",
    fallbackExpression: `"ref_address"."country_code"`,
  },
  {
    targetColumnName: "single_line",
    fallbackExpression: `"ref_address"."unnormalized_address"`,
  },
  {
    targetColumnName: "normalized",
    fallbackExpression: `"ref_address"."normalized_address_key"`,
  },
];

const BULK_UPDATE_GUARD_COLUMNS_BY_TABLE: ReadonlyMap<LogicalTableName, readonly string[]> =
  buildBulkUpdateGuardColumnsByTable();

/**
 * Build table-specific comparison columns for bulk `ON CONFLICT` guards.
 *
 * Bulk merges deduplicate and upsert by source key. Source hashes are stable for
 * already-extracted records, while FK columns are derived from parent rows that
 * may be loaded or repaired later. Including these derived columns lets a replay
 * fix stale null references without rewriting rows whose source and FKs are both unchanged.
 *
 * @returns Mapping of logical table names to columns that should refresh on replay.
 */
function buildBulkUpdateGuardColumnsByTable(): ReadonlyMap<LogicalTableName, readonly string[]> {
  const columnsByTable = new Map<LogicalTableName, Set<string>>();
  for (const resolution of SOURCE_KEY_REFERENCE_RESOLUTIONS) {
    addBulkUpdateGuardColumns(columnsByTable, resolution.targetTables, [resolution.targetColumnName]);
  }
  addBulkUpdateGuardColumns(columnsByTable, TABLES_WITH_BUSINESS_REGISTRATION_ID, ["business_registration_id"]);
  addBulkUpdateGuardColumns(
    columnsByTable,
    new Set<LogicalTableName>(["business_registration_addresses"]),
    BUSINESS_REGISTRATION_ADDRESS_HYDRATION_COLUMNS.map((column) => column.targetColumnName),
  );
  return new Map(
    [...columnsByTable.entries()].map(([tableName, columnNames]) => [
      tableName,
      [...columnNames].sort(),
    ]),
  );
}

function addBulkUpdateGuardColumns(
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
 * Serialize the fixed CSV header used by the local bulk loader staging file.
 *
 * @returns A newline-terminated CSV header matching `BULK_STAGE_COLUMNS`.
 */
export function serializeBulkStageCsvHeader(): string {
  return `${BULK_STAGE_COLUMNS.join(",")}\n`;
}

/**
 * Serialize one prepared logical row into the generic bulk-stage CSV format.
 *
 * The staging table stores typed row values as JSONB instead of trying to
 * materialize every target table shape in local files. PostgreSQL later uses
 * `jsonb_populate_record` and set-based joins to cast values and resolve FKs.
 *
 * @param params - Row index and prepared row generated by an existing source mapper.
 * @returns A newline-terminated CSV row safe for PostgreSQL `COPY ... CSV`.
 */
export function serializeBulkStageCsvRow(params: BulkStageCsvRow): string {
  const sourceSystem = readStringValue(params.row.values.source_system);
  const sourceRecordKey = readStringValue(params.row.values.source_record_key);
  if (sourceSystem === null || sourceRecordKey === null) {
    throw new Error(`Prepared row for ${params.row.tableName} is missing source metadata`);
  }

  const sanitizedValues = sanitizePostgresJsonValue(params.row.values);
  const sanitizedReferences = sanitizePostgresJsonValue(params.row.references ?? {});

  return [
    params.rowIndex,
    params.row.tableName,
    sourceSystem,
    sourceRecordKey,
    readStringValue(params.row.values.source_record_hash),
    readStringValue(params.row.values.source_artifact_uri),
    stableJsonStringify(sanitizedValues),
    stableJsonStringify(sanitizedReferences),
  ]
    .map((value) => serializeCsvField(value))
    .join(",")
    .concat("\n");
}

/**
 * Convert JSON-like values into a PostgreSQL JSONB-safe shape.
 *
 * PostgreSQL rejects the JSON escape sequence `\\u0000` when parsing `jsonb` values,
 * even when the source text was valid JavaScript JSON. Browser-harvested pages can
 * contain literal NUL characters in visible text or HTML snippets, so the bulk stage
 * serializer replaces only those unsupported characters before `COPY` sends the JSON
 * payload to Postgres. Object keys and all non-string scalar values are preserved.
 *
 * @param value - Arbitrary JSON-compatible value from a prepared bulk-loader row.
 * @returns A deep copy with NUL characters in string values replaced by `�`.
 */
export function sanitizePostgresJsonValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\u0000/g, "�");
  if (Array.isArray(value)) return value.map((entry) => sanitizePostgresJsonValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        sanitizePostgresJsonValue(entryValue),
      ]),
    );
  }
  return value;
}

/**
 * Serialize a single field using PostgreSQL-compatible CSV escaping.
 *
 * `null` values become unquoted empty fields so `COPY ... NULL ''` reads them as
 * SQL nulls; empty strings become quoted empty fields so they remain strings.
 *
 * @param value - Field value to serialize into a CSV cell.
 * @returns Escaped field text without a trailing delimiter.
 */
export function serializeCsvField(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  if (text.length === 0) return "\"\"";
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

/**
 * Create the temporary generic staging table used by one local bulk load.
 *
 * The table intentionally stores row values and reference keys as JSONB so one
 * staging file can carry rows for all logical tables. It is temporary and scoped
 * to the active Postgres connection.
 *
 * @param client - Query client bound to the session that will also perform COPY and merge.
 * @param stageTableName - Safe temporary table name to create in the current session.
 * @returns Promise that resolves once the staging table and lookup indexes exist.
 */
export async function createBulkStageTable(
  client: QueryClient,
  stageTableName: string,
): Promise<void> {
  const stageTable = quoteIdentifier(stageTableName);
  await client.query(`DROP TABLE IF EXISTS ${stageTable}`, []);
  await client.query(
    [
      `CREATE TEMP TABLE ${stageTable} (`,
      `"row_index" bigint NOT NULL,`,
      `"table_name" text NOT NULL,`,
      `"source_system" text NOT NULL,`,
      `"source_record_key" text NOT NULL,`,
      `"source_record_hash" text,`,
      `"source_artifact_uri" text,`,
      `"values_json" jsonb NOT NULL,`,
      `"references_json" jsonb NOT NULL DEFAULT '{}'::jsonb`,
      `) ON COMMIT PRESERVE ROWS`,
    ].join(" "),
    [],
  );
  await client.query(
    `CREATE INDEX ${quoteIdentifier(`${stageTableName}_table_idx`)} ON ${stageTable} ("table_name")`,
    [],
  );
  await client.query(
    `CREATE INDEX ${quoteIdentifier(`${stageTableName}_source_idx`)} ON ${stageTable} ("source_system", "source_record_key")`,
    [],
  );
}

/**
 * Read ordered public-table column metadata for the target logical tables.
 *
 * @param client - Query client connected to the destination Postgres database.
 * @param tableNames - Logical table names whose public schema columns are needed.
 * @returns Map of table name to physical columns ordered by ordinal position.
 */
export async function readBulkTableColumns(
  client: QueryClient,
  tableNames: readonly LogicalTableName[],
): Promise<ReadonlyMap<LogicalTableName, readonly BulkTableColumn[]>> {
  const result = await client.query<BulkTableColumn>(
    [
      `SELECT table_name::text AS table_name,`,
      `column_name::text AS column_name,`,
      `ordinal_position::int AS ordinal_position`,
      `FROM information_schema.columns`,
      `WHERE table_schema = 'public' AND table_name = ANY($1)`,
      `ORDER BY table_name, ordinal_position`,
    ].join(" "),
    [tableNames],
  );
  const grouped = new Map<LogicalTableName, BulkTableColumn[]>();
  for (const row of result.rows) {
    const tableName = row.table_name;
    const existing = grouped.get(tableName) ?? [];
    existing.push(row);
    grouped.set(tableName, existing);
  }
  for (const tableName of tableNames) {
    if ((grouped.get(tableName) ?? []).length === 0) {
      throw new Error(`No public table metadata found for ${tableName}`);
    }
  }
  return grouped;
}

/**
 * Merge one logical table from the generic staging table into its final table.
 *
 * The generated SQL deduplicates staged rows by the configured conflict key,
 * resolves source-key references by joining already-merged parent tables, and
 * skips updates when both source hashes and configured derived columns are unchanged.
 *
 * @param client - Query client connected to the same session containing the temp staging table.
 * @param params - Stage table name, target table, and target column metadata.
 * @returns Counts for attempted staged rows, deduped candidate rows, and changed final rows.
 */
export async function mergeBulkStageTable(
  client: QueryClient,
  params: {
    readonly stageTableName: string;
    readonly tableName: LogicalTableName;
    readonly columns: readonly BulkTableColumn[];
  },
): Promise<BulkMergeResult> {
  const sql = buildBulkMergeSql(params);
  const result = await client.query<BulkMergeResultRow>(sql, [params.tableName]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Merge for ${params.tableName} returned no counters`);
  }
  return {
    tableName: params.tableName,
    attemptedRows: row.attempted_rows,
    dedupedRows: row.deduped_rows,
    changedRows: row.changed_rows,
  };
}

/**
 * Build the set-based merge SQL for one logical target table.
 *
 * @param params - Stage table name, target table, and target physical columns.
 * @returns Parameterized SQL text; bind `$1` to the target table name.
 */
export function buildBulkMergeSql(params: {
  readonly stageTableName: string;
  readonly tableName: LogicalTableName;
  readonly columns: readonly BulkTableColumn[];
}): string {
  const spec = DEFAULT_TABLE_WRITE_SPECS.get(params.tableName);
  if (spec === undefined) throw new Error(`Missing table write spec for ${params.tableName}`);

  const primaryOrReturnedColumns = new Set(spec.returningColumns);
  const targetTableSql = quoteQualifiedIdentifier("public", params.tableName);
  const stageTableSql = quoteIdentifier(params.stageTableName);
  const insertColumnNames = params.columns
    .map((column) => column.column_name)
    .filter((columnName) => !primaryOrReturnedColumns.has(columnName))
    .filter((columnName) => !GENERATED_OR_DEFAULT_COLUMNS.has(columnName));
  if (insertColumnNames.length === 0) {
    throw new Error(`No insertable columns found for ${params.tableName}`);
  }

  const insertColumnsSql = insertColumnNames.map(quoteIdentifier).join(", ");
  const selectColumnsSql = insertColumnNames.map(quoteIdentifier).join(", ");
  const conflictColumnsSql = spec.conflictColumns.map(quoteIdentifier).join(", ");
  const distinctColumnsSql = spec.conflictColumns.map(quoteIdentifier).join(", ");
  const updateAssignments = insertColumnNames
    .filter((columnName) => !spec.conflictColumns.includes(columnName))
    .map((columnName) => `${quoteIdentifier(columnName)} = EXCLUDED.${quoteIdentifier(columnName)}`);
  if (params.columns.some((column) => column.column_name === "loaded_at")) {
    updateAssignments.push(`"loaded_at" = now()`);
  }
  if (TABLES_WITH_UPDATED_AT.has(params.tableName)) {
    updateAssignments.push(`"updated_at" = now()`);
  }

  const referenceSql = buildReferenceSql(params.tableName);
  const resolvedValuesExpression = buildResolvedValuesJsonExpression(
    params.tableName,
    referenceSql.jsonExpression,
  );
  const updateGuard = buildBulkUpdateGuard({
    comparisonColumnNames: BULK_UPDATE_GUARD_COLUMNS_BY_TABLE.get(params.tableName) ?? [],
    insertColumnNames,
    targetTableSql,
  });

  return [
    `WITH source_rows AS (`,
    `SELECT s."row_index", ${resolvedValuesExpression} AS "resolved_values_json"`,
    `FROM ${stageTableSql} s`,
    referenceSql.joinSql,
    `WHERE s."table_name" = $1`,
    `), typed_rows AS (`,
    `SELECT "row_index", (jsonb_populate_record(NULL::${targetTableSql}, "resolved_values_json")).*`,
    `FROM source_rows`,
    `), deduped_rows AS (`,
    `SELECT DISTINCT ON (${distinctColumnsSql}) *`,
    `FROM typed_rows`,
    `ORDER BY ${distinctColumnsSql}, "row_index" DESC`,
    `), changed_rows AS (`,
    `INSERT INTO ${targetTableSql} (${insertColumnsSql})`,
    `SELECT ${selectColumnsSql}`,
    `FROM deduped_rows`,
    `ON CONFLICT (${conflictColumnsSql}) DO UPDATE SET`,
    updateAssignments.join(", "),
    updateGuard,
    `RETURNING 1`,
    `) SELECT`,
    `(SELECT count(*)::int FROM source_rows) AS attempted_rows,`,
    `(SELECT count(*)::int FROM deduped_rows) AS deduped_rows,`,
    `(SELECT count(*)::int FROM changed_rows) AS changed_rows`,
  ].join(" ");
}

/**
 * Build the staged JSON expression used before `jsonb_populate_record` casts
 * values into a target table row.
 *
 * @param tableName - Logical target table being merged.
 * @param referenceJsonExpression - JSON object expression containing resolved FK values.
 * @returns SQL expression that combines source JSON, table-specific hydrated values, and references.
 */
function buildResolvedValuesJsonExpression(
  tableName: LogicalTableName,
  referenceJsonExpression: string,
): string {
  const hydrationExpression = buildHydrationJsonExpression(tableName);
  if (hydrationExpression === null) {
    return `s."values_json" || ${referenceJsonExpression}`;
  }
  return `s."values_json" || ${hydrationExpression} || ${referenceJsonExpression}`;
}

/**
 * Build an optional JSON expression that fills denormalized table columns from
 * resolved parent rows without overwriting source-supplied values.
 *
 * @param tableName - Logical target table being merged.
 * @returns SQL JSONB expression or `null` when the table needs no hydration.
 */
function buildHydrationJsonExpression(tableName: LogicalTableName): string | null {
  if (tableName !== "business_registration_addresses") return null;
  const jsonArguments = BUSINESS_REGISTRATION_ADDRESS_HYDRATION_COLUMNS.flatMap((column) => [
    quoteLiteral(column.targetColumnName),
    `COALESCE(${sourceJsonText(column.targetColumnName)}, ${column.fallbackExpression})`,
  ]);
  return `jsonb_strip_nulls(jsonb_build_object(${jsonArguments.join(", ")}))`;
}

/**
 * Build an upsert guard that preserves the source-hash shortcut while allowing
 * derived FK or denormalized columns to refresh when source payloads are stable.
 *
 * @param params - Target table SQL name, insertable columns, and extra comparison columns.
 * @returns SQL `WHERE` clause for `ON CONFLICT DO UPDATE`, or an empty string.
 */
function buildBulkUpdateGuard(params: {
  readonly targetTableSql: string;
  readonly insertColumnNames: readonly string[];
  readonly comparisonColumnNames: readonly string[];
}): string {
  const insertColumns = new Set(params.insertColumnNames);
  const conditions: string[] = [];
  if (insertColumns.has("source_record_hash")) {
    conditions.push(
      `${params.targetTableSql}."source_record_hash" IS DISTINCT FROM EXCLUDED."source_record_hash"`,
    );
  }
  for (const columnName of params.comparisonColumnNames) {
    if (!insertColumns.has(columnName)) continue;
    const columnSql = quoteIdentifier(columnName);
    conditions.push(`${params.targetTableSql}.${columnSql} IS DISTINCT FROM EXCLUDED.${columnSql}`);
  }
  if (conditions.length === 0) return "";
  return ` WHERE ${conditions.join(" OR ")}`;
}

function buildReferenceSql(tableName: LogicalTableName): {
  readonly joinSql: string;
  readonly jsonExpression: string;
} {
  const joins: string[] = [];
  const jsonArguments: string[] = [];
  for (const resolution of SOURCE_KEY_REFERENCE_RESOLUTIONS) {
    if (!resolution.targetTables.has(tableName)) continue;
    joins.push(buildSourceKeyReferenceJoin(resolution));
    jsonArguments.push(
      quoteLiteral(resolution.targetColumnName),
      `${quoteIdentifier(resolution.alias)}.${quoteIdentifier(resolution.targetIdColumnName)}`,
    );
  }

  if (TABLES_WITH_BUSINESS_REGISTRATION_ID.has(tableName)) {
    joins.push(buildBusinessRegistrationSourceKeyJoin());
    joins.push(buildBusinessRegistrationDocumentJoin());
    jsonArguments.push(
      quoteLiteral("business_registration_id"),
      `COALESCE("ref_business_registration_key"."business_registration_id", "ref_business_registration_document"."business_registration_id")`,
    );
  }

  return {
    joinSql: joins.join(" "),
    jsonExpression:
      jsonArguments.length === 0
        ? `'{}'::jsonb`
        : `jsonb_strip_nulls(jsonb_build_object(${jsonArguments.join(", ")}))`,
  };
}

function buildSourceKeyReferenceJoin(resolution: ReferenceResolution): string {
  const alias = quoteIdentifier(resolution.alias);
  const targetTable = quoteQualifiedIdentifier("public", resolution.targetTableName);
  const referenceExpression = referenceJsonText(resolution.referenceJsonKey);
  const sourceSystemExpression = sourceSystemFromReferenceExpression(referenceExpression);
  return [
    `LEFT JOIN ${targetTable} ${alias} ON`,
    `${alias}."source_record_key" = ${referenceExpression}`,
    `AND (${sourceSystemExpression} IS NULL OR ${alias}."source_system" = ${sourceSystemExpression})`,
  ].join(" ");
}

function buildBusinessRegistrationSourceKeyJoin(): string {
  const alias = `"ref_business_registration_key"`;
  const referenceExpression = referenceJsonText("businessRegistrationSourceRecordKey");
  const sourceSystemExpression = sourceSystemFromReferenceExpression(referenceExpression);
  return [
    `LEFT JOIN "public"."business_registrations" ${alias} ON`,
    `${alias}."source_record_key" = ${referenceExpression}`,
    `AND (${sourceSystemExpression} IS NULL OR ${alias}."source_system" = ${sourceSystemExpression})`,
  ].join(" ");
}

function buildBusinessRegistrationDocumentJoin(): string {
  return [
    `LEFT JOIN "public"."business_registrations" "ref_business_registration_document" ON`,
    `"ref_business_registration_document"."source_system" = COALESCE(s."values_json" ->> 'source_system', 'sunbiz')`,
    `AND "ref_business_registration_document"."document_number" = ${referenceJsonText("businessRegistrationDocumentNumber")}`,
  ].join(" ");
}

function referenceJsonText(key: keyof PreparedRowReferences): string {
  return `s."references_json" ->> ${quoteLiteral(key)}`;
}

function sourceJsonText(columnName: string): string {
  return `NULLIF(s."values_json" ->> ${quoteLiteral(columnName)}, '')`;
}

function sourceSystemFromReferenceExpression(expression: string): string {
  return [
    `CASE`,
    `WHEN ${expression} LIKE 'bbb:%' THEN 'bbb'`,
    `WHEN ${expression} LIKE 'lee_appraiser:%' THEN 'lee_appraiser'`,
    `WHEN ${expression} LIKE 'lee_accela:%' THEN 'lee_accela'`,
    `WHEN ${expression} LIKE 'sunbiz:%' THEN 'sunbiz'`,
    `ELSE NULL`,
    `END`,
  ].join(" ");
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function quoteQualifiedIdentifier(schemaName: string, tableName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
