import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import AdmZip from "adm-zip";
import { Pool } from "pg";

import {
  buildExactMultiPolygon,
  canonicalJsonSha256,
  readSourcePolygons,
} from "./public-geometry.js";
import {
  assertRockIslandArcGisOutFields,
  assertPublicNonPii,
} from "./run-public-property-export.js";
import {
  buildValuationCountByFolioSql,
  countSourceClasses,
} from "./validate-publication-dry-run.js";
import { artifactPathOnEbs } from "./repair-rock-island-geometry-source-payload.js";

const SOURCE_SYSTEM = "rock_island_appraiser";
const EXPECTED_FOLIOS = 65_806;

type PreExportOptions = {
  readonly repairManifestPath: string;
  readonly reportPath: string;
  readonly concurrency: number;
};

type ParcelRow = {
  readonly request_identifier: string;
  readonly source_artifact_uri: string;
  readonly source_payload: unknown;
};

type GeometryRow = {
  readonly request_identifier: string;
  readonly source_record_key: string;
  readonly source_payload: unknown;
};

type CountRow = {
  readonly count: string;
};

const SOURCE_TO_DB = {
  parcels: "parcels",
  properties: "properties",
  addresses: "addresses",
  lots: "lots",
  geometries: "geometries",
  taxes: "taxes",
  property_valuations: "property_valuations",
  sales_histories: "sales_histories",
  structures: "structures",
  layouts: "layouts",
  utilities: "utilities",
  deeds: "deeds",
  files: "files",
  flood_storm_information: "flood_storm_information",
} as const;

/**
 * Parse required pre-export evidence paths.
 *
 * @param argv - CLI arguments after the script name.
 * @returns Validated report configuration.
 */
export function parsePreExportOptions(
  argv: readonly string[],
): PreExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
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
  const repairManifestPath = values.get("repair-manifest");
  const reportPath = values.get("report");
  if (repairManifestPath === undefined || reportPath === undefined) {
    throw new Error("--repair-manifest and --report are required");
  }
  const concurrency = Number.parseInt(
    values.get("concurrency") ?? "12",
    10,
  );
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("--concurrency must be between 1 and 32");
  }
  return { repairManifestPath, reportPath, concurrency };
}

/**
 * Select twelve deterministic folios from sorted source rows.
 *
 * @param rows - Sorted parcel rows.
 * @returns Stable twelve-row sample.
 */
export function selectPreExportSample(
  rows: readonly ParcelRow[],
): readonly ParcelRow[] {
  if (rows.length < 12) throw new Error("Fewer than twelve parcel rows");
  let state = 0x524f434b;
  const indices = new Set<number>();
  while (indices.size < 12) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    indices.add((state >>> 0) % rows.length);
  }
  return [...indices].map((index) => rows[index] as ParcelRow);
}

/**
 * Scan every retained artifact once and count source classes.
 *
 * @param rows - County parcel artifacts.
 * @param concurrency - Maximum simultaneous ZIP readers.
 * @returns Aggregate source-class counts.
 */
async function countAllSourceClasses(
  rows: readonly ParcelRow[],
  concurrency: number,
): Promise<Record<string, number>> {
  const perArtifact: Readonly<Record<string, number>>[] = new Array(
    rows.length,
  );
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, rows.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index];
        if (row === undefined) return;
        const zip = new AdmZip(
          artifactPathOnEbs(row.source_artifact_uri),
        );
        perArtifact[index] = countSourceClasses(
          zip.getEntries().map((entry) => entry.entryName),
        );
      }
    },
  );
  await Promise.all(workers);
  const totals: Record<string, number> = {};
  perArtifact.forEach((counts) => {
    Object.entries(counts).forEach(([name, count]) => {
      totals[name] = (totals[name] ?? 0) + count;
    });
  });
  return totals;
}

/**
 * Load exact source-system table counts with no cross-child joins.
 *
 * @param pool - Connected PostgreSQL pool.
 * @returns Counts keyed by logical table.
 */
async function loadDbCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of Object.values(SOURCE_TO_DB)) {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM ${table}
        WHERE source_system = $1`,
      [SOURCE_SYSTEM],
    );
    counts[table] = Number.parseInt(
      result.rows[0]?.count ?? "0",
      10,
    );
  }
  return counts;
}

/**
 * Run all gates that must pass before producing publication artifacts.
 *
 * @param options - Repair and report paths.
 * @returns Durable pre-export validation report.
 */
export async function validateRockIslandPreExport(
  options: PreExportOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const repairManifest = JSON.parse(
    await readFile(options.repairManifestPath, "utf8"),
  ) as Record<string, unknown>;
  if (
    repairManifest.status !== "verified" ||
    repairManifest.sourceSystem !== SOURCE_SYSTEM ||
    repairManifest.sourceComponentCount !==
      repairManifest.dbComponentCountAfter
  ) {
    throw new Error("Geometry repair manifest is not a complete verified gate");
  }
  const pool = new Pool({
    application_name: "rock-island-pre-export-validation",
    connectionString: databaseUrl,
    max: 4,
  });
  try {
    const parcelResult = await pool.query<ParcelRow>(
      `SELECT request_identifier, source_artifact_uri, source_payload
         FROM parcels
        WHERE source_system = $1
          AND request_identifier IS NOT NULL
          AND source_artifact_uri IS NOT NULL
        ORDER BY request_identifier`,
      [SOURCE_SYSTEM],
    );
    const distinctFolios = new Set(
      parcelResult.rows.map((row) => row.request_identifier),
    );
    if (
      parcelResult.rows.length !== EXPECTED_FOLIOS ||
      distinctFolios.size !== EXPECTED_FOLIOS
    ) {
      throw new Error("Rock Island parcel folio gate failed");
    }
    let deniedPiiFindings = 0;
    parcelResult.rows.forEach((row) => {
      try {
        assertRockIslandArcGisOutFields(row.source_payload);
        assertPublicNonPii(row.source_payload);
      } catch {
        deniedPiiFindings += 1;
      }
    });
    if (deniedPiiFindings !== 0) {
      throw new Error("Denied PII found in parcel source payloads");
    }
    const geometryResult = await pool.query<GeometryRow>(
      `SELECT request_identifier, source_record_key, source_payload
         FROM geometries
        WHERE source_system = $1
        ORDER BY request_identifier, source_record_key`,
      [SOURCE_SYSTEM],
    );
    const geometryByFolio = new Map<string, unknown[]>();
    const geometryEvidence = createHash("sha256");
    let rawPolygonObservationsAcrossComponents = 0;
    let rawRingObservationsAcrossComponents = 0;
    for (const row of geometryResult.rows) {
      assertPublicNonPii(row.source_payload);
      const polygons = readSourcePolygons(row.source_payload);
      if (polygons === null) {
        throw new Error(
          `Invalid geometry payload at ${row.source_record_key}`,
        );
      }
      rawPolygonObservationsAcrossComponents += polygons.length;
      rawRingObservationsAcrossComponents += polygons.reduce(
        (sum, polygon) => sum + polygon.length,
        0,
      );
      geometryEvidence.update(
        `${row.source_record_key}|${canonicalJsonSha256(row.source_payload)}\n`,
      );
      const existing =
        geometryByFolio.get(row.request_identifier) ?? [];
      existing.push(row.source_payload);
      geometryByFolio.set(row.request_identifier, existing);
    }
    let multiPolygonFolios = 0;
    let multiComponentFolios = 0;
    let uniquePolygonCount = 0;
    let uniqueInteriorRingCount = 0;
    let uniqueRingCount = 0;
    geometryByFolio.forEach((payloads, folio) => {
      let geometry: ReturnType<typeof buildExactMultiPolygon>;
      try {
        geometry = buildExactMultiPolygon(payloads);
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : String(caught);
        throw new Error(`Geometry fidelity failed for ${folio}: ${message}`);
      }
      if (geometry === null) return;
      uniquePolygonCount += geometry.coordinates.length;
      uniqueInteriorRingCount += geometry.coordinates.reduce(
        (sum, polygon) => sum + Math.max(0, polygon.length - 1),
        0,
      );
      uniqueRingCount += geometry.coordinates.reduce(
        (sum, polygon) => sum + polygon.length,
        0,
      );
      multiPolygonFolios += 1;
      if (geometry.coordinates.length > 1) {
        multiComponentFolios += 1;
      }
    });
    const sourceCounts = await countAllSourceClasses(
      parcelResult.rows,
      options.concurrency,
    );
    const dbCounts = await loadDbCounts(pool);
    const sample = selectPreExportSample(parcelResult.rows);
    let sampledArtifactsMatched = 0;
    for (const row of sample) {
      const zip = new AdmZip(artifactPathOnEbs(row.source_artifact_uri));
      const counts = countSourceClasses(
        zip.getEntries().map((entry) => entry.entryName),
      );
      for (const [sourceClass, table] of Object.entries(SOURCE_TO_DB)) {
        const result =
          table === "property_valuations"
            ? await pool.query<CountRow>(
                buildValuationCountByFolioSql(),
                [SOURCE_SYSTEM, row.request_identifier],
              )
            : await pool.query<CountRow>(
                `SELECT count(*)::text AS count
                   FROM ${table}
                  WHERE source_system = $1
                    AND request_identifier = $2`,
                [SOURCE_SYSTEM, row.request_identifier],
              );
        const dbCount = Number.parseInt(
          result.rows[0]?.count ?? "0",
          10,
        );
        if ((counts[sourceClass] ?? 0) !== dbCount) {
          throw new Error(
            `Sample source/DB mismatch folio=${row.request_identifier} class=${sourceClass}`,
          );
        }
      }
      sampledArtifactsMatched += 1;
    }
    const report = {
      schemaVersion: "1",
      sourceSystem: SOURCE_SYSTEM,
      expectedFolios: EXPECTED_FOLIOS,
      parcelRows: parcelResult.rows.length,
      distinctFolios: distinctFolios.size,
      sourceCounts,
      dbCounts,
      sampledSourceDbCountsMatched: true,
      deniedPiiFindings,
      sampledArtifactsMatched,
      geometryComponentCount: geometryResult.rows.length,
      rawPolygonObservationsAcrossComponents,
      rawRingObservationsAcrossComponents,
      uniquePolygonCount,
      uniqueExteriorRingCount: uniquePolygonCount,
      uniqueInteriorRingCount,
      uniqueRingCount,
      geometrySourcePayloadMissing: 0,
      geometryEvidenceSha256: geometryEvidence.digest("hex"),
      multiPolygonFolios,
      multiComponentFolios,
      repairManifestPath: options.repairManifestPath,
      validatedAt: new Date().toISOString(),
    };
    await writeFile(
      options.reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    return report;
  } finally {
    await pool.end();
  }
}

/**
 * Execute the pre-export gate.
 *
 * @returns Promise resolved after report persistence.
 */
async function main(): Promise<void> {
  const report = await validateRockIslandPreExport(
    parsePreExportOptions(process.argv.slice(2)),
  );
  console.log(
    JSON.stringify({
      event: "rock_island_pre_export_validation_passed",
      distinctFolios: report.distinctFolios,
      geometryComponentCount: report.geometryComponentCount,
      sampledArtifactsMatched: report.sampledArtifactsMatched,
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
        event: "rock_island_pre_export_validation_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
