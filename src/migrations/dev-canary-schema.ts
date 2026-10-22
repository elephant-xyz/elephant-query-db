import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { z } from "zod";

export const PINNED_DEV_CANARY_MIGRATIONS = [
  {
    tag: "0009_rock_island_geometry_illinois_sos",
    createdAt: 1786993408143,
    hash: "bccbaa70e551b00ab2d983e5f82397be00472f4bbca9f80c79b1c476f823a6db",
  },
  {
    tag: "0010_address_identity",
    createdAt: 1789145530574,
    hash: "057b4b36b5bb21179fb57786f7771a550a94f0c8708d20a158d751e00728335c",
  },
  {
    tag: "0011_identity_pair_constraint",
    createdAt: 1789146488372,
    hash: "b42c48f8b2694e520d3595185bf3d297369ccc14c34d6de4bbba593837ca9a66",
  },
  {
    tag: "0012_private_bbb_persistence",
    createdAt: 1792617628787,
    hash: "b8eab46ca1b8acb5b86af9fd749a87577440222b2176dd1c98fd7ec5754de81a",
  },
] as const;

export const DEV_CANARY_MIGRATION_TAGS = PINNED_DEV_CANARY_MIGRATIONS.map(
  ({ tag }) => tag,
) as readonly (typeof PINNED_DEV_CANARY_MIGRATIONS)[number]["tag"][];

export const BBB_PRIVATE_TABLES = [
  "bbb_artifact_watermarks",
  "bbb_harvest_categories",
  "bbb_harvest_runs",
  "bbb_profile_category_memberships",
  "bbb_profile_snapshots",
  "bbb_property_link_evidence",
  "bbb_reconciliation_matches",
  "bbb_reconciliation_runs",
] as const;

const BBB_PRIVATE_FOREIGN_KEY_DDL_NAMES = [
  "bbb_artifact_watermarks_bbb_harvest_category_id_bbb_harvest_categories_bbb_harvest_category_id_fk",
  "bbb_harvest_categories_bbb_harvest_run_id_bbb_harvest_runs_bbb_harvest_run_id_fk",
  "bbb_profile_category_memberships_bbb_harvest_category_id_bbb_harvest_categories_bbb_harvest_category_id_fk",
  "bbb_profile_category_memberships_bbb_artifact_watermark_id_bbb_artifact_watermarks_bbb_artifact_watermark_id_fk",
  "bbb_profile_category_memberships_bbb_profile_snapshot_id_bbb_profile_snapshots_bbb_profile_snapshot_id_fk",
  "bbb_property_link_evidence_bbb_reconciliation_match_id_bbb_reconciliation_matches_bbb_reconciliation_match_id_fk",
  "bbb_property_link_evidence_property_improvement_id_property_improvements_property_improvement_id_fk",
  "bbb_property_link_evidence_property_id_properties_property_id_fk",
  "bbb_property_link_evidence_company_id_companies_company_id_fk",
  "bbb_reconciliation_matches_bbb_reconciliation_run_id_bbb_reconciliation_runs_bbb_reconciliation_run_id_fk",
  "bbb_reconciliation_matches_company_id_companies_company_id_fk",
  "bbb_reconciliation_matches_representative_profile_snapshot_id_bbb_profile_snapshots_bbb_profile_snapshot_id_fk",
  "bbb_reconciliation_runs_bbb_harvest_run_id_bbb_harvest_runs_bbb_harvest_run_id_fk",
] as const;

// PostgreSQL stores identifiers at NAMEDATALEN - 1 bytes (63 in supported
// releases). Drizzle's generated names are deliberately verified after the
// same deterministic truncation PostgreSQL applies.
export const BBB_PRIVATE_FOREIGN_KEYS = BBB_PRIVATE_FOREIGN_KEY_DDL_NAMES.map(
  (name) => name.slice(0, 63),
);

export const BBB_PRIVATE_INDEXES = [
  "bbb_artifact_watermarks_category_path_idx",
  "bbb_artifact_watermarks_hash_idx",
  "bbb_artifact_watermarks_current_idx",
  "bbb_harvest_categories_run_category_idx",
  "bbb_harvest_categories_status_idx",
  "bbb_harvest_runs_county_run_idx",
  "bbb_harvest_runs_current_county_idx",
  "bbb_harvest_runs_status_idx",
  "bbb_profile_memberships_revision_profile_idx",
  "bbb_profile_memberships_current_profile_idx",
  "bbb_profile_memberships_snapshot_idx",
  "bbb_profile_memberships_current_idx",
  "bbb_profile_snapshots_identity_hash_idx",
  "bbb_profile_snapshots_business_idx",
  "bbb_profile_snapshots_profile_url_idx",
  "bbb_profile_snapshots_names_gin",
  "bbb_profile_snapshots_phones_gin",
  "bbb_profile_snapshots_licenses_gin",
  "bbb_property_link_evidence_match_permit_idx",
  "bbb_property_link_evidence_property_idx",
  "bbb_property_link_evidence_permit_idx",
  "bbb_property_link_evidence_company_idx",
  "bbb_property_link_evidence_source_key_idx",
  "bbb_reconciliation_matches_candidate_idx",
  "bbb_reconciliation_matches_company_outcome_idx",
  "bbb_reconciliation_matches_profile_idx",
  "bbb_reconciliation_matches_business_idx",
  "bbb_reconciliation_runs_key_idx",
  "bbb_reconciliation_runs_current_idx",
  "bbb_reconciliation_runs_status_idx",
] as const;

const BBB_PRIVATE_PRIMARY_KEYS = BBB_PRIVATE_TABLES.map(
  (tableName) => `${tableName}_pkey`,
);
const ADVISORY_LOCK_NAME = "elephant-query-db:dev-canary-schema:0009-0012";
const DRIZZLE_SCHEMA = "drizzle";
const DRIZZLE_TABLE = "__drizzle_migrations";
const ADDRESS_PAIR_CONSTRAINT = "addresses_elephant_identity_pair_check";
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WRITER_PAUSE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const writerPauseProofSchema = z
  .object({
    schemaVersion: z.literal("query-db.dev-writer-pause-proof.v1"),
    environment: z.literal("DEV"),
    endpointFingerprint: z.string().regex(/^[a-f0-9]{16}$/u),
    observedAt: z.string().datetime({ offset: true }),
    inventoryComplete: z.literal(true),
    inventoryRef: z.string().trim().min(3).max(500),
    operatorProvided: z.literal(true),
    writers: z
      .array(
        z
          .object({
            writerId: z
              .string()
              .trim()
              .min(1)
              .max(160)
              .regex(/^[a-z0-9][a-z0-9._:-]*$/iu),
            kind: z.enum(["step-functions", "ecs", "manual-loader", "other"]),
            ownerRef: z.string().trim().min(3).max(500),
            pauseCommand: z.string().trim().min(3).max(4_000),
            resumeCommand: z.string().trim().min(3).max(4_000),
            proofRef: z.string().trim().min(3).max(500),
            paused: z.literal(true),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((proof, context) => {
    const writerIds = proof.writers.map((writer) => writer.writerId);
    if (new Set(writerIds).size !== writerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["writers"],
        message: "writer IDs must be unique",
      });
    }
  });

type WriterPauseProof = z.infer<typeof writerPauseProofSchema>;

interface VerifiedWriterPauseProof {
  readonly proof: WriterPauseProof;
  readonly sha256: string;
}

const TARGET_INDEX_COLUMNS = new Map([
  ["addresses_elephant_uuid_idx", "elephant_uuid"],
  ["addresses_elephant_token_idx", "elephant_token"],
]);

const REQUIRED_COLUMNS = {
  geometry_rings: new Map([
    ["geometry_ring_id", ["uuid", "NO"]],
    ["geometry_id", ["uuid", "NO"]],
    ["request_identifier", ["text", "NO"]],
    ["source_geometry_type", ["text", "NO"]],
    ["polygon_index", ["integer", "NO"]],
    ["ring_index", ["integer", "NO"]],
    ["ring_role", ["text", "NO"]],
    ["coordinates", ["jsonb", "NO"]],
    ["source_payload", ["jsonb", "NO"]],
    ["source_system", ["text", "NO"]],
    ["source_record_key", ["text", "NO"]],
    ["source_record_hash", ["text", "YES"]],
    ["source_artifact_uri", ["text", "YES"]],
    ["loaded_at", ["timestamp with time zone", "NO"]],
    ["created_at", ["timestamp with time zone", "NO"]],
    ["updated_at", ["timestamp with time zone", "NO"]],
  ]),
  illinois_sos_component_records: new Map([
    ["illinois_sos_component_record_id", ["uuid", "NO"]],
    ["entity_kind", ["text", "NO"]],
    ["component", ["text", "NO"]],
    ["file_number", ["text", "NO"]],
    ["snapshot_date", ["date", "NO"]],
    ["source_file_name", ["text", "NO"]],
    ["source_line_number", ["integer", "NO"]],
    ["record_fields", ["jsonb", "NO"]],
    ["privacy_classification", ["text", "NO"]],
    ["publication_approved", ["boolean", "NO"]],
    ["source_payload", ["jsonb", "NO"]],
    ["source_system", ["text", "NO"]],
    ["source_record_key", ["text", "NO"]],
    ["source_record_hash", ["text", "YES"]],
    ["source_artifact_uri", ["text", "YES"]],
    ["loaded_at", ["timestamp with time zone", "NO"]],
    ["created_at", ["timestamp with time zone", "NO"]],
    ["updated_at", ["timestamp with time zone", "NO"]],
  ]),
} as const;

const REQUIRED_CONSTRAINTS = {
  geometry_rings: [
    "geometry_rings_pkey",
    "geometry_rings_geometry_id_geometries_geometry_id_fk",
    "geometry_rings_geometry_polygon_ring_unique",
    "geometry_rings_source_type_check",
    "geometry_rings_role_check",
    "geometry_rings_indexes_check",
    "geometry_rings_role_index_check",
  ],
  illinois_sos_component_records: [
    "illinois_sos_component_records_pkey",
    "illinois_sos_component_records_source_record_unique",
    "illinois_sos_component_records_entity_kind_check",
    "illinois_sos_component_records_privacy_check",
    "illinois_sos_component_records_publication_check",
  ],
} as const;

const REQUIRED_INDEXES = {
  geometry_rings: [
    "geometry_rings_pkey",
    "geometry_rings_geometry_polygon_ring_unique",
    "geometry_rings_source_record_idx",
    "geometry_rings_geometry_idx",
    "geometry_rings_request_idx",
  ],
  illinois_sos_component_records: [
    "illinois_sos_component_records_pkey",
    "illinois_sos_component_records_source_record_unique",
    "illinois_sos_component_records_entity_file_idx",
    "illinois_sos_component_records_snapshot_idx",
  ],
} as const;

interface JournalEntry {
  readonly idx?: number;
  readonly tag: string;
  readonly when: number;
}

export interface MigrationDescriptor {
  readonly tag: (typeof PINNED_DEV_CANARY_MIGRATIONS)[number]["tag"];
  readonly createdAt: number;
  readonly hash: string;
  readonly sql: string;
}

interface RelationRow {
  readonly relname: string;
  readonly estimated_rows: string;
  readonly heap_bytes: string;
  readonly index_bytes: string;
  readonly total_bytes: string;
}

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: "YES" | "NO";
}

interface ConstraintRow {
  readonly table_name: string;
  readonly conname: string;
  readonly contype: string;
  readonly convalidated: boolean;
  readonly definition: string;
}

interface IndexRow {
  readonly table_name: string;
  readonly index_name: string;
  readonly is_valid: boolean;
  readonly is_ready: boolean;
  readonly is_unique: boolean;
  readonly access_method: string;
  readonly keys: string[];
  readonly predicate: string | null;
}

interface LedgerRow {
  readonly hash: string;
  readonly created_at: string | null;
}

interface IdentityRow {
  readonly database_name: string;
  readonly role_name: string;
  readonly server_version_num: string;
  readonly is_replica: boolean;
}

interface PermissionRow {
  readonly can_create_public: boolean;
  readonly can_create_schema: boolean;
  readonly can_alter_addresses: boolean;
  readonly can_reference_geometries: boolean;
  readonly can_reference_companies: boolean;
  readonly can_reference_properties: boolean;
  readonly can_reference_property_improvements: boolean;
}

interface ActivityRow {
  readonly active_sessions: number;
  readonly open_transactions: number;
  readonly waiting_sessions: number;
  readonly target_write_locks: number;
}

export interface DevCanaryMigrationState {
  readonly endpointFingerprint: string;
  readonly databaseFingerprint: string;
  readonly roleFingerprint: string;
  readonly directConnection: boolean;
  readonly serverVersionNum: string;
  readonly isReplica: boolean;
  readonly relations: ReadonlyMap<string, RelationRow>;
  readonly columns: readonly ColumnRow[];
  readonly constraints: readonly ConstraintRow[];
  readonly indexes: readonly IndexRow[];
  readonly ledgerTablePresent: boolean;
  readonly ledgerRows: readonly LedgerRow[];
  readonly permissions: PermissionRow;
  readonly activity: ActivityRow;
}

export interface DevCanaryMigrationReport {
  readonly schemaVersion: "query-db.dev-canary-migration.v1";
  readonly mode: "plan" | "apply" | "verify";
  readonly environment: {
    readonly name: string;
    readonly endpointFingerprint: string;
    readonly databaseFingerprint: string;
    readonly roleFingerprint: string;
    readonly directConnection: boolean;
    readonly serverVersionNum: string;
    readonly isReplica: boolean;
  };
  readonly risk: {
    readonly estimatedAddressRows: string;
    readonly addressHeapBytes: string;
    readonly addressIndexBytes: string;
    readonly addressTotalBytes: string;
    readonly activeSessions: number;
    readonly openTransactions: number;
    readonly waitingSessions: number;
    readonly targetWriteLocks: number;
    readonly operations: readonly string[];
    readonly migration0012: {
      readonly targetTablesPresent: number;
      readonly expectedTables: 8;
      readonly expectedForeignKeys: 13;
      readonly expectedIndexes: 30;
      readonly existingRows: string;
      readonly referencedRelations: readonly {
        readonly tableName: string;
        readonly estimatedRows: string;
        readonly totalBytes: string;
      }[];
    };
  };
  readonly targetMigrations: readonly {
    readonly tag: string;
    readonly createdAt: number;
    readonly hash: string;
    readonly recorded: boolean;
  }[];
  readonly blockers: readonly string[];
  readonly pendingActions: readonly string[];
  readonly completedChecks: readonly string[];
  readonly authorizationEvidence: {
    readonly approvalRefCount: number;
    readonly backupCreatedAt: string;
    readonly writerPauseProofSha256: string;
    readonly writerCount: number;
  } | null;
  readonly ready: boolean;
}

export interface DevCanaryMigrationOptions {
  readonly mode: "plan" | "apply" | "verify";
  readonly environment: string;
  readonly expectedEndpointFingerprint?: string;
  readonly approvalRefs?: readonly string[];
  readonly backupRef?: string;
  readonly backupCreatedAt?: string;
  readonly writerPauseProofPath?: string;
  readonly migrationsFolder?: string;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeCheckDefinition(value: string): string {
  return value.toLowerCase().replaceAll(/["()\s]/gu, "");
}

function groupColumns(
  rows: readonly ColumnRow[],
  tableName: string,
): ReadonlyMap<string, ColumnRow> {
  return new Map(
    rows
      .filter((row) => row.table_name === tableName)
      .map((row) => [row.column_name, row]),
  );
}

function findConstraint(
  state: DevCanaryMigrationState,
  tableName: string,
  constraintName: string,
): ConstraintRow | undefined {
  return state.constraints.find(
    (row) => row.table_name === tableName && row.conname === constraintName,
  );
}

function findIndex(
  state: DevCanaryMigrationState,
  tableName: string,
  indexName: string,
): IndexRow | undefined {
  return state.indexes.find(
    (row) => row.table_name === tableName && row.index_name === indexName,
  );
}

export async function loadDevCanaryMigrationDescriptors(
  migrationsFolder = path.resolve("migrations"),
): Promise<readonly MigrationDescriptor[]> {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    readonly entries?: readonly JournalEntry[];
  };
  if (!Array.isArray(journal.entries)) {
    throw new Error(`Invalid Drizzle journal: ${journalPath}`);
  }

  const tags = journal.entries.map((entry) => entry.tag);
  if (new Set(tags).size !== tags.length) {
    throw new Error("Drizzle journal contains duplicate migration tags");
  }
  const firstTargetIndex = journal.entries.findIndex(
    (entry) => entry.tag === PINNED_DEV_CANARY_MIGRATIONS[0].tag,
  );
  if (firstTargetIndex < 0) {
    throw new Error(
      `Drizzle journal is missing ${PINNED_DEV_CANARY_MIGRATIONS[0].tag}`,
    );
  }
  const targetEra = journal.entries.slice(firstTargetIndex);
  if (targetEra.length !== PINNED_DEV_CANARY_MIGRATIONS.length) {
    throw new Error(
      "Drizzle journal has missing, unknown, or newer entries after migration 0009",
    );
  }

  const descriptors: MigrationDescriptor[] = [];
  let priorCreatedAt = -1;
  for (let index = 0; index < PINNED_DEV_CANARY_MIGRATIONS.length; index += 1) {
    const pinned = PINNED_DEV_CANARY_MIGRATIONS[index];
    const entry = targetEra[index];
    if (
      pinned === undefined ||
      entry === undefined ||
      entry.tag !== pinned.tag ||
      !Number.isSafeInteger(entry.when) ||
      entry.when !== pinned.createdAt
    ) {
      throw new Error(
        `Drizzle journal does not match the pinned 0009-0012 sequence at ${pinned?.tag ?? index}`,
      );
    }
    if (entry.when <= priorCreatedAt) {
      throw new Error(`Drizzle journal order is invalid at ${pinned.tag}`);
    }
    const sql = await readFile(
      path.join(migrationsFolder, `${pinned.tag}.sql`),
      "utf8",
    );
    const hash = createHash("sha256").update(sql).digest("hex");
    if (hash !== pinned.hash) {
      throw new Error(`Pinned migration hash mismatch for ${pinned.tag}`);
    }
    descriptors.push({
      tag: pinned.tag,
      createdAt: entry.when,
      hash,
      sql,
    });
    priorCreatedAt = entry.when;
  }
  return descriptors;
}

async function inspectState(
  client: Client,
  databaseUrl: string,
): Promise<DevCanaryMigrationState> {
  const parsedUrl = new URL(databaseUrl);
  const identity = await client.query<IdentityRow>(`
    SELECT
      current_database() AS database_name,
      current_user AS role_name,
      current_setting('server_version_num') AS server_version_num,
      pg_is_in_recovery() AS is_replica
  `);
  const relations = await client.query<RelationRow>(`
    SELECT
      c.relname,
      c.reltuples::bigint::text AS estimated_rows,
      pg_relation_size(c.oid)::bigint::text AS heap_bytes,
      pg_indexes_size(c.oid)::bigint::text AS index_bytes,
      pg_total_relation_size(c.oid)::bigint::text AS total_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY(ARRAY[
        'addresses',
        'companies',
        'geometries',
        'geometry_rings',
        'illinois_sos_component_records',
        'properties',
        'property_improvements',
        'bbb_artifact_watermarks',
        'bbb_harvest_categories',
        'bbb_harvest_runs',
        'bbb_profile_category_memberships',
        'bbb_profile_snapshots',
        'bbb_property_link_evidence',
        'bbb_reconciliation_matches',
        'bbb_reconciliation_runs'
      ])
    ORDER BY c.relname
  `);
  const columns = await client.query<ColumnRow>(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[
        'addresses',
        'geometries',
        'geometry_rings',
        'illinois_sos_component_records'
      ])
    ORDER BY table_name, ordinal_position
  `);
  const constraints = await client.query<ConstraintRow>(`
    SELECT
      relation.relname AS table_name,
      constraint_row.conname,
      constraint_row.contype,
      constraint_row.convalidated,
      pg_get_constraintdef(constraint_row.oid, true) AS definition
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = ANY(ARRAY[
        'addresses',
        'geometry_rings',
        'illinois_sos_component_records',
        'bbb_artifact_watermarks',
        'bbb_harvest_categories',
        'bbb_harvest_runs',
        'bbb_profile_category_memberships',
        'bbb_profile_snapshots',
        'bbb_property_link_evidence',
        'bbb_reconciliation_matches',
        'bbb_reconciliation_runs'
      ])
    ORDER BY relation.relname, constraint_row.conname
  `);
  const indexes = await client.query<IndexRow>(`
    SELECT
      table_row.relname AS table_name,
      index_row.relname AS index_name,
      index_meta.indisvalid AS is_valid,
      index_meta.indisready AS is_ready,
      index_meta.indisunique AS is_unique,
      access_method.amname AS access_method,
      ARRAY(
        SELECT pg_get_indexdef(index_meta.indexrelid, key_number, true)
        FROM generate_series(1, index_meta.indnkeyatts) AS key_number
      ) AS keys,
      pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
    FROM pg_index index_meta
    JOIN pg_class index_row ON index_row.oid = index_meta.indexrelid
    JOIN pg_class table_row ON table_row.oid = index_meta.indrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_row.relam
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname = ANY(ARRAY[
        'addresses',
        'geometry_rings',
        'illinois_sos_component_records',
        'bbb_artifact_watermarks',
        'bbb_harvest_categories',
        'bbb_harvest_runs',
        'bbb_profile_category_memberships',
        'bbb_profile_snapshots',
        'bbb_property_link_evidence',
        'bbb_reconciliation_matches',
        'bbb_reconciliation_runs'
      ])
    ORDER BY table_row.relname, index_row.relname
  `);
  const ledgerTable = await client.query<{
    readonly table_name: string | null;
  }>(`SELECT to_regclass($1)::text AS table_name`, [
    `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE}`,
  ]);
  const ledgerTablePresent =
    typeof ledgerTable.rows[0]?.table_name === "string";
  const ledgerRows = !ledgerTablePresent
    ? []
    : (
        await client.query<LedgerRow>(`
            SELECT hash, created_at::text
            FROM "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}"
            ORDER BY created_at, id
          `)
      ).rows;
  const permissions = await client.query<PermissionRow>(`
    WITH role_flags AS (
      SELECT rolsuper
      FROM pg_roles
      WHERE rolname = current_user
    ),
    owners AS (
      SELECT
        bool_or(
          relation.relname = 'addresses'
          AND (
            pg_get_userbyid(relation.relowner) = current_user
            OR pg_has_role(current_user, pg_get_userbyid(relation.relowner), 'MEMBER')
            OR role_flags.rolsuper
          )
        ) AS can_alter_addresses
      FROM pg_class relation
      JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      CROSS JOIN role_flags
      WHERE namespace_row.nspname = 'public'
        AND relation.relname = 'addresses'
    )
    SELECT
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
      owners.can_alter_addresses,
      COALESCE(
        has_table_privilege(
          current_user,
          to_regclass('public.geometries'),
          'REFERENCES'
        ),
        false
      ) AS can_reference_geometries,
      COALESCE(
        has_table_privilege(
          current_user,
          to_regclass('public.companies'),
          'REFERENCES'
        ),
        false
      ) AS can_reference_companies,
      COALESCE(
        has_table_privilege(
          current_user,
          to_regclass('public.properties'),
          'REFERENCES'
        ),
        false
      ) AS can_reference_properties,
      COALESCE(
        has_table_privilege(
          current_user,
          to_regclass('public.property_improvements'),
          'REFERENCES'
        ),
        false
      ) AS can_reference_property_improvements
    FROM owners
  `);
  const activity = await client.query<ActivityRow>(`
    SELECT
      count(*) FILTER (WHERE state = 'active')::int AS active_sessions,
      count(*) FILTER (WHERE xact_start IS NOT NULL)::int AS open_transactions,
      count(*) FILTER (
        WHERE state = 'active' AND wait_event IS NOT NULL
      )::int AS waiting_sessions,
      (
        SELECT count(DISTINCT lock_row.pid)::int
        FROM pg_locks lock_row
        JOIN pg_class relation ON relation.oid = lock_row.relation
        JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND relation.relname IN (
            'addresses',
            'companies',
            'geometries',
            'properties',
            'property_improvements'
          )
          AND lock_row.pid <> pg_backend_pid()
          AND lock_row.granted
          AND lock_row.mode IN (
            'RowExclusiveLock',
            'ShareRowExclusiveLock',
            'ExclusiveLock',
            'AccessExclusiveLock'
          )
      ) AS target_write_locks
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND backend_type = 'client backend'
  `);
  const identityRow = identity.rows[0];
  const permissionRow = permissions.rows[0];
  const activityRow = activity.rows[0];
  if (
    identityRow === undefined ||
    permissionRow === undefined ||
    activityRow === undefined
  ) {
    throw new Error("Could not inspect database metadata");
  }

  return {
    endpointFingerprint: fingerprint(parsedUrl.hostname),
    databaseFingerprint: fingerprint(identityRow.database_name),
    roleFingerprint: fingerprint(identityRow.role_name),
    directConnection: !parsedUrl.hostname.includes("-pooler."),
    serverVersionNum: identityRow.server_version_num,
    isReplica: identityRow.is_replica,
    relations: new Map(relations.rows.map((row) => [row.relname, row])),
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    ledgerTablePresent,
    ledgerRows,
    permissions: permissionRow,
    activity: activityRow,
  };
}

function validateCreatedTable(
  state: DevCanaryMigrationState,
  tableName: keyof typeof REQUIRED_COLUMNS,
): readonly string[] {
  const issues: string[] = [];
  const columns = groupColumns(state.columns, tableName);
  for (const [columnName, [expectedType, expectedNullable]] of REQUIRED_COLUMNS[
    tableName
  ]) {
    const actual = columns.get(columnName);
    if (actual === undefined) {
      issues.push(`${tableName}.${columnName} is missing`);
    } else if (
      actual.data_type !== expectedType ||
      actual.is_nullable !== expectedNullable
    ) {
      issues.push(
        `${tableName}.${columnName} has ${actual.data_type}/${actual.is_nullable}; expected ${expectedType}/${expectedNullable}`,
      );
    }
  }
  for (const constraintName of REQUIRED_CONSTRAINTS[tableName]) {
    const constraint = findConstraint(state, tableName, constraintName);
    if (constraint === undefined) {
      issues.push(`${constraintName} is missing`);
    } else if (!constraint.convalidated) {
      issues.push(`${constraintName} is not validated`);
    }
  }
  for (const indexName of REQUIRED_INDEXES[tableName]) {
    const index = findIndex(state, tableName, indexName);
    if (index === undefined) {
      issues.push(`${indexName} is missing`);
    } else if (!index.is_valid || !index.is_ready) {
      issues.push(`${indexName} is invalid or not ready`);
    }
  }
  return issues;
}

function privateBbbTablePresence(
  state: DevCanaryMigrationState,
): readonly boolean[] {
  return BBB_PRIVATE_TABLES.map((tableName) => state.relations.has(tableName));
}

function validatePrivateBbbSchema(
  state: DevCanaryMigrationState,
): readonly string[] {
  const issues: string[] = [];
  const targetTables = new Set<string>(BBB_PRIVATE_TABLES);
  const expectedIndexNames = new Set<string>([
    ...BBB_PRIVATE_PRIMARY_KEYS,
    ...BBB_PRIVATE_INDEXES,
  ]);

  for (const primaryKeyName of BBB_PRIVATE_PRIMARY_KEYS) {
    const constraint = state.constraints.find(
      (candidate) => candidate.conname === primaryKeyName,
    );
    if (constraint === undefined || constraint.contype !== "p") {
      issues.push(`${primaryKeyName} is missing or is not a primary key`);
    } else if (!constraint.convalidated) {
      issues.push(`${primaryKeyName} is not validated`);
    }
  }

  const foreignKeys = state.constraints.filter(
    (constraint) =>
      targetTables.has(constraint.table_name) && constraint.contype === "f",
  );
  for (const foreignKeyName of BBB_PRIVATE_FOREIGN_KEYS) {
    const constraint = foreignKeys.find(
      (candidate) => candidate.conname === foreignKeyName,
    );
    if (constraint === undefined) {
      issues.push(`${foreignKeyName} is missing`);
    } else if (!constraint.convalidated) {
      issues.push(`${foreignKeyName} is not validated`);
    } else if (!/\bon delete restrict\b/iu.test(constraint.definition)) {
      issues.push(`${foreignKeyName} does not use ON DELETE RESTRICT`);
    }
  }
  for (const foreignKey of foreignKeys) {
    if (
      !BBB_PRIVATE_FOREIGN_KEYS.includes(
        foreignKey.conname as (typeof BBB_PRIVATE_FOREIGN_KEYS)[number],
      )
    ) {
      issues.push(`unexpected private BBB foreign key ${foreignKey.conname}`);
    }
  }

  const indexes = state.indexes.filter((index) =>
    targetTables.has(index.table_name),
  );
  for (const indexName of expectedIndexNames) {
    const index = indexes.find(
      (candidate) => candidate.index_name === indexName,
    );
    if (index === undefined) {
      issues.push(`${indexName} is missing`);
    } else if (!index.is_valid || !index.is_ready) {
      issues.push(`${indexName} is invalid or not ready`);
    }
  }
  for (const index of indexes) {
    if (!expectedIndexNames.has(index.index_name)) {
      issues.push(`unexpected private BBB index ${index.index_name}`);
    }
  }

  return issues;
}

function analyzeState(
  state: DevCanaryMigrationState,
  descriptors: readonly MigrationDescriptor[],
): {
  readonly blockers: readonly string[];
  readonly pendingActions: readonly string[];
  readonly completedChecks: readonly string[];
} {
  const blockers: string[] = [];
  const pendingActions: string[] = [];
  const completedChecks: string[] = [];

  if (!state.directConnection) {
    blockers.push("a direct/unpooled database connection is required");
  } else {
    completedChecks.push("database connection is direct/unpooled");
  }
  if (state.isReplica) {
    blockers.push("migration target is a read replica");
  }
  if (!state.permissions.can_create_public) {
    blockers.push("database role cannot create objects in public");
  }
  if (!state.permissions.can_alter_addresses) {
    blockers.push("database role does not own public.addresses");
  }
  if (!state.permissions.can_reference_geometries) {
    blockers.push("database role lacks REFERENCES on public.geometries");
  }
  if (!state.permissions.can_reference_companies) {
    blockers.push("database role lacks REFERENCES on public.companies");
  }
  if (!state.permissions.can_reference_properties) {
    blockers.push("database role lacks REFERENCES on public.properties");
  }
  if (!state.permissions.can_reference_property_improvements) {
    blockers.push(
      "database role lacks REFERENCES on public.property_improvements",
    );
  }
  if (!state.ledgerTablePresent && !state.permissions.can_create_schema) {
    blockers.push("database role cannot create the Drizzle schema");
  }
  if (state.activity.target_write_locks > 0) {
    blockers.push("addresses or geometries currently has a granted write lock");
  }

  if (!state.relations.has("addresses")) {
    blockers.push("public.addresses is missing");
  }
  if (!state.relations.has("geometries")) {
    blockers.push("public.geometries is missing");
  }
  for (const parentTable of [
    "companies",
    "properties",
    "property_improvements",
  ]) {
    if (!state.relations.has(parentTable)) {
      blockers.push(`public.${parentTable} is missing`);
    }
  }
  const geometryColumns = groupColumns(state.columns, "geometries");
  const geometryId = geometryColumns.get("geometry_id");
  if (
    state.relations.has("geometries") &&
    (geometryId === undefined || geometryId.data_type !== "uuid")
  ) {
    blockers.push("public.geometries.geometry_id uuid prerequisite is missing");
  }

  const targetTablePresence = [
    state.relations.has("geometry_rings"),
    state.relations.has("illinois_sos_component_records"),
  ];
  if (targetTablePresence.every((present) => !present)) {
    pendingActions.push("apply migration 0009 target tables");
  } else if (targetTablePresence.some((present) => !present)) {
    blockers.push(
      "migration 0009 is partially present; manual review is required",
    );
  } else {
    const tableIssues = [
      ...validateCreatedTable(state, "geometry_rings"),
      ...validateCreatedTable(state, "illinois_sos_component_records"),
    ];
    if (tableIssues.length === 0) {
      completedChecks.push("migration 0009 target tables match");
    } else {
      blockers.push(...tableIssues);
    }
  }

  const addressColumns = groupColumns(state.columns, "addresses");
  const elephantUuid = addressColumns.get("elephant_uuid");
  const elephantToken = addressColumns.get("elephant_token");
  if (elephantUuid === undefined && elephantToken === undefined) {
    pendingActions.push("add nullable address identity columns");
  } else if (elephantUuid === undefined || elephantToken === undefined) {
    blockers.push("address identity columns are partially present");
  } else if (
    elephantUuid.data_type !== "uuid" ||
    elephantUuid.is_nullable !== "YES" ||
    elephantToken.data_type !== "text" ||
    elephantToken.is_nullable !== "YES"
  ) {
    blockers.push("address identity columns do not match migration 0010");
  } else {
    completedChecks.push("migration 0010 address identity columns match");
  }

  for (const [indexName, columnName] of TARGET_INDEX_COLUMNS) {
    const index = findIndex(state, "addresses", indexName);
    if (index === undefined) {
      pendingActions.push(`build ${indexName} concurrently`);
      continue;
    }
    const exact =
      index.is_valid &&
      index.is_ready &&
      !index.is_unique &&
      index.access_method === "btree" &&
      index.keys.length === 1 &&
      index.keys[0] === columnName &&
      index.predicate === null;
    if (!exact) {
      blockers.push(
        `${indexName} exists but is invalid, not ready, or has the wrong definition`,
      );
    } else {
      completedChecks.push(`${indexName} matches`);
    }
  }

  const pairConstraint = findConstraint(
    state,
    "addresses",
    ADDRESS_PAIR_CONSTRAINT,
  );
  if (pairConstraint === undefined) {
    pendingActions.push(`add and validate ${ADDRESS_PAIR_CONSTRAINT}`);
  } else {
    const normalized = normalizeCheckDefinition(pairConstraint.definition);
    if (
      pairConstraint.contype !== "c" ||
      normalized !== "checkelephant_uuidisnull=elephant_tokenisnull"
    ) {
      blockers.push(`${ADDRESS_PAIR_CONSTRAINT} has the wrong definition`);
    } else if (!pairConstraint.convalidated) {
      pendingActions.push(`validate ${ADDRESS_PAIR_CONSTRAINT}`);
    } else {
      completedChecks.push(
        `${ADDRESS_PAIR_CONSTRAINT} matches and is validated`,
      );
    }
  }

  const bbbPresence = privateBbbTablePresence(state);
  if (bbbPresence.every((present) => !present)) {
    pendingActions.push("apply migration 0012 private BBB tables");
  } else if (bbbPresence.some((present) => !present)) {
    blockers.push(
      "migration 0012 is partially present; manual review is required",
    );
  } else {
    const bbbIssues = validatePrivateBbbSchema(state);
    if (bbbIssues.length === 0) {
      completedChecks.push(
        "migration 0012 has eight tables, thirteen restrictive foreign keys, and thirty indexes",
      );
    } else {
      blockers.push(...bbbIssues);
    }
  }

  const ledgerRowsByCreatedAt = new Map<number, LedgerRow[]>();
  for (const row of state.ledgerRows) {
    if (
      row.created_at === null ||
      !Number.isSafeInteger(Number(row.created_at))
    ) {
      blockers.push("Drizzle ledger contains a missing or invalid created_at");
      continue;
    }
    const createdAt = Number(row.created_at);
    const rows = ledgerRowsByCreatedAt.get(createdAt) ?? [];
    rows.push(row);
    ledgerRowsByCreatedAt.set(createdAt, rows);
  }
  const recordedTargetIndexes: number[] = [];
  for (const descriptor of descriptors) {
    const rows = ledgerRowsByCreatedAt.get(descriptor.createdAt) ?? [];
    if (rows.length === 0) {
      pendingActions.push(`record ${descriptor.tag} in the Drizzle ledger`);
    } else if (rows.length !== 1) {
      blockers.push(`Drizzle ledger has duplicate rows for ${descriptor.tag}`);
    } else if (rows[0]?.hash !== descriptor.hash) {
      blockers.push(`Drizzle ledger hash mismatch for ${descriptor.tag}`);
    } else {
      recordedTargetIndexes.push(
        descriptors.findIndex(
          (candidate) => candidate.createdAt === descriptor.createdAt,
        ),
      );
      completedChecks.push(`Drizzle ledger records ${descriptor.tag}`);
    }
  }
  const firstTarget = descriptors[0]?.createdAt;
  if (firstTarget !== undefined) {
    for (const [createdAt] of ledgerRowsByCreatedAt) {
      if (
        createdAt >= firstTarget &&
        !descriptors.some((descriptor) => descriptor.createdAt === createdAt)
      ) {
        blockers.push(
          `Drizzle ledger contains an unknown or newer migration at ${createdAt}`,
        );
      }
    }
  }
  const sortedRecordedIndexes = [...recordedTargetIndexes].sort(
    (left, right) => left - right,
  );
  if (
    sortedRecordedIndexes.some(
      (targetIndex, sequenceIndex) => targetIndex !== sequenceIndex,
    )
  ) {
    blockers.push(
      "Drizzle ledger is missing a predecessor in the recorded 0009-0012 sequence",
    );
  }

  return { blockers, pendingActions, completedChecks };
}

function createReport(
  mode: "plan" | "apply" | "verify",
  environment: string,
  state: DevCanaryMigrationState,
  descriptors: readonly MigrationDescriptor[],
  authorizationEvidence: DevCanaryMigrationReport["authorizationEvidence"] = null,
): DevCanaryMigrationReport {
  const analysis = analyzeState(state, descriptors);
  const address = state.relations.get("addresses");
  const ledgerHashes = new Set(
    state.ledgerRows.map((row) => `${row.created_at}:${row.hash}`),
  );
  const privateBbbRelations = BBB_PRIVATE_TABLES.map((tableName) =>
    state.relations.get(tableName),
  ).filter((relation): relation is RelationRow => relation !== undefined);
  const privateBbbExistingRows = privateBbbRelations.reduce(
    (total, relation) => {
      const estimate = BigInt(relation.estimated_rows);
      return total + (estimate > 0n ? estimate : 0n);
    },
    0n,
  );
  return {
    schemaVersion: "query-db.dev-canary-migration.v1",
    mode,
    environment: {
      name: environment,
      endpointFingerprint: state.endpointFingerprint,
      databaseFingerprint: state.databaseFingerprint,
      roleFingerprint: state.roleFingerprint,
      directConnection: state.directConnection,
      serverVersionNum: state.serverVersionNum,
      isReplica: state.isReplica,
    },
    risk: {
      estimatedAddressRows: address?.estimated_rows ?? "0",
      addressHeapBytes: address?.heap_bytes ?? "0",
      addressIndexBytes: address?.index_bytes ?? "0",
      addressTotalBytes: address?.total_bytes ?? "0",
      activeSessions: state.activity.active_sessions,
      openTransactions: state.activity.open_transactions,
      waitingSessions: state.activity.waiting_sessions,
      targetWriteLocks: state.activity.target_write_locks,
      operations: [
        "brief ACCESS EXCLUSIVE lock to add nullable columns",
        "two concurrent full-table index scans",
        "brief ACCESS EXCLUSIVE lock to add a NOT VALID check",
        "online validation scan under SHARE UPDATE EXCLUSIVE",
        "additive 0009 table creation",
        "atomic 0012 creation of eight empty tables and thirty empty-table indexes before thirteen restrictive foreign keys",
        "four pinned Drizzle ledger rows recorded only after final verification",
      ],
      migration0012: {
        targetTablesPresent: privateBbbRelations.length,
        expectedTables: 8,
        expectedForeignKeys: 13,
        expectedIndexes: 30,
        existingRows: privateBbbExistingRows.toString(),
        referencedRelations: [
          "companies",
          "properties",
          "property_improvements",
        ].map((tableName) => {
          const relation = state.relations.get(tableName);
          return {
            tableName,
            estimatedRows: relation?.estimated_rows ?? "0",
            totalBytes: relation?.total_bytes ?? "0",
          };
        }),
      },
    },
    targetMigrations: descriptors.map((descriptor) => ({
      tag: descriptor.tag,
      createdAt: descriptor.createdAt,
      hash: descriptor.hash,
      recorded: ledgerHashes.has(`${descriptor.createdAt}:${descriptor.hash}`),
    })),
    blockers: analysis.blockers,
    pendingActions: analysis.pendingActions,
    completedChecks: analysis.completedChecks,
    authorizationEvidence,
    ready: analysis.blockers.length === 0,
  };
}

async function inTransaction(
  client: Client,
  operation: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path = public, pg_catalog");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await operation();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function applyMigration0009(
  client: Client,
  descriptor: MigrationDescriptor,
): Promise<void> {
  const statements = descriptor.sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await inTransaction(client, async () => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

async function applyMigration0012(
  client: Client,
  descriptor: MigrationDescriptor,
): Promise<void> {
  const statements = descriptor.sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const createTables: string[] = [];
  const createIndexes: string[] = [];
  const addForeignKeys: string[] = [];
  for (const statement of statements) {
    if (/^CREATE TABLE\b/iu.test(statement)) {
      createTables.push(statement);
    } else if (/^CREATE (?:UNIQUE )?INDEX\b/iu.test(statement)) {
      createIndexes.push(statement);
    } else if (
      /^ALTER TABLE\b/iu.test(statement) &&
      /\bFOREIGN KEY\b/iu.test(statement)
    ) {
      addForeignKeys.push(statement);
    } else {
      throw new Error(
        "Migration 0012 contains an unsupported statement; review the pinned migration contract",
      );
    }
  }
  if (
    createTables.length !== BBB_PRIVATE_TABLES.length ||
    createIndexes.length !== BBB_PRIVATE_INDEXES.length ||
    addForeignKeys.length !== BBB_PRIVATE_FOREIGN_KEYS.length
  ) {
    throw new Error(
      "Migration 0012 statement counts do not match the pinned 8-table/13-FK/30-index contract",
    );
  }

  await inTransaction(client, async () => {
    // Build indexes while every target table is still empty. Add foreign keys
    // last so locks on the existing parent tables are held only until commit.
    for (const statement of [
      ...createTables,
      ...createIndexes,
      ...addForeignKeys,
    ]) {
      await client.query(statement);
    }
  });
}

async function addAddressIdentityColumns(client: Client): Promise<void> {
  await inTransaction(client, async () => {
    await client.query(`
      ALTER TABLE public.addresses
        ADD COLUMN elephant_uuid uuid,
        ADD COLUMN elephant_token text
    `);
  });
}

async function createAddressIdentityIndex(
  client: Client,
  indexName: string,
  columnName: string,
): Promise<void> {
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = 0");
  try {
    await client.query(
      `CREATE INDEX CONCURRENTLY "${indexName}" ON public.addresses USING btree ("${columnName}")`,
    );
  } catch (error) {
    throw new Error(
      `${indexName} concurrent build failed. Inspect pg_index; if it is invalid, obtain owner approval to DROP INDEX CONCURRENTLY and rerun. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function addOrValidatePairConstraint(
  client: Client,
  existing: ConstraintRow | undefined,
): Promise<void> {
  if (existing === undefined) {
    await inTransaction(client, async () => {
      await client.query(`
        ALTER TABLE public.addresses
          ADD CONSTRAINT "${ADDRESS_PAIR_CONSTRAINT}"
          CHECK ((elephant_uuid IS NULL) = (elephant_token IS NULL))
          NOT VALID
      `);
    });
  }
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = 0");
  await client.query(
    `ALTER TABLE public.addresses VALIDATE CONSTRAINT "${ADDRESS_PAIR_CONSTRAINT}"`,
  );
}

async function recordMigrationLedger(
  client: Client,
  descriptors: readonly MigrationDescriptor[],
): Promise<void> {
  await inTransaction(client, async () => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${DRIZZLE_SCHEMA}"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    for (const descriptor of descriptors) {
      const existing = await client.query<LedgerRow>(
        `
          SELECT hash, created_at::text
          FROM "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}"
          WHERE created_at = $1
        `,
        [descriptor.createdAt],
      );
      if (existing.rows.length === 0) {
        await client.query(
          `
            INSERT INTO "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (hash, created_at)
            VALUES ($1, $2)
          `,
          [descriptor.hash, descriptor.createdAt],
        );
      } else if (
        existing.rows.length !== 1 ||
        existing.rows[0]?.hash !== descriptor.hash
      ) {
        throw new Error(`Drizzle ledger conflict for ${descriptor.tag}`);
      }
    }
  });
}

async function loadWriterPauseProof(
  proofPath: string,
): Promise<VerifiedWriterPauseProof> {
  const body = await readFile(path.resolve(proofPath), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Writer-pause proof is not valid JSON: ${message}`);
  }
  return {
    proof: writerPauseProofSchema.parse(parsed),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function assertFreshTimestamp(
  value: string | undefined,
  label: string,
  maximumAgeMs: number,
  now: number,
): number {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  if (timestamp > now + CLOCK_SKEW_MS) {
    throw new Error(`${label} cannot be in the future`);
  }
  if (now - timestamp > maximumAgeMs) {
    throw new Error(`${label} is stale`);
  }
  return timestamp;
}

function assertApplyAuthorization(
  options: DevCanaryMigrationOptions,
  state: DevCanaryMigrationState,
  writerPause: VerifiedWriterPauseProof,
): void {
  if (options.environment !== "DEV") {
    throw new Error("--environment must be exactly DEV");
  }
  if (!state.directConnection) {
    throw new Error("Apply requires a direct/unpooled database connection");
  }
  if (state.isReplica) {
    throw new Error("Apply cannot run against a read replica");
  }
  if (
    options.expectedEndpointFingerprint === undefined ||
    options.expectedEndpointFingerprint !== state.endpointFingerprint
  ) {
    throw new Error(
      "--expected-endpoint-fingerprint must match the reviewed plan",
    );
  }
  const approvalRefs = (options.approvalRefs ?? []).map((value) =>
    value.trim(),
  );
  if (
    approvalRefs.length === 0 ||
    approvalRefs.some((value) => value.length < 3) ||
    new Set(approvalRefs).size !== approvalRefs.length
  ) {
    throw new Error("at least one unique, concrete --approval-ref is required");
  }
  if (options.backupRef === undefined || options.backupRef.trim().length < 3) {
    throw new Error("--backup-ref is required");
  }
  const now = Date.now();
  assertFreshTimestamp(
    options.backupCreatedAt,
    "--backup-created-at",
    BACKUP_MAX_AGE_MS,
    now,
  );
  assertFreshTimestamp(
    writerPause.proof.observedAt,
    "writer-pause proof observedAt",
    WRITER_PAUSE_MAX_AGE_MS,
    now,
  );
  if (
    writerPause.proof.environment !== "DEV" ||
    writerPause.proof.endpointFingerprint !== state.endpointFingerprint
  ) {
    throw new Error(
      "writer-pause proof must match the DEV endpoint fingerprint",
    );
  }
  if (
    writerPause.proof.writers.some(
      (writer) =>
        writer.pauseCommand.trim().length === 0 ||
        writer.resumeCommand.trim().length === 0 ||
        writer.proofRef.trim().length < 3 ||
        writer.paused !== true,
    )
  ) {
    throw new Error(
      "writer-pause proof must include concrete pause/resume commands and pause evidence for every writer",
    );
  }
  if (state.activity.target_write_locks > 0) {
    throw new Error("target tables still have a granted write lock");
  }
  if (!state.permissions.can_create_public) {
    throw new Error("database role cannot create objects in public");
  }
  if (!state.permissions.can_alter_addresses) {
    throw new Error("database role does not own public.addresses");
  }
  if (!state.permissions.can_reference_geometries) {
    throw new Error("database role lacks REFERENCES on public.geometries");
  }
  if (!state.permissions.can_reference_companies) {
    throw new Error("database role lacks REFERENCES on public.companies");
  }
  if (!state.permissions.can_reference_properties) {
    throw new Error("database role lacks REFERENCES on public.properties");
  }
  if (!state.permissions.can_reference_property_improvements) {
    throw new Error(
      "database role lacks REFERENCES on public.property_improvements",
    );
  }
  if (!state.ledgerTablePresent && !state.permissions.can_create_schema) {
    throw new Error("database role cannot create the Drizzle schema if needed");
  }
}

export async function runDevCanarySchemaMigration(
  databaseUrl: string,
  options: DevCanaryMigrationOptions,
): Promise<DevCanaryMigrationReport> {
  if (options.environment !== "DEV") {
    throw new Error("--environment must be exactly DEV");
  }
  const descriptors = await loadDevCanaryMigrationDescriptors(
    options.migrationsFolder,
  );
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "query-db-dev-canary-schema-migration",
  });
  await client.connect();
  let advisoryLockHeld = false;
  try {
    if (options.mode === "plan" || options.mode === "verify") {
      await client.query("BEGIN READ ONLY");
      try {
        await client.query("SET LOCAL statement_timeout = '15s'");
        const state = await inspectState(client, databaseUrl);
        await client.query("COMMIT");
        if (
          options.mode === "verify" &&
          (options.expectedEndpointFingerprint === undefined ||
            options.expectedEndpointFingerprint !== state.endpointFingerprint)
        ) {
          throw new Error(
            "--expected-endpoint-fingerprint must match the reviewed plan",
          );
        }
        const report = createReport(
          options.mode,
          options.environment,
          state,
          descriptors,
        );
        if (
          options.mode === "verify" &&
          (report.blockers.length > 0 || report.pendingActions.length > 0)
        ) {
          throw new Error(
            `Verification failed: ${[
              ...report.blockers,
              ...report.pendingActions,
            ].join("; ")}`,
          );
        }
        return report;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    const lock = await client.query<{ readonly acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [ADVISORY_LOCK_NAME],
    );
    advisoryLockHeld = lock.rows[0]?.acquired === true;
    if (!advisoryLockHeld) {
      throw new Error("another 0009-0012 migration session holds the lock");
    }

    let state = await inspectState(client, databaseUrl);
    if (options.writerPauseProofPath === undefined) {
      throw new Error("--writer-pause-proof is required");
    }
    const writerPauseProof = await loadWriterPauseProof(
      options.writerPauseProofPath,
    );
    assertApplyAuthorization(options, state, writerPauseProof);
    const initial = analyzeState(state, descriptors);
    if (initial.blockers.length > 0) {
      throw new Error(
        `Migration preflight blocked: ${initial.blockers.join("; ")}`,
      );
    }

    if (
      !state.relations.has("geometry_rings") &&
      !state.relations.has("illinois_sos_component_records")
    ) {
      const migration0009 = descriptors.find(
        (descriptor) =>
          descriptor.tag === "0009_rock_island_geometry_illinois_sos",
      );
      if (migration0009 === undefined) {
        throw new Error("Migration 0009 descriptor is unavailable");
      }
      await applyMigration0009(client, migration0009);
      state = await inspectState(client, databaseUrl);
    }

    const addressColumns = groupColumns(state.columns, "addresses");
    if (
      !addressColumns.has("elephant_uuid") &&
      !addressColumns.has("elephant_token")
    ) {
      await addAddressIdentityColumns(client);
      state = await inspectState(client, databaseUrl);
    }

    for (const [indexName, columnName] of TARGET_INDEX_COLUMNS) {
      if (findIndex(state, "addresses", indexName) === undefined) {
        await createAddressIdentityIndex(client, indexName, columnName);
        state = await inspectState(client, databaseUrl);
      }
    }

    const existingConstraint = findConstraint(
      state,
      "addresses",
      ADDRESS_PAIR_CONSTRAINT,
    );
    if (existingConstraint === undefined || !existingConstraint.convalidated) {
      await addOrValidatePairConstraint(client, existingConstraint);
      state = await inspectState(client, databaseUrl);
    }

    const bbbPresence = privateBbbTablePresence(state);
    if (bbbPresence.every((present) => !present)) {
      const migration0012 = descriptors.find(
        (descriptor) => descriptor.tag === "0012_private_bbb_persistence",
      );
      if (migration0012 === undefined) {
        throw new Error("Migration 0012 descriptor is unavailable");
      }
      await applyMigration0012(client, migration0012);
      state = await inspectState(client, databaseUrl);
    }

    const beforeLedger = analyzeState(state, descriptors);
    const nonLedgerPending = beforeLedger.pendingActions.filter(
      (action) => !action.startsWith("record "),
    );
    if (beforeLedger.blockers.length > 0 || nonLedgerPending.length > 0) {
      throw new Error(
        `Post-DDL verification failed: ${[
          ...beforeLedger.blockers,
          ...nonLedgerPending,
        ].join("; ")}`,
      );
    }

    await recordMigrationLedger(client, descriptors);
    state = await inspectState(client, databaseUrl);
    const finalReport = createReport(
      options.mode,
      options.environment,
      state,
      descriptors,
      {
        approvalRefCount: options.approvalRefs?.length ?? 0,
        backupCreatedAt: options.backupCreatedAt ?? "",
        writerPauseProofSha256: writerPauseProof.sha256,
        writerCount: writerPauseProof.proof.writers.length,
      },
    );
    if (
      finalReport.blockers.length > 0 ||
      finalReport.pendingActions.length > 0
    ) {
      throw new Error(
        `Final verification failed: ${[
          ...finalReport.blockers,
          ...finalReport.pendingActions,
        ].join("; ")}`,
      );
    }
    return finalReport;
  } finally {
    if (advisoryLockHeld) {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          ADVISORY_LOCK_NAME,
        ])
        .catch(() => undefined);
    }
    await client.end();
  }
}
