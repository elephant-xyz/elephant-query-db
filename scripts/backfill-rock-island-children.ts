import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import AdmZip from "adm-zip";
import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";

import {
  mapAppraisalTransformedFile,
  parseAppraisalSourcePayloadSidecar,
  upsertPreparedRows,
  type JsonObject,
  type LogicalTableName,
  type PreparedRow,
  type QueryClient,
} from "../src/loader/index.js";
import { artifactPathOnEbs } from "./repair-rock-island-geometry-source-payload.js";

const SOURCE_SYSTEM = "rock_island_appraiser";
const FOLIO_PATTERN = /^[0-9]{10}$/u;
const SAFE_RUN_ID_PATTERN = /^[a-z0-9_]+$/u;

const TARGET_TABLE_ORDER: readonly LogicalTableName[] = [
  "unnormalized_addresses",
  "addresses",
  "properties",
  "property_improvements",
  "people",
  "companies",
  "deeds",
  "fact_sheets",
  "geometries",
  "sales_histories",
  "taxes",
  "property_valuations",
  "structures",
  "utilities",
  "layouts",
  "lots",
  "flood_storm_information",
  "files",
  "ownerships",
];

const PROPERTY_FOLIO_JOIN_TABLES: ReadonlySet<LogicalTableName> = new Set([
  "ownerships",
  "property_valuations",
]);

const UNRELATED_COUNT_QUERIES = {
  nonAppraisalAddresses:
    "SELECT count(*)::text AS count FROM addresses WHERE source_system <> $1",
  companies: "SELECT count(*)::text AS count FROM companies",
  businessRegistrations:
    "SELECT count(*)::text AS count FROM business_registrations",
  businessRegistrationAddresses:
    "SELECT count(*)::text AS count FROM business_registration_addresses",
  businessRegistrationParties:
    "SELECT count(*)::text AS count FROM business_registration_parties",
  nonAppraisalPropertyImprovements:
    "SELECT count(*)::text AS count FROM property_improvements WHERE source_system <> $1",
  permitLinks: "SELECT count(*)::text AS count FROM permit_links",
  permitEvents: "SELECT count(*)::text AS count FROM permit_events",
  permitFees: "SELECT count(*)::text AS count FROM permit_fees",
  permitContacts: "SELECT count(*)::text AS count FROM permit_contacts",
  permitCustomFields:
    "SELECT count(*)::text AS count FROM permit_custom_fields",
  inspections: "SELECT count(*)::text AS count FROM inspections",
} as const;

export type BackfillOptions = {
  readonly evidenceDirectory: string;
  readonly checkpointDirectory: string;
  readonly runId: string;
  readonly apply: boolean;
};

type ReconciliationReport = {
  readonly sourceSystem: string;
  readonly counts: {
    readonly sourceAchievableProperties: number;
    readonly sourceAchievableAddresses: number;
    readonly sourceAchievableLots: number;
  };
  readonly overlaps: {
    readonly backfillFolios: number;
  };
  readonly listDigests: {
    readonly backfillFoliosSha256: string;
  };
};

type ParcelArtifactRow = {
  readonly request_identifier: string;
  readonly source_artifact_uri: string;
};

type CountRow = {
  readonly count: string;
};

type ActiveJobRow = {
  readonly pid: number;
  readonly application_name: string;
  readonly state: string;
  readonly query: string;
};

type BackfillScope = {
  readonly folios: readonly string[];
  readonly rows: readonly PreparedRow[];
  readonly sourceKeysByTable: ReadonlyMap<LogicalTableName, readonly string[]>;
  readonly excludedRowsByTable: Readonly<Record<string, number>>;
  readonly artifactHashes: Readonly<Record<string, string>>;
};

type AppliedBackfill = {
  readonly changedRows: number;
  readonly unchangedRows: number;
  readonly checkpointSchema: string;
};

/**
 * Return true only for a plain JSON object.
 *
 * @param value - Candidate parsed JSON value.
 * @returns Whether the value is a JSON object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse command-line options for a dry-run or applied targeted backfill.
 *
 * @param argv - Command-line arguments after the script path.
 * @returns Validated evidence/checkpoint paths and immutable run identifier.
 */
export function parseBackfillOptions(argv: readonly string[]): BackfillOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    const next = argv[index + 1];
    if (
      token?.startsWith("--") === true &&
      next !== undefined &&
      !next.startsWith("--")
    ) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const evidenceDirectory = values.get("evidence-dir");
  const checkpointDirectory = values.get("checkpoint-dir");
  const runId = values.get("run-id");
  if (
    evidenceDirectory === undefined ||
    checkpointDirectory === undefined ||
    runId === undefined
  ) {
    throw new Error(
      "--evidence-dir, --checkpoint-dir, and --run-id are required",
    );
  }
  if (!SAFE_RUN_ID_PATTERN.test(runId) || runId.length > 30) {
    throw new Error("--run-id must be 1-30 lowercase letters, digits, or underscores");
  }
  return { evidenceDirectory, checkpointDirectory, runId, apply };
}

/**
 * Build the digest format used by the reconciliation report.
 *
 * @param folios - Ordered exact backfill folios.
 * @returns SHA-256 digest of newline-delimited folio bytes.
 */
export function hashBackfillFolios(folios: readonly string[]): string {
  return createHash("sha256").update(`${folios.join("\n")}\n`).digest("hex");
}

/**
 * Read and verify the reconciliation-owned backfill scope.
 *
 * @param evidenceDirectory - Directory containing report.json and backfill-folios.txt.
 * @returns Verified report and exact sorted folios.
 */
async function readBackfillEvidence(evidenceDirectory: string): Promise<{
  readonly report: ReconciliationReport;
  readonly folios: readonly string[];
}> {
  const parsed: unknown = JSON.parse(
    await readFile(join(evidenceDirectory, "report.json"), "utf8"),
  );
  if (
    !isJsonObject(parsed) ||
    parsed.sourceSystem !== SOURCE_SYSTEM ||
    !isJsonObject(parsed.counts) ||
    !isJsonObject(parsed.overlaps) ||
    !isJsonObject(parsed.listDigests)
  ) {
    throw new Error("Invalid Rock Island reconciliation report");
  }
  const report = parsed as unknown as ReconciliationReport;
  const folios = (await readFile(
    join(evidenceDirectory, "backfill-folios.txt"),
    "utf8",
  ))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (
    folios.some((folio) => !FOLIO_PATTERN.test(folio)) ||
    new Set(folios).size !== folios.length ||
    [...folios].sort().some((folio, index) => folio !== folios[index])
  ) {
    throw new Error("Backfill folios must be unique, sorted ten-digit identifiers");
  }
  if (
    folios.length !== report.overlaps.backfillFolios ||
    hashBackfillFolios(folios) !== report.listDigests.backfillFoliosSha256
  ) {
    throw new Error("Backfill folio list does not match reconciliation digest");
  }
  return { report, folios };
}

/**
 * Quote a compile-time table/schema identifier after strict validation.
 *
 * @param identifier - PostgreSQL identifier.
 * @returns Safely double-quoted identifier.
 */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/**
 * Adapt a transaction-bound pg client to the query-db loader contract.
 *
 * @param client - Connected PostgreSQL transaction client.
 * @returns Generic query-db query client.
 */
function createLoaderQueryClient(client: PoolClient): QueryClient {
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ) {
      const result = await client.query<Row & QueryResultRow>(text, [...values]);
      return { rows: result.rows };
    },
  };
}

/**
 * Ensure corporate, permit, Illinois, and other loader work is not active.
 *
 * @param client - Connected PostgreSQL client.
 * @returns Promise resolved only when no conflicting active session exists.
 */
async function assertNoConflictingDatabaseJobs(
  client: PoolClient,
): Promise<void> {
  const result = await client.query<ActiveJobRow>(
    `SELECT pid,
            application_name,
            state,
            left(query, 300) AS query
       FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND datname = current_database()
        AND backend_type = 'client backend'
        AND (state <> 'idle' OR xact_start IS NOT NULL)
      ORDER BY query_start`,
  );
  if (result.rows.length > 0) {
    throw new Error(
      `Conflicting database jobs are active: ${JSON.stringify(result.rows)}`,
    );
  }
}

/**
 * Bind the appraisal source only for count queries that declare its placeholder.
 *
 * @param sql - Static unrelated-count query.
 * @returns Empty parameters or the Rock Island appraisal source key.
 */
export function unrelatedCountQueryValues(sql: string): readonly string[] {
  return sql.includes("$1") ? [SOURCE_SYSTEM] : [];
}

/**
 * Load unrelated corporate/permit/shared-table counts for before/after proof.
 *
 * @param client - Connected PostgreSQL client.
 * @returns Stable count map.
 */
async function readUnrelatedCounts(
  client: PoolClient,
): Promise<Readonly<Record<string, number>>> {
  const entries: Array<readonly [string, number]> = [];
  for (const [name, sql] of Object.entries(UNRELATED_COUNT_QUERIES)) {
    const result = await client.query<CountRow>(
      sql,
      [...unrelatedCountQueryValues(sql)],
    );
    entries.push([
      name,
      Number.parseInt(result.rows[0]?.count ?? "0", 10),
    ]);
  }
  return Object.fromEntries(entries);
}

/**
 * Identify child tables whose folio exists only on the linked property row.
 *
 * @param table - Logical query-db table.
 * @returns Whether source-scoped folio counts require a properties join.
 */
export function targetCountUsesPropertyJoin(
  table: LogicalTableName,
): boolean {
  return PROPERTY_FOLIO_JOIN_TABLES.has(table);
}

/**
 * Load exact Rock Island appraisal table counts.
 *
 * @param client - Connected PostgreSQL client.
 * @returns Source-scoped rows and distinct folios for every target table.
 */
async function readTargetCounts(
  client: PoolClient,
): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> {
  const entries: Array<
    readonly [string, Readonly<Record<string, number>>]
  > = [];
  for (const table of ["parcels", ...TARGET_TABLE_ORDER]) {
    const quoted = quoteIdentifier(table);
    if (
      table !== "parcels" &&
      targetCountUsesPropertyJoin(table as LogicalTableName)
    ) {
      const result = await client.query<{
        readonly rows: string;
        readonly folios: string;
      }>(
        `SELECT count(*)::text AS rows,
                count(DISTINCT property.request_identifier)::text AS folios
           FROM ${quoted} child
           LEFT JOIN properties property
             ON property.property_id = child.property_id
            AND property.source_system = child.source_system
          WHERE child.source_system = $1`,
        [SOURCE_SYSTEM],
      );
      const row = result.rows[0];
      entries.push([
        table,
        {
          rows: Number.parseInt(row?.rows ?? "0", 10),
          folios: Number.parseInt(row?.folios ?? "0", 10),
        },
      ]);
      continue;
    }
    const result = await client.query<{
      readonly rows: string;
      readonly folios: string;
    }>(
      `SELECT count(*)::text AS rows,
              count(DISTINCT request_identifier)::text AS folios
         FROM ${quoted}
        WHERE source_system = $1`,
      [SOURCE_SYSTEM],
    );
    const row = result.rows[0];
    entries.push([
      table,
      {
        rows: Number.parseInt(row?.rows ?? "0", 10),
        folios: Number.parseInt(row?.folios ?? "0", 10),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

/**
 * Give mapped rows deterministic foreign-key-safe order.
 *
 * @param rows - Mapped source rows.
 * @returns Stable dependency-ordered rows.
 */
export function sortBackfillRows(
  rows: readonly PreparedRow[],
): readonly PreparedRow[] {
  const order = new Map(
    TARGET_TABLE_ORDER.map((tableName, index) => [tableName, index]),
  );
  return [...rows].sort(
    (left, right) =>
      (order.get(left.tableName) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.tableName) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Decide whether a mapped row belongs to the proven normalized-child repair.
 *
 * Rock Island has zero fact-sheet rows across all 64,626 successfully merged
 * folios. Replaying that publication compatibility entity only for the 1,180
 * repair folios would create an unrelated partial population.
 *
 * @param table - Mapped logical query-db table.
 * @returns Whether the row is eligible for this targeted replay.
 */
export function shouldReplayBackfillTable(
  table: LogicalTableName,
): boolean {
  return table !== "fact_sheets";
}

/**
 * Map one retained transformed ZIP through the production appraisal mapper.
 *
 * Parcel parents already exist for this repair and are deliberately excluded;
 * every other source-scoped normalized row is replayed idempotently.
 *
 * @param parcel - Exact folio and retained artifact URI.
 * @returns Validated non-parcel rows and artifact digest.
 */
function mapBackfillArtifact(parcel: ParcelArtifactRow): {
  readonly rows: readonly PreparedRow[];
  readonly artifactSha256: string;
} {
  const path = artifactPathOnEbs(parcel.source_artifact_uri);
  const bytes = readFileSync(path);
  const zip = new AdmZip(bytes);
  const sidecar = zip.getEntry("data/source_payload.ndjson");
  if (sidecar === null) {
    throw new Error(`Missing source sidecar for ${parcel.request_identifier}`);
  }
  const sourcePayload = parseAppraisalSourcePayloadSidecar(
    sidecar.getData().toString("utf8"),
  );
  const rows: PreparedRow[] = [];
  for (const entry of zip.getEntries()) {
    if (
      entry.isDirectory ||
      !entry.entryName.startsWith("data/") ||
      !entry.entryName.endsWith(".json")
    ) {
      continue;
    }
    const record: unknown = JSON.parse(entry.getData().toString("utf8"));
    const bundle = mapAppraisalTransformedFile({
      artifactSourcePayload: sourcePayload,
      artifactUri: parcel.source_artifact_uri,
      countyName: "Rock Island",
      filePath: entry.entryName,
      record,
      requestIdentifier: parcel.request_identifier,
      sourceSystem: SOURCE_SYSTEM,
      stateCode: "IL",
    });
    for (const row of bundle.rows) {
      if (row.tableName === "parcels") continue;
      if (
        row.values.source_system !== SOURCE_SYSTEM ||
        typeof row.values.source_record_key !== "string" ||
        !row.values.source_record_key.startsWith(
          `${SOURCE_SYSTEM}:${parcel.request_identifier}:`,
        )
      ) {
        throw new Error(
          `Mapper escaped Rock Island folio scope: ${parcel.request_identifier}`,
        );
      }
      rows.push(row);
    }
  }
  return {
    rows: sortBackfillRows(rows),
    artifactSha256: createHash("sha256")
      .update(bytes)
      .digest("hex"),
  };
}

/**
 * Build the exact mapped source-record scope from proven reconciliation folios.
 *
 * @param client - Connected PostgreSQL client.
 * @param folios - Proven missing/incorrect folios.
 * @returns Mapped source rows and source keys grouped by logical table.
 */
async function buildBackfillScope(
  client: PoolClient,
  folios: readonly string[],
): Promise<BackfillScope> {
  const result = await client.query<ParcelArtifactRow>(
    `SELECT request_identifier, source_artifact_uri
       FROM parcels
      WHERE source_system = $1
        AND request_identifier = ANY($2::text[])
        AND source_artifact_uri IS NOT NULL
      ORDER BY request_identifier`,
    [SOURCE_SYSTEM, folios],
  );
  if (
    result.rows.length !== folios.length ||
    result.rows.some(
      (row, index) => row.request_identifier !== folios[index],
    )
  ) {
    throw new Error("Backfill scope does not resolve one parcel artifact per folio");
  }
  const rows: PreparedRow[] = [];
  const excludedRowsByTable = new Map<string, number>();
  const artifactHashes: Record<string, string> = {};
  for (const parcel of result.rows) {
    const mapped = mapBackfillArtifact(parcel);
    for (const row of mapped.rows) {
      if (!shouldReplayBackfillTable(row.tableName)) {
        excludedRowsByTable.set(
          row.tableName,
          (excludedRowsByTable.get(row.tableName) ?? 0) + 1,
        );
        continue;
      }
      rows.push(row);
    }
    artifactHashes[parcel.request_identifier] = mapped.artifactSha256;
  }
  const sourceKeysByTable = new Map<LogicalTableName, string[]>();
  for (const row of rows) {
    const key = row.values.source_record_key;
    if (typeof key !== "string") {
      throw new Error(`Mapped ${row.tableName} row has no source_record_key`);
    }
    const keys = sourceKeysByTable.get(row.tableName) ?? [];
    keys.push(key);
    sourceKeysByTable.set(row.tableName, keys);
  }
  sourceKeysByTable.forEach((keys, table) => {
    if (new Set(keys).size !== keys.length) {
      throw new Error(`Duplicate mapped source keys for ${table}`);
    }
  });
  return {
    folios,
    rows: sortBackfillRows(rows),
    sourceKeysByTable,
    excludedRowsByTable: Object.fromEntries(
      [...excludedRowsByTable.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    artifactHashes,
  };
}

/**
 * Prove that appraisal tables outside the mapped replay scope did not change.
 *
 * @param before - Source-scoped table counts captured before the transaction.
 * @param after - Source-scoped table counts captured after the transaction.
 * @param sourceKeysByTable - Exact logical tables included in the replay.
 * @returns Nothing; throws unless every untouched table is unchanged.
 */
function assertUntouchedAppraisalCountsUnchanged(
  before: Readonly<Record<string, Readonly<Record<string, number>>>>,
  after: Readonly<Record<string, Readonly<Record<string, number>>>>,
  sourceKeysByTable: ReadonlyMap<LogicalTableName, readonly string[]>,
): void {
  for (const [table, beforeCounts] of Object.entries(before)) {
    if (
      table !== "parcels" &&
      sourceKeysByTable.has(table as LogicalTableName)
    ) {
      continue;
    }
    const afterCounts = after[table];
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) {
      throw new Error(`Untouched appraisal table changed: ${table}`);
    }
  }
}

/**
 * Create a database-resident reversible checkpoint for every affected key.
 *
 * @param client - Connected PostgreSQL client.
 * @param schema - Unique checkpoint schema.
 * @param scope - Exact mapped source-record scope.
 * @returns Promise resolved after the checkpoint commits.
 */
async function createCheckpoint(
  client: PoolClient,
  schema: string,
  scope: BackfillScope,
): Promise<void> {
  const quotedSchema = quoteIdentifier(schema);
  await client.query("BEGIN");
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(
      `CREATE TABLE ${quotedSchema}."_scope_keys" (
         table_name text NOT NULL,
         source_record_key text NOT NULL,
         PRIMARY KEY (table_name, source_record_key)
       )`,
    );
    for (const table of TARGET_TABLE_ORDER) {
      const keys = scope.sourceKeysByTable.get(table) ?? [];
      const quotedTable = quoteIdentifier(table);
      await client.query(
        `CREATE TABLE ${quotedSchema}.${quotedTable}
           AS SELECT *
                FROM public.${quotedTable}
               WHERE false`,
      );
      if (keys.length === 0) continue;
      await client.query(
        `INSERT INTO ${quotedSchema}.${quotedTable}
         SELECT *
           FROM public.${quotedTable}
          WHERE source_system = $1
            AND source_record_key = ANY($2::text[])`,
        [SOURCE_SYSTEM, keys],
      );
      await client.query(
        `INSERT INTO ${quotedSchema}."_scope_keys" (table_name, source_record_key)
         SELECT $1, unnest($2::text[])`,
        [table, keys],
      );
    }
    await client.query("COMMIT");
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  }
}

/**
 * Generate a targeted rollback script backed by the checkpoint schema.
 *
 * @param schema - Checkpoint schema name.
 * @returns FK-safe delete and restore SQL.
 */
export function buildRollbackSql(schema: string): string {
  const quotedSchema = quoteIdentifier(schema);
  const reverse = [...TARGET_TABLE_ORDER].reverse();
  const lines = [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '30min';",
  ];
  for (const table of reverse) {
    const quotedTable = quoteIdentifier(table);
    lines.push(
      `DELETE FROM public.${quotedTable} target`,
      ` USING ${quotedSchema}."_scope_keys" scope`,
      ` WHERE scope.table_name = '${table}'`,
      `   AND target.source_system = '${SOURCE_SYSTEM}'`,
      "   AND target.source_record_key = scope.source_record_key;",
    );
  }
  for (const table of TARGET_TABLE_ORDER) {
    const quotedTable = quoteIdentifier(table);
    lines.push(
      `INSERT INTO public.${quotedTable}`,
      `SELECT * FROM ${quotedSchema}.${quotedTable};`,
    );
  }
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

/**
 * Apply all mapped rows in one source-scoped transaction.
 *
 * @param client - Connected PostgreSQL client.
 * @param rows - Exact dependency-ordered rows.
 * @param checkpointSchema - Reversible database checkpoint schema.
 * @returns Changed/unchanged upsert counters.
 */
async function applyBackfill(
  client: PoolClient,
  rows: readonly PreparedRow[],
  checkpointSchema: string,
): Promise<AppliedBackfill> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30min'");
    const result = await upsertPreparedRows(
      createLoaderQueryClient(client),
      rows,
      { missingReferenceBehavior: "omit" },
    );
    await client.query("COMMIT");
    return {
      changedRows: result.changedRows,
      unchangedRows: result.unchangedRows,
      checkpointSchema,
    };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  }
}

/**
 * Verify every mapped source key exists and required FKs resolve after replay.
 *
 * @param client - Connected PostgreSQL client.
 * @param scope - Exact mapped source-record scope.
 * @returns Row and orphan counts by table.
 */
async function verifyBackfillScope(
  client: PoolClient,
  scope: BackfillScope,
): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> {
  const results: Record<string, Readonly<Record<string, number>>> = {};
  for (const [table, keys] of scope.sourceKeysByTable) {
    const quotedTable = quoteIdentifier(table);
    const existing = await client.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM public.${quotedTable}
        WHERE source_system = $1
          AND source_record_key = ANY($2::text[])`,
      [SOURCE_SYSTEM, keys],
    );
    let orphanCount = 0;
    if (table === "properties") {
      const orphan = await client.query<CountRow>(
        `SELECT count(*)::text AS count
           FROM properties
          WHERE source_system = $1
            AND source_record_key = ANY($2::text[])
            AND parcel_id IS NULL`,
        [SOURCE_SYSTEM, keys],
      );
      orphanCount = Number.parseInt(orphan.rows[0]?.count ?? "0", 10);
    } else if (
      [
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
      ].includes(table)
    ) {
      const orphan = await client.query<CountRow>(
        `SELECT count(*)::text AS count
           FROM public.${quotedTable}
          WHERE source_system = $1
            AND source_record_key = ANY($2::text[])
            AND property_id IS NULL`,
        [SOURCE_SYSTEM, keys],
      );
      orphanCount = Number.parseInt(orphan.rows[0]?.count ?? "0", 10);
    }
    const count = Number.parseInt(existing.rows[0]?.count ?? "0", 10);
    if (count !== keys.length || orphanCount !== 0) {
      throw new Error(
        `Backfill verification failed for ${table}: expected=${keys.length} actual=${count} orphans=${orphanCount}`,
      );
    }
    results[table] = { expected: keys.length, actual: count, orphanCount };
  }
  return results;
}

/**
 * Run a dry-run or applied idempotent Rock Island child backfill.
 *
 * @param options - Verified evidence, checkpoint path, run id, and apply flag.
 * @returns Durable execution report.
 */
export async function backfillRockIslandChildren(
  options: BackfillOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const evidence = await readBackfillEvidence(options.evidenceDirectory);
  const checkpointSchema = `ri_child_bf_${options.runId}`;
  const runDirectory = join(options.checkpointDirectory, options.runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const pool = new Pool({
    application_name: "rock-island-child-backfill",
    connectionString: databaseUrl,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await assertNoConflictingDatabaseJobs(client);
    const beforeTargetCounts = await readTargetCounts(client);
    const beforeUnrelatedCounts = await readUnrelatedCounts(client);
    const scope = await buildBackfillScope(client, evidence.folios);
    const scopeManifest = {
      schemaVersion: "1",
      sourceSystem: SOURCE_SYSTEM,
      runId: options.runId,
      apply: options.apply,
      folioCount: scope.folios.length,
      folioListSha256: hashBackfillFolios(scope.folios),
      mappedRowCount: scope.rows.length,
      mappedRowsByTable: Object.fromEntries(
        [...scope.sourceKeysByTable.entries()].map(([table, keys]) => [
          table,
          keys.length,
        ]),
      ),
      excludedMappedRowsByTable: scope.excludedRowsByTable,
      artifactHashes: scope.artifactHashes,
      beforeTargetCounts,
      beforeUnrelatedCounts,
      reconciliationCounts: evidence.report.counts,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      join(runDirectory, "scope-manifest.json"),
      `${JSON.stringify(scopeManifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (!options.apply) {
      const dryRun = {
        event: "rock_island_child_backfill_dry_run_complete",
        status: "dry-run",
        checkpointSchema: null,
        runDirectory,
        ...scopeManifest,
      };
      await writeFile(
        join(runDirectory, "backfill-result.json"),
        `${JSON.stringify(dryRun, null, 2)}\n`,
        { mode: 0o600 },
      );
      return dryRun;
    }
    await createCheckpoint(client, checkpointSchema, scope);
    await writeFile(
      join(runDirectory, "rollback.sql"),
      buildRollbackSql(checkpointSchema),
      { mode: 0o600 },
    );
    const applied = await applyBackfill(client, scope.rows, checkpointSchema);
    const verification = await verifyBackfillScope(client, scope);
    const afterTargetCounts = await readTargetCounts(client);
    const afterUnrelatedCounts = await readUnrelatedCounts(client);
    assertUntouchedAppraisalCountsUnchanged(
      beforeTargetCounts,
      afterTargetCounts,
      scope.sourceKeysByTable,
    );
    if (
      JSON.stringify(beforeUnrelatedCounts) !==
      JSON.stringify(afterUnrelatedCounts)
    ) {
      throw new Error("Unrelated corporate/permit/shared-source counts changed");
    }
    const properties = afterTargetCounts.properties?.folios ?? 0;
    const addresses = afterTargetCounts.addresses?.folios ?? 0;
    const lots = afterTargetCounts.lots?.folios ?? 0;
    if (
      properties !== evidence.report.counts.sourceAchievableProperties ||
      addresses !== evidence.report.counts.sourceAchievableAddresses ||
      lots !== evidence.report.counts.sourceAchievableLots
    ) {
      throw new Error(
        `Source-achievable targets failed: properties=${properties}, addresses=${addresses}, lots=${lots}`,
      );
    }
    const result = {
      event: "rock_island_child_backfill_complete",
      status: "verified",
      runId: options.runId,
      runDirectory,
      checkpointSchema,
      rollbackSql: join(runDirectory, "rollback.sql"),
      folioCount: scope.folios.length,
      folioListSha256: hashBackfillFolios(scope.folios),
      mappedRowCount: scope.rows.length,
      excludedMappedRowsByTable: scope.excludedRowsByTable,
      changedRows: applied.changedRows,
      unchangedRows: applied.unchangedRows,
      beforeTargetCounts,
      afterTargetCounts,
      beforeUnrelatedCounts,
      afterUnrelatedCounts,
      unrelatedCountsUnchanged: true,
      verification,
      completedAt: new Date().toISOString(),
    };
    await writeFile(
      join(runDirectory, "backfill-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    return result;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Execute the targeted backfill CLI.
 *
 * @returns Promise resolved after dry-run or applied verification.
 */
async function main(): Promise<void> {
  const result = await backfillRockIslandChildren(
    parseBackfillOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({
        event: "rock_island_child_backfill_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
