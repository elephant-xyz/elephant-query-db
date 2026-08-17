import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool, type PoolClient } from "pg";

import {
  mapAppraisalGeometryRingRows,
  type JsonObject,
  type PreparedRow,
} from "../src/loader/index.js";

const SOURCE_SYSTEM = "rock_island_appraiser";
const EXPECTED_PARCELS = 65_806;
const EXPECTED_GEOMETRY_COMPONENTS = 66_516;
const EXPECTED_EXTERIOR_RINGS = 66_516;
const EXPECTED_INTERIOR_RINGS = 44;
const EXPECTED_RINGS = 66_560;
const ADVISORY_LOCK_KEY = "rock_island_geometry_rings_v1";

const APPRAISAL_TABLES = [
  "addresses",
  "companies",
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
  "properties",
  "property_improvements",
  "property_valuations",
  "sales_histories",
  "structures",
  "taxes",
  "unnormalized_addresses",
  "utilities",
] as const;

const PERMIT_TABLES = [
  "inspections",
  "permit_contacts",
  "permit_custom_fields",
  "permit_events",
  "permit_fees",
  "permit_links",
  "permit_list_windows",
  "property_improvements",
] as const;

const CORPORATE_TABLES = [
  "addresses",
  "business_registration_addresses",
  "business_registration_annual_reports",
  "business_registration_events",
  "business_registration_parties",
  "business_registrations",
  "companies",
  "people",
] as const;

type BackfillOptions = {
  readonly apply: boolean;
  readonly manifestPath: string;
  readonly runId: string;
};

type GeometryRow = {
  readonly geometry_id: string;
  readonly request_identifier: string;
  readonly source_artifact_uri: string | null;
  readonly source_payload: JsonObject;
  readonly source_record_key: string;
};

type GeometryRingInsert = {
  readonly coordinates: unknown;
  readonly geometry_id: string;
  readonly polygon_index: number;
  readonly request_identifier: string;
  readonly ring_index: number;
  readonly ring_role: string;
  readonly source_artifact_uri: string | null;
  readonly source_geometry_type: string;
  readonly source_payload: unknown;
  readonly source_record_hash: string | null;
  readonly source_record_key: string;
  readonly source_system: string;
};

type ExactInteriorRing = {
  readonly polygonIndex: number;
  readonly requestIdentifier: string;
  readonly ringIndex: number;
  readonly sourceRecordKey: string;
};

type CountRow = {
  readonly count: string;
};

type BooleanRow = {
  readonly acquired: boolean;
};

type DatabaseCounts = {
  readonly appraisal: Readonly<Record<string, number>>;
  readonly corporate: Readonly<Record<string, number>>;
  readonly permits: Readonly<Record<string, number>>;
};

type VerificationCounts = {
  readonly duplicateGeometrySourceKeys: number;
  readonly duplicateRingIndexes: number;
  readonly duplicateRingSourceKeys: number;
  readonly exteriorRings: number;
  readonly geometriesWithoutExteriorRing: number;
  readonly geometryComponents: number;
  readonly geometryOrphans: number;
  readonly interiorRings: number;
  readonly parcelCount: number;
  readonly ringOrphans: number;
  readonly rings: number;
};

/**
 * Parse a fail-closed Rock Island geometry-ring backfill command.
 *
 * @param argv - Arguments after the script filename.
 * @returns Explicit apply mode, durable manifest path, and checkpoint run ID.
 */
export function parseGeometryRingBackfillOptions(
  argv: readonly string[],
): BackfillOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      token?.startsWith("--") !== true ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid geometry-ring backfill option: ${token ?? ""}`);
    }
    values.set(token.slice(2), value);
    index += 1;
  }
  const manifestPath = values.get("manifest");
  const runId = values.get("run-id");
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("--manifest is required");
  }
  if (
    runId === undefined ||
    !/^[a-z][a-z0-9_]{0,31}$/u.test(runId)
  ) {
    throw new Error(
      "--run-id must contain 1-32 lowercase letters, digits, or underscores and start with a letter",
    );
  }
  for (const key of values.keys()) {
    if (key !== "manifest" && key !== "run-id") {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  return {
    apply,
    manifestPath: resolve(manifestPath),
    runId,
  };
}

/**
 * Build the source-scoped SQL that restores the exact pre-backfill ring slate.
 *
 * @param checkpointSchema - Validated checkpoint schema name.
 * @returns Transactional rollback SQL that does not touch another source.
 */
export function buildGeometryRingRollbackSql(
  checkpointSchema: string,
): string {
  const schema = quoteIdentifier(checkpointSchema);
  return [
    "BEGIN;",
    `DELETE FROM public.geometry_rings WHERE source_system = '${SOURCE_SYSTEM}';`,
    "INSERT INTO public.geometry_rings (",
    "  geometry_ring_id, geometry_id, request_identifier, source_geometry_type,",
    "  polygon_index, ring_index, ring_role, coordinates, source_payload,",
    "  source_system, source_record_key, source_record_hash, source_artifact_uri,",
    "  loaded_at, created_at, updated_at",
    ")",
    "SELECT",
    "  geometry_ring_id, geometry_id, request_identifier, source_geometry_type,",
    "  polygon_index, ring_index, ring_role, coordinates, source_payload,",
    "  source_system, source_record_key, source_record_hash, source_artifact_uri,",
    "  loaded_at, created_at, updated_at",
    `FROM ${schema}.geometry_rings_before;`,
    "COMMIT;",
    "",
  ].join("\n");
}

/**
 * Convert one existing geometry row into exact normalized ring inserts.
 *
 * @param geometry - Existing parent row with repaired source provenance.
 * @returns Ring records carrying exact source coordinates and parent identity.
 */
export function buildGeometryRingInserts(
  geometry: GeometryRow,
): readonly GeometryRingInsert[] {
  const fileName = `${geometry.source_record_key.split(":").at(-1) ?? ""}.json`;
  const rows = mapAppraisalGeometryRingRows({
    artifactUri: geometry.source_artifact_uri,
    fileName,
    geometrySourceRecordKey: geometry.source_record_key,
    record: geometry.source_payload,
    requestIdentifier: geometry.request_identifier,
    sourceSystem: SOURCE_SYSTEM,
  });
  return rows.map((row) => preparedRingToInsert(row, geometry));
}

/**
 * Prepare, checkpoint, optionally apply, and fully reconcile the Rock Island
 * geometry-ring backfill.
 *
 * @param options - Explicit mode and durable output locations.
 * @returns Privacy-safe manifest containing aggregate proof only.
 */
export async function backfillRockIslandGeometryRings(
  options: BackfillOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const checkpointSchema = `ri_geometry_rings_${options.runId}`;
  const pool = new Pool({
    application_name: "rock-island-geometry-ring-backfill",
    connectionString: databaseUrl,
    max: 2,
  });
  let lockAcquired = false;
  try {
    const lock = await pool.query<BooleanRow>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [ADVISORY_LOCK_KEY],
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new Error("Another Rock Island geometry-ring backfill holds the lock");
    }
    await assertGeometryRingTableExists(pool);
    const baselineCounts = await readProtectedCounts(pool);
    const beforeVerification = await readVerificationCounts(pool);
    const geometryResult = await pool.query<GeometryRow>(
      `SELECT geometry_id::text,
              request_identifier,
              source_artifact_uri,
              source_payload,
              source_record_key
         FROM public.geometries
        WHERE source_system = $1
        ORDER BY source_record_key`,
      [SOURCE_SYSTEM],
    );
    const rings = geometryResult.rows.flatMap(buildGeometryRingInserts);
    const derivedInteriorRingCount = rings.filter(
      (ring) => ring.ring_role === "interior",
    ).length;
    const distinctRingKeys = new Set(
      rings.map((ring) => ring.source_record_key),
    );
    const exactInteriorRings: readonly ExactInteriorRing[] = rings
      .filter((ring) => ring.ring_role === "interior")
      .map((ring) => ({
        polygonIndex: ring.polygon_index,
        requestIdentifier: ring.request_identifier,
        ringIndex: ring.ring_index,
        sourceRecordKey: ring.source_record_key,
      }))
      .sort((left, right) =>
        left.sourceRecordKey.localeCompare(right.sourceRecordKey),
      );
    if (
      geometryResult.rows.length !== EXPECTED_GEOMETRY_COMPONENTS ||
      rings.length !== EXPECTED_RINGS ||
      derivedInteriorRingCount !== EXPECTED_INTERIOR_RINGS ||
      distinctRingKeys.size !== rings.length
    ) {
      throw new Error(
        `Geometry proof failed before apply: components=${geometryResult.rows.length} rings=${rings.length} interior=${derivedInteriorRingCount} unique=${distinctRingKeys.size}`,
      );
    }

    let changedRows = 0;
    if (options.apply) {
      await createCheckpoint(
        pool,
        checkpointSchema,
        baselineCounts,
      );
      changedRows = await upsertRingBatches(pool, rings);
    }

    const afterCounts = await readProtectedCounts(pool);
    const afterVerification = await readVerificationCounts(pool);
    const countsUnchanged =
      JSON.stringify(baselineCounts) === JSON.stringify(afterCounts);
    const verified =
      afterVerification.parcelCount === EXPECTED_PARCELS &&
      afterVerification.geometryComponents === EXPECTED_GEOMETRY_COMPONENTS &&
      afterVerification.rings ===
        (options.apply ? EXPECTED_RINGS : beforeVerification.rings) &&
      (options.apply
        ? afterVerification.interiorRings === EXPECTED_INTERIOR_RINGS &&
          afterVerification.exteriorRings === EXPECTED_EXTERIOR_RINGS &&
          afterVerification.geometriesWithoutExteriorRing === 0
        : true) &&
      afterVerification.geometryOrphans === 0 &&
      afterVerification.ringOrphans === 0 &&
      afterVerification.duplicateGeometrySourceKeys === 0 &&
      afterVerification.duplicateRingSourceKeys === 0 &&
      afterVerification.duplicateRingIndexes === 0 &&
      countsUnchanged;
    const rollbackPath = `${options.manifestPath}.rollback.sql`;
    const exactSetPath = `${options.manifestPath}.interior-ring-set.json`;
    const exactSetBody = `${JSON.stringify(
      {
        schemaVersion: "rock-island-interior-ring-set-v1",
        sourceSystem: SOURCE_SYSTEM,
        count: exactInteriorRings.length,
        rings: exactInteriorRings,
      },
      null,
      2,
    )}\n`;
    const exactSetSha256 = createHash("sha256")
      .update(exactSetBody)
      .digest("hex");
    const manifest = {
      schemaVersion: "rock-island-geometry-rings-backfill-v1",
      mode: options.apply ? "apply" : "dry-run",
      status: verified ? "verified" : "blocked",
      sourceSystem: SOURCE_SYSTEM,
      geometryGapProof: {
        immutablePublicUniqueRingCount: rings.length,
        normalizedGeometryComponentCount: geometryResult.rows.length,
        normalizedExteriorRingCount: geometryResult.rows.length,
        omittedInteriorRingCount: derivedInteriorRingCount,
        exactInteriorRingSet: {
          path: exactSetPath,
          sha256: exactSetSha256,
        },
      },
      expected: {
        parcels: EXPECTED_PARCELS,
        geometryComponents: EXPECTED_GEOMETRY_COMPONENTS,
        rings: EXPECTED_RINGS,
        exteriorRings: EXPECTED_EXTERIOR_RINGS,
        interiorRings: EXPECTED_INTERIOR_RINGS,
      },
      before: beforeVerification,
      after: afterVerification,
      changedRows,
      protectedCountsBefore: baselineCounts,
      protectedCountsAfter: afterCounts,
      protectedCountsUnchanged: countsUnchanged,
      checkpoint: options.apply
        ? {
            schema: checkpointSchema,
            table: `${checkpointSchema}.geometry_rings_before`,
            rollbackPath,
          }
        : null,
      privacy: {
        aggregateOnly: true,
        namesAddressesContactsIncluded: false,
        publishable: false,
      },
      generatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(options.manifestPath), { recursive: true });
    await writeFile(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(exactSetPath, exactSetBody, { mode: 0o600 });
    if (options.apply) {
      await writeFile(
        rollbackPath,
        buildGeometryRingRollbackSql(checkpointSchema),
        { mode: 0o600 },
      );
    }
    if (!verified) {
      throw new Error("Rock Island geometry-ring reconciliation failed");
    }
    return manifest;
  } finally {
    if (lockAcquired) {
      await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [
        ADVISORY_LOCK_KEY,
      ]);
    }
    await pool.end();
  }
}

function preparedRingToInsert(
  row: PreparedRow,
  geometry: GeometryRow,
): GeometryRingInsert {
  if (row.tableName !== "geometry_rings") {
    throw new Error(`Unexpected geometry child table ${row.tableName}`);
  }
  if (
    row.references?.geometrySourceRecordKey !== geometry.source_record_key
  ) {
    throw new Error(
      `Geometry ring parent mismatch for ${geometry.source_record_key}`,
    );
  }
  return {
    coordinates: row.values.coordinates,
    geometry_id: geometry.geometry_id,
    polygon_index: requireInteger(row.values.polygon_index, "polygon_index"),
    request_identifier: geometry.request_identifier,
    ring_index: requireInteger(row.values.ring_index, "ring_index"),
    ring_role: requireString(row.values.ring_role, "ring_role"),
    source_artifact_uri:
      typeof row.values.source_artifact_uri === "string"
        ? row.values.source_artifact_uri
        : null,
    source_geometry_type: requireString(
      row.values.source_geometry_type,
      "source_geometry_type",
    ),
    source_payload: row.values.source_payload,
    source_record_hash:
      typeof row.values.source_record_hash === "string"
        ? row.values.source_record_hash
        : null,
    source_record_key: requireString(
      row.values.source_record_key,
      "source_record_key",
    ),
    source_system: requireString(
      row.values.source_system,
      "source_system",
    ),
  };
}

async function assertGeometryRingTableExists(pool: Pool): Promise<void> {
  const result = await pool.query<{ readonly table_name: string | null }>(
    "SELECT to_regclass('public.geometry_rings')::text AS table_name",
  );
  if (result.rows[0]?.table_name !== "geometry_rings") {
    throw new Error(
      "public.geometry_rings is missing; apply migration 0007 first",
    );
  }
}

async function createCheckpoint(
  pool: Pool,
  checkpointSchema: string,
  baselineCounts: DatabaseCounts,
): Promise<void> {
  const schema = quoteIdentifier(checkpointSchema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.geometry_rings_before
       (LIKE public.geometry_rings INCLUDING ALL)`,
    );
    await client.query(
      `INSERT INTO ${schema}.geometry_rings_before
       SELECT *
         FROM public.geometry_rings
        WHERE source_system = $1
       ON CONFLICT (source_system, source_record_key) DO NOTHING`,
      [SOURCE_SYSTEM],
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.baseline_counts (
         captured_at timestamptz NOT NULL DEFAULT now(),
         counts jsonb NOT NULL
       )`,
    );
    await client.query(
      `INSERT INTO ${schema}.baseline_counts (counts)
       SELECT $1::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.baseline_counts)`,
      [JSON.stringify(baselineCounts)],
    );
    await client.query("COMMIT");
  } catch (caught: unknown) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

async function upsertRingBatches(
  pool: Pool,
  rings: readonly GeometryRingInsert[],
): Promise<number> {
  let changedRows = 0;
  for (let start = 0; start < rings.length; start += 250) {
    const batch = rings.slice(start, start + 250);
    const result = await pool.query(
      `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS item(
             geometry_id uuid,
             request_identifier text,
             source_geometry_type text,
             polygon_index integer,
             ring_index integer,
             ring_role text,
             coordinates jsonb,
             source_payload jsonb,
             source_system text,
             source_record_key text,
             source_record_hash text,
             source_artifact_uri text
           )
       )
       INSERT INTO public.geometry_rings (
         geometry_id,
         request_identifier,
         source_geometry_type,
         polygon_index,
         ring_index,
         ring_role,
         coordinates,
         source_payload,
         source_system,
         source_record_key,
         source_record_hash,
         source_artifact_uri
       )
       SELECT
         geometry_id,
         request_identifier,
         source_geometry_type,
         polygon_index,
         ring_index,
         ring_role,
         coordinates,
         source_payload,
         source_system,
         source_record_key,
         source_record_hash,
         source_artifact_uri
       FROM input
       ON CONFLICT (source_system, source_record_key) DO UPDATE SET
         geometry_id = EXCLUDED.geometry_id,
         request_identifier = EXCLUDED.request_identifier,
         source_geometry_type = EXCLUDED.source_geometry_type,
         polygon_index = EXCLUDED.polygon_index,
         ring_index = EXCLUDED.ring_index,
         ring_role = EXCLUDED.ring_role,
         coordinates = EXCLUDED.coordinates,
         source_payload = EXCLUDED.source_payload,
         source_record_hash = EXCLUDED.source_record_hash,
         source_artifact_uri = EXCLUDED.source_artifact_uri,
         loaded_at = now(),
         updated_at = now()
       WHERE geometry_rings.source_record_hash IS DISTINCT FROM EXCLUDED.source_record_hash
          OR geometry_rings.geometry_id IS DISTINCT FROM EXCLUDED.geometry_id
       RETURNING geometry_ring_id`,
      [JSON.stringify(batch)],
    );
    changedRows += result.rowCount ?? 0;
  }
  return changedRows;
}

async function readProtectedCounts(pool: Pool): Promise<DatabaseCounts> {
  return {
    appraisal: await countTablesByExactSource(
      pool,
      APPRAISAL_TABLES,
      SOURCE_SYSTEM,
    ),
    corporate: await countTablesByExactSource(
      pool,
      CORPORATE_TABLES,
      "illinois_sos",
    ),
    permits: await countTablesBySourcePattern(
      pool,
      PERMIT_TABLES,
      "rock_island_%",
    ),
  };
}

async function countTablesByExactSource(
  pool: Pool,
  tables: readonly string[],
  sourceSystem: string,
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM public.${quoteIdentifier(table)}
        WHERE source_system = $1`,
      [sourceSystem],
    );
    counts[table] = Number(result.rows[0]?.count ?? "0");
  }
  return counts;
}

async function countTablesBySourcePattern(
  pool: Pool,
  tables: readonly string[],
  sourcePattern: string,
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM public.${quoteIdentifier(table)}
        WHERE source_system LIKE $1
          AND source_system <> $2`,
      [sourcePattern, SOURCE_SYSTEM],
    );
    counts[table] = Number(result.rows[0]?.count ?? "0");
  }
  return counts;
}

async function readVerificationCounts(
  pool: Pool,
): Promise<VerificationCounts> {
  const result = await pool.query<
    Record<keyof VerificationCounts, string>
  >(
    `SELECT
       (SELECT count(*) FROM parcels WHERE source_system = $1)::text AS "parcelCount",
       (SELECT count(*) FROM geometries WHERE source_system = $1)::text AS "geometryComponents",
       (SELECT count(*) FROM geometry_rings WHERE source_system = $1)::text AS "rings",
       (SELECT count(*) FROM geometry_rings WHERE source_system = $1 AND ring_role = 'exterior')::text AS "exteriorRings",
       (SELECT count(*) FROM geometry_rings WHERE source_system = $1 AND ring_role = 'interior')::text AS "interiorRings",
       (SELECT count(*)
          FROM geometries geometry
          LEFT JOIN parcels parcel
            ON parcel.source_system = geometry.source_system
           AND parcel.request_identifier = geometry.request_identifier
         WHERE geometry.source_system = $1
           AND parcel.parcel_id IS NULL)::text AS "geometryOrphans",
       (SELECT count(*)
          FROM geometry_rings ring
          LEFT JOIN geometries geometry
            ON geometry.geometry_id = ring.geometry_id
         WHERE ring.source_system = $1
           AND geometry.geometry_id IS NULL)::text AS "ringOrphans",
       (SELECT count(*)
          FROM (
            SELECT source_record_key
              FROM geometries
             WHERE source_system = $1
             GROUP BY source_record_key
            HAVING count(*) > 1
          ) duplicate)::text AS "duplicateGeometrySourceKeys",
       (SELECT count(*)
          FROM (
            SELECT source_record_key
              FROM geometry_rings
             WHERE source_system = $1
             GROUP BY source_record_key
            HAVING count(*) > 1
          ) duplicate)::text AS "duplicateRingSourceKeys",
       (SELECT count(*)
          FROM (
            SELECT geometry_id, polygon_index, ring_index
              FROM geometry_rings
             WHERE source_system = $1
             GROUP BY geometry_id, polygon_index, ring_index
            HAVING count(*) > 1
          ) duplicate)::text AS "duplicateRingIndexes",
       (SELECT count(*)
          FROM geometries geometry
         WHERE geometry.source_system = $1
           AND NOT EXISTS (
             SELECT 1
               FROM geometry_rings ring
              WHERE ring.geometry_id = geometry.geometry_id
                AND ring.ring_index = 0
                AND ring.ring_role = 'exterior'
           ))::text AS "geometriesWithoutExteriorRing"`,
    [SOURCE_SYSTEM],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Geometry verification returned no row");
  return {
    duplicateGeometrySourceKeys: Number(row.duplicateGeometrySourceKeys),
    duplicateRingIndexes: Number(row.duplicateRingIndexes),
    duplicateRingSourceKeys: Number(row.duplicateRingSourceKeys),
    exteriorRings: Number(row.exteriorRings),
    geometriesWithoutExteriorRing: Number(row.geometriesWithoutExteriorRing),
    geometryComponents: Number(row.geometryComponents),
    geometryOrphans: Number(row.geometryOrphans),
    interiorRings: Number(row.interiorRings),
    parcelCount: Number(row.parcelCount),
    ringOrphans: Number(row.ringOrphans),
    rings: Number(row.rings),
  };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Geometry ring ${fieldName} is missing`);
  }
  return value;
}

function requireInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Geometry ring ${fieldName} is not an integer`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function main(): Promise<void> {
  const manifest = await backfillRockIslandGeometryRings(
    parseGeometryRingBackfillOptions(process.argv.slice(2)),
  );
  console.log(
    JSON.stringify({
      event: "rock_island_geometry_ring_backfill_complete",
      status: manifest.status,
      mode: manifest.mode,
      changedRows: manifest.changedRows,
    }),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({
        event: "rock_island_geometry_ring_backfill_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
