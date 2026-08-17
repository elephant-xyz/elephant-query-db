import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import AdmZip from "adm-zip";
import { Pool, type PoolClient } from "pg";

import {
  canonicalJsonSha256,
  geometrySourceRecordKey,
  isJsonObject,
  readSourcePolygons,
  readTransformedPolygons,
  type JsonObject,
} from "./public-geometry.js";

const ROCK_ISLAND_SOURCE_SYSTEM = "rock_island_appraiser";
const EXPECTED_FOLIOS = 65_806;

type RepairOptions = {
  readonly sourceSystem: string;
  readonly manifestPath: string;
  readonly apply: boolean;
  readonly concurrency: number;
};

type ParcelArtifactRow = {
  readonly request_identifier: string;
  readonly source_artifact_uri: string;
};

type GeometryDbRow = {
  readonly geometry_id: string;
  readonly request_identifier: string;
  readonly source_record_key: string;
  readonly source_payload: unknown;
};

type SourceGeometryEvidence = {
  readonly folio: string;
  readonly entryName: string;
  readonly sourceRecordKey: string;
  readonly sourceByteSha256: string;
  readonly rawSourceByteSha256: string;
  readonly sourcePayloadSha256: string;
  readonly payload: JsonObject;
  readonly sourceArtifactUri: string;
  readonly polygonSha256: string;
  readonly polygonCount: number;
  readonly ringCount: number;
};

type RepairCandidate = SourceGeometryEvidence & {
  readonly geometryId: string;
  readonly beforePayloadSha256: string | null;
};

type RepairProof = {
  readonly operation: "insert" | "update";
  readonly geometryId: string;
  readonly sourceRecordKey: string;
  readonly sourceByteSha256: string;
  readonly rawSourceByteSha256: string;
  readonly sourcePayloadSha256: string;
  readonly beforePayloadSha256: string | null;
  readonly afterPayloadSha256: string;
};

/**
 * Parse bounded repair options. Applying is always explicit.
 *
 * @param argv - CLI arguments after the script name.
 * @returns Validated source, manifest, concurrency, and apply mode.
 */
export function parseGeometryRepairOptions(
  argv: readonly string[],
): RepairOptions {
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
  const sourceSystem =
    values.get("source-system") ?? ROCK_ISLAND_SOURCE_SYSTEM;
  if (sourceSystem !== ROCK_ISLAND_SOURCE_SYSTEM) {
    throw new Error("Geometry repair is scoped only to rock_island_appraiser");
  }
  const manifestPath = values.get("manifest");
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("--manifest is required");
  }
  const concurrency = Number.parseInt(
    values.get("concurrency") ?? "8",
    10,
  );
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("--concurrency must be between 1 and 32");
  }
  return { sourceSystem, manifestPath, apply, concurrency };
}

/**
 * Translate retained loader artifact URIs to the encrypted EBS path.
 *
 * @param uri - Loader source artifact URI.
 * @returns Existing local transformed ZIP path.
 */
export function artifactPathOnEbs(uri: string): string {
  const marker = "/data/artifacts/";
  const markerIndex = uri.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Source artifact URI does not contain /data/artifacts/");
  }
  return `/srv/ingest/data/artifacts/${uri.slice(markerIndex + marker.length)}`;
}

/**
 * Identify only geometry data sidecars, excluding relationships.
 *
 * @param entryName - ZIP entry path.
 * @returns Whether this is a geometry component data file.
 */
export function isGeometrySidecar(entryName: string): boolean {
  return /^data\/geometry(?:_\d+)?\.json$/u.test(entryName);
}

/**
 * Decide whether a DB payload requires source-backed repair.
 *
 * @param payload - Existing geometries.source_payload value.
 * @returns True only for absent or unusable geometry provenance.
 */
export function geometryPayloadNeedsRepair(payload: unknown): boolean {
  if (!isJsonObject(payload) || !isJsonObject(payload.source_payload)) {
    return true;
  }
  const response = payload.source_payload.response;
  return !isJsonObject(response) || !Array.isArray(response.features);
}

/**
 * Read and hash every geometry component in one retained source ZIP.
 *
 * @param row - Folio and retained artifact URI.
 * @param sourceSystem - Exact source-system scope.
 * @returns Source evidence preserving sidecar bytes and parsed payloads.
 */
function readArtifactGeometry(
  row: ParcelArtifactRow,
  sourceSystem: string,
): SourceGeometryEvidence[] {
  const zip = new AdmZip(artifactPathOnEbs(row.source_artifact_uri));
  const rawSourceEntry = zip.getEntry("data/source_payload.ndjson");
  if (rawSourceEntry === null) {
    throw new Error(
      `Missing verified raw source_payload sidecar for ${row.request_identifier}`,
    );
  }
  const rawSourceBytes = rawSourceEntry.getData();
  const rawLines = rawSourceBytes
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (rawLines.length !== 1) {
    throw new Error(
      `Raw source_payload sidecar must contain exactly one object for ${row.request_identifier}`,
    );
  }
  const rawSourcePayload = JSON.parse(rawLines[0] ?? "null") as unknown;
  if (!isJsonObject(rawSourcePayload)) {
    throw new Error(
      `Raw source_payload sidecar is not an object for ${row.request_identifier}`,
    );
  }
  return zip
    .getEntries()
    .filter((entry) => isGeometrySidecar(entry.entryName))
    .map((entry) => {
      const bytes = entry.getData();
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!isJsonObject(parsed)) {
        throw new Error(
          `Geometry sidecar is not an object: ${row.request_identifier}/${entry.entryName}`,
        );
      }
      const enrichedPayload: JsonObject = {
        ...parsed,
        source_payload: rawSourcePayload,
      };
      const polygons = readSourcePolygons(parsed);
      if (polygons === null) {
        throw new Error(
          `Geometry sidecar has invalid or open rings: ${row.request_identifier}/${entry.entryName}`,
        );
      }
      return {
        folio: row.request_identifier,
        entryName: entry.entryName,
        sourceRecordKey: geometrySourceRecordKey(
          sourceSystem,
          row.request_identifier,
          entry.entryName,
        ),
        sourceByteSha256: createHash("sha256")
          .update(rawSourceBytes)
          .update("\0")
          .update(bytes)
          .digest("hex"),
        rawSourceByteSha256: createHash("sha256")
          .update(rawSourceBytes)
          .digest("hex"),
        sourcePayloadSha256: canonicalJsonSha256(enrichedPayload),
        payload: enrichedPayload,
        sourceArtifactUri: row.source_artifact_uri,
        polygonSha256: canonicalJsonSha256(polygons),
        polygonCount: polygons.length,
        ringCount: polygons.reduce(
          (sum, polygon) => sum + polygon.length,
          0,
        ),
      };
    });
}

/**
 * Scan artifacts with bounded worker concurrency.
 *
 * @param rows - All county parcel artifact rows.
 * @param sourceSystem - Exact source-system scope.
 * @param concurrency - Maximum simultaneous ZIP readers.
 * @returns All source component evidence.
 */
async function scanGeometryArtifacts(
  rows: readonly ParcelArtifactRow[],
  sourceSystem: string,
  concurrency: number,
): Promise<SourceGeometryEvidence[]> {
  const results: SourceGeometryEvidence[][] = new Array(rows.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, rows.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index];
        if (row === undefined) return;
        results[index] = readArtifactGeometry(row, sourceSystem);
        if ((index + 1) % 5_000 === 0) {
          console.log(
            JSON.stringify({
              event: "geometry_source_scan_progress",
              completedFolios: index + 1,
              totalFolios: rows.length,
            }),
          );
        }
      }
    },
  );
  await Promise.all(workers);
  return results.flat();
}

/**
 * Apply source-backed payload updates in bounded batches.
 *
 * @param client - Open transaction client.
 * @param sourceSystem - Exact source-system scope.
 * @param candidates - Rows proven missing and backed by source bytes.
 * @returns Updated source-record keys.
 */
async function applyRepairBatches(
  client: PoolClient,
  sourceSystem: string,
  candidates: readonly RepairCandidate[],
): Promise<Set<string>> {
  const updated = new Set<string>();
  for (let start = 0; start < candidates.length; start += 500) {
    const batch = candidates.slice(start, start + 500).map((candidate) => ({
      geometry_id: candidate.geometryId,
      source_record_key: candidate.sourceRecordKey,
      source_payload: candidate.payload,
    }));
    const result = await client.query<{ source_record_key: string }>(
      `WITH repair AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           geometry_id uuid,
           source_record_key text,
           source_payload jsonb
         )
       )
       UPDATE geometries AS geometry
          SET source_payload = repair.source_payload,
              updated_at = now()
         FROM repair
        WHERE geometry.geometry_id = repair.geometry_id
          AND geometry.source_record_key = repair.source_record_key
          AND geometry.source_system = $2
          AND (
            geometry.source_payload IS NULL
            OR jsonb_typeof(geometry.source_payload) <> 'object'
            OR NOT (geometry.source_payload ? 'polygon')
            OR jsonb_typeof(geometry.source_payload->'source_payload') IS DISTINCT FROM 'object'
            OR jsonb_typeof(geometry.source_payload->'source_payload'->'response'->'features') IS DISTINCT FROM 'array'
          )
       RETURNING geometry.source_record_key`,
      [JSON.stringify(batch), sourceSystem],
    );
    result.rows.forEach((row) => updated.add(row.source_record_key));
  }
  return updated;
}

/**
 * Build the source-component insert without requiring a logical property row.
 *
 * Parcels are the publication parent and `geometries.property_id` is nullable.
 * An inner property join silently drops geometry for parcel-only folios.
 *
 * @returns Parameterized, source-scoped component insert SQL.
 */
export function buildMissingGeometryInsertSql(): string {
  return `WITH repair AS (
           SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS item(
             request_identifier text,
             source_record_key text,
             source_record_hash text,
             source_artifact_uri text,
             source_http_request jsonb,
             source_payload jsonb
           )
         )
         INSERT INTO geometries (
           property_id,
           request_identifier,
           source_http_request,
           source_payload,
           source_system,
           source_record_key,
           source_record_hash,
           source_artifact_uri
         )
         SELECT
           property.property_id,
           repair.request_identifier,
           repair.source_http_request,
           repair.source_payload,
           $2,
           repair.source_record_key,
           repair.source_record_hash,
           repair.source_artifact_uri
         FROM repair
         LEFT JOIN properties property
           ON property.source_system = $2
          AND property.request_identifier = repair.request_identifier
         ON CONFLICT (source_system, source_record_key) DO NOTHING
         RETURNING geometry_id, source_record_key`;
}

/**
 * Insert source components absent from the DB without synthesizing fields.
 *
 * @param client - Open transaction client.
 * @param sourceSystem - Exact source-system scope.
 * @param evidenceRows - Source components with no existing canonical key.
 * @returns Inserted geometry IDs keyed by source-record key.
 */
async function insertMissingComponents(
  client: PoolClient,
  sourceSystem: string,
  evidenceRows: readonly SourceGeometryEvidence[],
): Promise<Map<string, string>> {
  const inserted = new Map<string, string>();
  for (let start = 0; start < evidenceRows.length; start += 500) {
    const batch = evidenceRows.slice(start, start + 500).map((evidence) => ({
      request_identifier: evidence.folio,
      source_record_key: evidence.sourceRecordKey,
      source_record_hash: evidence.sourcePayloadSha256,
      source_artifact_uri: evidence.sourceArtifactUri,
      source_http_request: isJsonObject(
        evidence.payload.source_http_request,
      )
        ? evidence.payload.source_http_request
        : null,
      source_payload: evidence.payload,
    }));
    const result = await client.query<{
      readonly geometry_id: string;
      readonly source_record_key: string;
    }>(
      buildMissingGeometryInsertSql(),
      [JSON.stringify(batch), sourceSystem],
    );
    result.rows.forEach((row) =>
      inserted.set(row.source_record_key, row.geometry_id),
    );
  }
  return inserted;
}

/**
 * Inventory, verify, and optionally repair geometry source provenance.
 *
 * @param options - Strict Rock Island repair configuration.
 * @returns Durable repair manifest.
 */
export async function repairGeometrySourcePayload(
  options: RepairOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({
    application_name: "rock-island-geometry-source-payload-repair",
    connectionString: databaseUrl,
    max: 4,
  });
  let manifest: Readonly<Record<string, unknown>> | null = null;
  try {
    const parcels = await pool.query<ParcelArtifactRow>(
      `SELECT request_identifier, source_artifact_uri
         FROM parcels
        WHERE source_system = $1
          AND request_identifier IS NOT NULL
          AND source_artifact_uri IS NOT NULL
        ORDER BY request_identifier`,
      [options.sourceSystem],
    );
    const distinctFolios = new Set(
      parcels.rows.map((row) => row.request_identifier),
    );
    if (
      parcels.rows.length !== EXPECTED_FOLIOS ||
      distinctFolios.size !== EXPECTED_FOLIOS
    ) {
      throw new Error(
        `Expected ${EXPECTED_FOLIOS} retained folio artifacts; rows=${parcels.rows.length} distinct=${distinctFolios.size}`,
      );
    }
    const sourceEvidence = await scanGeometryArtifacts(
      parcels.rows,
      options.sourceSystem,
      options.concurrency,
    );
    sourceEvidence.sort((left, right) =>
      left.sourceRecordKey.localeCompare(right.sourceRecordKey),
    );
    const sourceByKey = new Map<string, SourceGeometryEvidence>();
    for (const evidence of sourceEvidence) {
      if (sourceByKey.has(evidence.sourceRecordKey)) {
        throw new Error(
          `Duplicate source geometry key ${evidence.sourceRecordKey}`,
        );
      }
      sourceByKey.set(evidence.sourceRecordKey, evidence);
    }
    const dbResult = await pool.query<GeometryDbRow>(
      `SELECT geometry_id, request_identifier, source_record_key, source_payload
         FROM geometries
        WHERE source_system = $1
        ORDER BY source_record_key`,
      [options.sourceSystem],
    );
    const dbByKey = new Map(
      dbResult.rows.map((row) => [row.source_record_key, row]),
    );
    const missingDbEvidence = sourceEvidence.filter(
      (evidence) => !dbByKey.has(evidence.sourceRecordKey),
    );
    const missingDbKeys = missingDbEvidence.map(
      (evidence) => evidence.sourceRecordKey,
    );
    const extraDbKeys = dbResult.rows
      .filter((row) => !sourceByKey.has(row.source_record_key))
      .map((row) => row.source_record_key);
    const candidates: RepairCandidate[] = [];
    const mismatchedExistingKeys: string[] = [];
    const mismatchedExistingPolygonKeys: string[] = [];
    const mismatchedFolioKeys: string[] = [];
    let exactPayloadMatches = 0;
    let exactPolygonMatches = 0;
    for (const evidence of sourceEvidence) {
      const row = dbByKey.get(evidence.sourceRecordKey);
      if (row === undefined) continue;
      if (row.request_identifier !== evidence.folio) {
        mismatchedFolioKeys.push(evidence.sourceRecordKey);
        continue;
      }
      if (geometryPayloadNeedsRepair(row.source_payload)) {
        candidates.push({
          ...evidence,
          geometryId: row.geometry_id,
          beforePayloadSha256: isJsonObject(row.source_payload)
            ? canonicalJsonSha256(row.source_payload)
            : null,
        });
        continue;
      }
      const dbHash = canonicalJsonSha256(row.source_payload);
      const dbPolygons = readTransformedPolygons(row.source_payload);
      if (
        dbPolygons !== null &&
        canonicalJsonSha256(dbPolygons) === evidence.polygonSha256
      ) {
        exactPolygonMatches += 1;
      } else {
        mismatchedExistingPolygonKeys.push(evidence.sourceRecordKey);
      }
      if (dbHash !== evidence.sourcePayloadSha256) {
        mismatchedExistingKeys.push(evidence.sourceRecordKey);
      } else {
        exactPayloadMatches += 1;
      }
    }
    const blockingMismatchCount =
      extraDbKeys.length +
      mismatchedExistingPolygonKeys.length +
      mismatchedFolioKeys.length;
    let updatedKeys = new Set<string>();
    let insertedRows = new Map<string, string>();
    let verifiedRepairedRows = 0;
    if (
      options.apply &&
      blockingMismatchCount === 0 &&
      (candidates.length > 0 || missingDbEvidence.length > 0)
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        updatedKeys = await applyRepairBatches(
          client,
          options.sourceSystem,
          candidates,
        );
        if (updatedKeys.size !== candidates.length) {
          throw new Error(
            `Repair update cardinality mismatch: expected=${candidates.length} updated=${updatedKeys.size}`,
          );
        }
        insertedRows = await insertMissingComponents(
          client,
          options.sourceSystem,
          missingDbEvidence,
        );
        if (insertedRows.size !== missingDbEvidence.length) {
          throw new Error(
            `Repair insert cardinality mismatch: expected=${missingDbEvidence.length} inserted=${insertedRows.size}`,
          );
        }
        const repairedKeys = [
          ...updatedKeys,
          ...insertedRows.keys(),
        ];
        if (repairedKeys.length > 0) {
          const verification = await client.query<GeometryDbRow>(
            `SELECT geometry_id, request_identifier, source_record_key, source_payload
               FROM geometries
              WHERE source_system = $1
                AND source_record_key = ANY($2::text[])
              ORDER BY source_record_key`,
            [options.sourceSystem, repairedKeys],
          );
          for (const row of verification.rows) {
            const evidence = sourceByKey.get(row.source_record_key);
            if (
              evidence === undefined ||
              row.request_identifier !== evidence.folio ||
              canonicalJsonSha256(row.source_payload) !==
                evidence.sourcePayloadSha256
            ) {
              throw new Error(
                `Post-repair source proof failed for ${row.source_record_key}`,
              );
            }
            verifiedRepairedRows += 1;
          }
          if (verifiedRepairedRows !== repairedKeys.length) {
            throw new Error(
              `Post-repair proof cardinality mismatch: expected=${repairedKeys.length} verified=${verifiedRepairedRows}`,
            );
          }
        }
        await client.query("COMMIT");
      } catch (caught: unknown) {
        await client.query("ROLLBACK");
        throw caught;
      } finally {
        client.release();
      }
    }
    const repairProof: RepairProof[] = candidates
      .filter((candidate) => updatedKeys.has(candidate.sourceRecordKey))
      .map((candidate) => ({
        operation: "update" as const,
        geometryId: candidate.geometryId,
        sourceRecordKey: candidate.sourceRecordKey,
        sourceByteSha256: candidate.sourceByteSha256,
        rawSourceByteSha256: candidate.rawSourceByteSha256,
        sourcePayloadSha256: candidate.sourcePayloadSha256,
        beforePayloadSha256: candidate.beforePayloadSha256,
        afterPayloadSha256: candidate.sourcePayloadSha256,
      }));
    missingDbEvidence.forEach((evidence) => {
      const geometryId = insertedRows.get(evidence.sourceRecordKey);
      if (geometryId === undefined) return;
      repairProof.push({
        operation: "insert",
        geometryId,
        sourceRecordKey: evidence.sourceRecordKey,
        sourceByteSha256: evidence.sourceByteSha256,
        rawSourceByteSha256: evidence.rawSourceByteSha256,
        sourcePayloadSha256: evidence.sourcePayloadSha256,
        beforePayloadSha256: null,
        afterPayloadSha256: evidence.sourcePayloadSha256,
      });
    });
    const aggregate = createHash("sha256");
    sourceEvidence.forEach((evidence) => {
      aggregate.update(
        `${evidence.sourceRecordKey}|${evidence.sourceByteSha256}|${evidence.sourcePayloadSha256}\n`,
      );
    });
    const status =
      blockingMismatchCount > 0
        ? "blocked"
        : !options.apply &&
            (candidates.length > 0 || missingDbEvidence.length > 0)
          ? "repair_required"
          : "verified";
    manifest = {
      schemaVersion: "1",
      sourceSystem: options.sourceSystem,
      mode: options.apply ? "apply" : "dry-run",
      status,
      expectedFolios: EXPECTED_FOLIOS,
      scannedFolios: parcels.rows.length,
      sourceComponentCount: sourceEvidence.length,
      dbComponentCount: dbResult.rows.length,
      dbComponentCountAfter:
        dbResult.rows.length + insertedRows.size,
      exactPayloadMatches,
      exactPolygonMatches,
      repairCandidateCount: candidates.length,
      updatedRows: updatedKeys.size,
      insertedRows: insertedRows.size,
      verifiedRepairedRows,
      missingDbRowCount: missingDbKeys.length,
      extraDbRowCount: extraDbKeys.length,
      mismatchedExistingPayloadCount: mismatchedExistingKeys.length,
      mismatchedExistingPolygonCount:
        mismatchedExistingPolygonKeys.length,
      mismatchedFolioCount: mismatchedFolioKeys.length,
      polygonCount: sourceEvidence.reduce(
        (sum, evidence) => sum + evidence.polygonCount,
        0,
      ),
      ringCount: sourceEvidence.reduce(
        (sum, evidence) => sum + evidence.ringCount,
        0,
      ),
      sourceEvidenceSha256: aggregate.digest("hex"),
      missingDbKeys,
      extraDbKeys,
      mismatchedExistingKeys,
      mismatchedExistingPolygonKeys,
      mismatchedFolioKeys,
      repairProof,
      generatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(options.manifestPath), { recursive: true });
    await writeFile(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (status !== "verified") {
      throw new Error(
        `Geometry source payload gate did not pass: status=${status}`,
      );
    }
    return manifest;
  } finally {
    await pool.end();
  }
}

/**
 * Execute the bounded repair CLI.
 *
 * @returns Promise resolved after manifest persistence.
 */
async function main(): Promise<void> {
  const manifest = await repairGeometrySourcePayload(
    parseGeometryRepairOptions(process.argv.slice(2)),
  );
  console.log(
    JSON.stringify({
      event: "geometry_source_payload_repair_complete",
      status: manifest.status,
      sourceComponentCount: manifest.sourceComponentCount,
      updatedRows: manifest.updatedRows,
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
        event: "geometry_source_payload_repair_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
