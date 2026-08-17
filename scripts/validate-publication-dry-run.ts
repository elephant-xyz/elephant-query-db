import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { ParquetReader } from "@dsnp/parquetjs";
import AdmZip from "adm-zip";
import { Pool } from "pg";

import { computeIpfsCid } from "./run-property-consolidation-export.js";
import {
  assertPublicNonPii,
  sourceSystemForCounty,
} from "./run-public-property-export.js";
import {
  canonicalJsonSha256,
  isJsonObject,
  readSourcePolygons,
} from "./public-geometry.js";
import { PUBLIC_COVERAGE_ENRICHMENT_TRACKS } from "./write-public-coverage-snapshot.js";

/**
 * Non-appraisal tracks that an appraisal-only publication must report as
 * honestly incomplete. Published enrichments are validated against explicit
 * operator-provided counts later in the full dry-run.
 */
export const PUBLICATION_HONESTLY_INCOMPLETE_TRACKS =
  PUBLIC_COVERAGE_ENRICHMENT_TRACKS;

export type CoverageTrackRow = {
  readonly ingested_count?: unknown;
  readonly expected_count?: unknown;
};

/**
 * Assert that each non-appraisal coverage track is present at zero with a null
 * expected count ("not ingested" rather than "complete at zero").
 *
 * @param coverageRows - Snapshot rows keyed by source spelling.
 * @returns Nothing when every track is honestly incomplete.
 */
export function assertHonestlyIncompleteCoverageTracks(
  coverageRows: ReadonlyMap<string, CoverageTrackRow>,
): void {
  for (const track of PUBLICATION_HONESTLY_INCOMPLETE_TRACKS) {
    const row = coverageRows.get(track);
    if (row?.ingested_count !== 0 || row.expected_count !== null) {
      throw new Error(`Coverage track ${track} is not honestly incomplete`);
    }
  }
}

type ManifestEntry = {
  readonly propertyId: string;
  readonly parcelIdentifier: string;
  readonly filePath: string;
  readonly fileSizeBytes: number;
  readonly sha256: string;
  readonly cid: string | null;
};

type Manifest = {
  readonly county: string;
  readonly propertyCount: number;
  readonly totalBytes: number;
  readonly entries: readonly ManifestEntry[];
};

type IndexFile = {
  readonly county: string;
  readonly propertyCount: number;
  readonly shards: ReadonlyArray<{
    readonly shardIndex: number;
    readonly count: number;
    readonly shardCid: string | null;
  }>;
};

type PublicRecord = {
  readonly requestIdentifier?: unknown;
  readonly address?: unknown;
  readonly property?: unknown;
  readonly parcelPolygon?: unknown;
  readonly sourcePayload?: unknown;
  readonly geometries?: unknown;
  readonly taxes?: unknown;
  readonly sales?: unknown;
  readonly structures?: unknown;
  readonly layouts?: unknown;
  readonly lots?: unknown;
  readonly utilities?: unknown;
  readonly deeds?: unknown;
  readonly files?: unknown;
  readonly valuations?: unknown;
  readonly floodStormInformation?: unknown;
};

type CountRow = {
  readonly name: string;
  readonly count: string;
};

type SampleArtifactRow = {
  readonly request_identifier: string;
  readonly source_artifact_uri: string;
};

type GeometryPayloadRow = {
  readonly request_identifier: string;
  readonly source_payload: unknown;
};

export type PublicationValidationOptions = {
  readonly county: string;
  readonly expectedCount: number;
  readonly expectedPermitCount: number;
  readonly expectedCorporateCount: number;
  readonly expectedBbbCount: number;
  readonly expectedOverturePlacesCount: number;
  readonly propertyDirectory: string;
  readonly queryTablePath: string;
  readonly coveragePath: string;
  readonly reportPath: string;
};

const ARRAY_FIELDS = [
  "geometries",
  "taxes",
  "sales",
  "structures",
  "layouts",
  "lots",
  "utilities",
  "deeds",
  "files",
  "valuations",
  "floodStormInformation",
] as const;

const DB_TO_EXPORT = {
  geometries: "geometries",
  taxes: "taxes",
  sales_histories: "sales",
  structures: "structures",
  layouts: "layouts",
  lots: "lots",
  utilities: "utilities",
  deeds: "deeds",
  files: "files",
  property_valuations: "valuations",
  flood_storm_information: "floodStormInformation",
} as const;

/**
 * Build the valuation count query without joining unrelated child tables.
 *
 * The source-system predicate is applied on both sides of the property-id join,
 * preventing cross-source parent matches while preserving one count per
 * valuation row.
 *
 * @returns Parameterized per-folio valuation count SQL.
 */
export function buildValuationCountByFolioSql(): string {
  return `SELECT count(*)::text AS count
            FROM property_valuations valuation
            JOIN properties property
              ON property.property_id = valuation.property_id
             AND property.source_system = valuation.source_system
           WHERE valuation.source_system = $1
             AND property.source_system = $1
             AND property.request_identifier = $2`;
}

/**
 * Parse validation paths and exact expected cardinality.
 *
 * @param argv - Arguments after the script name.
 * @returns Complete local dry-run validation configuration.
 */
export function parsePublicationValidationOptions(
  argv: readonly string[],
): PublicationValidationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const county = values.get("county") ?? "rock-island";
  const expectedCount = Number.parseInt(values.get("expected-count") ?? "", 10);
  const expectedPermitCount = readNonNegativeCount(
    values.get("expected-permit-count"),
    "--expected-permit-count",
  );
  const expectedCorporateCount = readNonNegativeCount(
    values.get("expected-corporate-count"),
    "--expected-corporate-count",
  );
  const expectedBbbCount = readNonNegativeCount(
    values.get("expected-bbb-count"),
    "--expected-bbb-count",
  );
  const expectedOverturePlacesCount = readNonNegativeCount(
    values.get("expected-overture-places-count"),
    "--expected-overture-places-count",
  );
  const propertyDirectory = values.get("property-dir");
  const queryTablePath = values.get("query-table");
  const coveragePath = values.get("coverage");
  const reportPath = values.get("report");
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error("--expected-count must be a positive integer");
  }
  if (
    propertyDirectory === undefined ||
    queryTablePath === undefined ||
    coveragePath === undefined ||
    reportPath === undefined
  ) {
    throw new Error(
      "--property-dir, --query-table, --coverage, and --report are required",
    );
  }
  return {
    county,
    expectedCount,
    expectedPermitCount,
    expectedCorporateCount,
    expectedBbbCount,
    expectedOverturePlacesCount,
    propertyDirectory,
    queryTablePath,
    coveragePath,
    reportPath,
  };
}

/**
 * Validate one enrichment coverage row against an operator-provided exact
 * publication count.
 *
 * Non-zero tracks must carry immutable CID and stable IPNS provenance.
 * `expected_count` may be null when the public subset is known exactly but the
 * complete source universe is not, as with the approved Illinois corporate
 * publication.
 *
 * @param track - Coverage source name.
 * @param row - Parsed coverage row.
 * @param expectedIngestedCount - Exact count approved for this publication.
 */
export function assertPublishedCoverageTrack(
  track: string,
  row: Record<string, unknown> | undefined,
  expectedIngestedCount: number,
): void {
  if (
    row?.ingested_count !== expectedIngestedCount ||
    (row.expected_count !== null &&
      row.expected_count !== expectedIngestedCount)
  ) {
    throw new Error(`Coverage track ${track} count is not approved`);
  }
  if (
    expectedIngestedCount > 0 &&
    (typeof row.cid !== "string" ||
      row.cid.length === 0 ||
      typeof row.ipns_label !== "string" ||
      row.ipns_label.length === 0)
  ) {
    throw new Error(`Coverage track ${track} lacks publication provenance`);
  }
}

function readNonNegativeCount(
  value: string | undefined,
  optionName: string,
): number {
  const count = Number.parseInt(value ?? "0", 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return count;
}

/**
 * Return an array field from a parsed public property record.
 *
 * @param record - Parsed public property.
 * @param key - Approved child-array key.
 * @returns The array, failing closed if the export shape is malformed.
 */
function recordArray(
  record: PublicRecord,
  key: (typeof ARRAY_FIELDS)[number],
): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Public record field ${key} is not an array`);
  }
  return value;
}

/**
 * Select twelve deterministic pseudo-random manifest entries.
 *
 * @param entries - Full manifest entries in export order.
 * @param count - Requested sample size.
 * @returns Stable non-repeating sample for the same manifest cardinality.
 */
export function selectDeterministicSample(
  entries: readonly ManifestEntry[],
  count: number,
): readonly ManifestEntry[] {
  if (entries.length < count) {
    throw new Error("Manifest is smaller than the requested sample");
  }
  let state = 0x524f434b;
  const indices = new Set<number>();
  while (indices.size < count) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    indices.add((state >>> 0) % entries.length);
  }
  return [...indices].map((index) => entries[index] as ManifestEntry);
}

/**
 * Count transformed source files by logical public class.
 *
 * @param fileNames - ZIP entry names.
 * @returns Logical class counts matching DB/export child names.
 */
export function countSourceClasses(
  fileNames: readonly string[],
): Readonly<Record<string, number>> {
  const count = (pattern: RegExp): number =>
    fileNames.filter((name) => pattern.test(name)).length;
  const taxes = count(/^data\/tax_\d+\.json$/u);
  return {
    parcels: count(/^data\/parcel\.json$/u),
    properties: count(/^data\/property\.json$/u),
    addresses: count(/^data\/address\.json$/u),
    lots: count(/^data\/lot(?:_\d+)?\.json$/u),
    geometries: count(/^data\/geometry_\d+\.json$/u),
    taxes,
    property_valuations: taxes,
    sales_histories: count(/^data\/sales_history_\d+\.json$/u),
    structures: count(/^data\/structure_\d+\.json$/u),
    layouts: count(/^data\/layout_\d+\.json$/u),
    utilities: count(/^data\/utility(?:_\d+)?\.json$/u),
    deeds: count(/^data\/deed_\d+\.json$/u),
    files: count(/^data\/file_\d+\.json$/u),
    flood_storm_information: count(
      /^data\/flood_storm_information(?:_\d+)?\.json$/u,
    ),
  };
}

/**
 * Translate a stale local artifact URI into the encrypted EC2 data-volume path.
 *
 * @param uri - Loader source_artifact_uri.
 * @returns Existing EC2-local transformed ZIP path.
 */
function artifactPathOnEc2(uri: string): string {
  const marker = "/data/artifacts/";
  const markerIndex = uri.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Source artifact URI does not contain /data/artifacts/");
  }
  return `/srv/ingest/data/artifacts/${uri.slice(markerIndex + marker.length)}`;
}

/**
 * Query full county source/DB table counts.
 *
 * @param pool - Connected PostgreSQL pool.
 * @param sourceSystem - County appraiser source-system key.
 * @returns Table counts keyed by logical table name.
 */
async function loadDbCounts(
  pool: Pool,
  sourceSystem: string,
): Promise<Record<string, number>> {
  const tables = [
    "parcels",
    "properties",
    "addresses",
    "geometries",
    "taxes",
    "sales_histories",
    "structures",
    "layouts",
    "lots",
    "utilities",
    "deeds",
    "files",
    "property_valuations",
    "flood_storm_information",
    "ownerships",
  ];
  const rows: CountRow[] = [];
  for (const table of tables) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE source_system = $1`,
      [sourceSystem],
    );
    rows.push({ name: table, count: result.rows[0]?.count ?? "0" });
  }
  const enrichment = await pool.query<CountRow>(
    `SELECT 'property_improvements' AS name, count(*)::text AS count
       FROM property_improvements WHERE source_system = $1
     UNION ALL
     SELECT 'business_registrations', count(*)::text
       FROM business_registrations WHERE source_system = $1
     UNION ALL
     SELECT 'business_reputation_profiles', count(*)::text
       FROM business_reputation_profiles WHERE source_system = $1`,
    [sourceSystem],
  );
  rows.push(...enrichment.rows);
  return Object.fromEntries(
    rows.map((row) => [row.name, Number.parseInt(row.count, 10)]),
  );
}

/**
 * Validate a deterministic source-artifact sample against DB and export counts.
 *
 * @param pool - Connected PostgreSQL pool.
 * @param sourceSystem - County appraiser source-system key.
 * @param sample - Twelve manifest entries.
 * @param records - Parsed export record lookup by folio.
 * @returns Number of fully matched source artifacts.
 */
async function validateSourceSample(
  pool: Pool,
  sourceSystem: string,
  sample: readonly ManifestEntry[],
  records: ReadonlyMap<string, PublicRecord>,
): Promise<number> {
  const folios = sample.map((entry) => entry.parcelIdentifier);
  const artifacts = await pool.query<SampleArtifactRow>(
    `SELECT request_identifier, source_artifact_uri
       FROM parcels
      WHERE source_system = $1
        AND request_identifier = ANY($2::text[])`,
    [sourceSystem, folios],
  );
  const artifactMap = new Map(
    artifacts.rows.map((row) => [row.request_identifier, row.source_artifact_uri]),
  );
  const classTables = [
    "properties",
    "addresses",
    "lots",
    "geometries",
    "taxes",
    "sales_histories",
    "structures",
    "layouts",
    "utilities",
    "deeds",
    "files",
    "flood_storm_information",
  ] as const;
  let matched = 0;
  for (const entry of sample) {
    const folio = entry.parcelIdentifier;
    const uri = artifactMap.get(folio);
    const record = records.get(folio);
    if (uri === undefined || record === undefined) {
      throw new Error(`Missing sampled artifact or export for folio ${folio}`);
    }
    const zip = new AdmZip(artifactPathOnEc2(uri));
    const sourceCounts = countSourceClasses(
      zip.getEntries().map((zipEntry) => zipEntry.entryName),
    );
    for (const table of classTables) {
      const dbResult = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM ${table}
          WHERE source_system = $1
            AND request_identifier = $2`,
        [sourceSystem, folio],
      );
      const dbCount = Number.parseInt(dbResult.rows[0]?.count ?? "0", 10);
      const sourceCount = sourceCounts[table] ?? 0;
      const exportKey =
        table === "properties"
          ? null
          : table === "addresses"
            ? null
            : DB_TO_EXPORT[table as keyof typeof DB_TO_EXPORT];
      const exportCount =
        table === "properties"
          ? record.property === null
            ? 0
            : 1
          : table === "addresses"
            ? record.address === null
              ? 0
              : 1
            : exportKey === undefined
              ? 0
              : recordArray(
                  record,
                  exportKey as (typeof ARRAY_FIELDS)[number],
                ).length;
      if (sourceCount !== dbCount || dbCount !== exportCount) {
        throw new Error(
          `Sample mismatch folio=${folio} table=${table} source=${sourceCount} db=${dbCount} export=${exportCount}`,
        );
      }
    }
    const valuationResult = await pool.query<{ count: string }>(
      buildValuationCountByFolioSql(),
      [sourceSystem, folio],
    );
    const valuationCount = Number.parseInt(
      valuationResult.rows[0]?.count ?? "0",
      10,
    );
    if (
      sourceCounts.property_valuations !== valuationCount ||
      valuationCount !== recordArray(record, "valuations").length
    ) {
      throw new Error(`Sample valuation mismatch for folio ${folio}`);
    }
    matched += 1;
  }
  return matched;
}

/**
 * Run every pre-publication gate and write a durable local report.
 *
 * @param options - Expected cardinality and local artifact paths.
 * @returns Validation report suitable for the durable Publish watermark.
 */
export async function validatePublicationDryRun(
  options: PublicationValidationOptions,
): Promise<Record<string, unknown>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const sourceSystem = sourceSystemForCounty(options.county);
  const manifestPath = join(options.propertyDirectory, "manifest.json");
  const indexPath = join(options.propertyDirectory, "index.json");
  const manifestBody = await readFile(manifestPath);
  const indexBody = await readFile(indexPath);
  const manifest = JSON.parse(manifestBody.toString("utf8")) as Manifest;
  const index = JSON.parse(indexBody.toString("utf8")) as IndexFile;
  if (
    manifest.propertyCount !== options.expectedCount ||
    index.propertyCount !== options.expectedCount ||
    manifest.entries.length !== options.expectedCount
  ) {
    throw new Error("Manifest/index propertyCount does not equal expected folios");
  }
  const pool = new Pool({
    application_name: "elephant-publication-dry-run-validation",
    connectionString: databaseUrl,
    max: 3,
  });
  const exportCounts: Record<string, number> = Object.fromEntries([
    ...ARRAY_FIELDS.map((key) => [key, 0]),
    ["properties", 0],
    ["addresses", 0],
  ]);
  const recordsByFolio = new Map<string, PublicRecord>();
  let deniedPiiFindings = 0;
  let sourcePayloadsRetained = 0;
  let parcelMultiPolygons = 0;
  let multiComponentPolygons = 0;
  let geometrySourcePayloadsRetained = 0;
  let rawPolygonObservationsAcrossComponents = 0;
  let rawRingObservationsAcrossComponents = 0;
  let uniquePolygonCount = 0;
  let uniqueInteriorRingCount = 0;
  let uniqueRingCount = 0;
  let propertyCidMatches = 0;
  let totalPropertyBytes = 0;
  const exportGeometryHashesByFolio = new Map<string, string[]>();
  try {
    for (const entry of manifest.entries) {
      const body = await readFile(entry.filePath);
      totalPropertyBytes += body.byteLength;
      const sha256 = createHash("sha256").update(body).digest("hex");
      const cid = await computeIpfsCid(body);
      if (
        sha256 !== entry.sha256 ||
        cid === null ||
        cid !== entry.cid ||
        body.byteLength !== entry.fileSizeBytes
      ) {
        throw new Error(
          `Property hash/CID/size mismatch for ${entry.parcelIdentifier}`,
        );
      }
      propertyCidMatches += 1;
      const record = JSON.parse(body.toString("utf8")) as PublicRecord;
      try {
        assertPublicNonPii(record);
      } catch {
        deniedPiiFindings += 1;
        throw new Error(`Denied PII in folio ${entry.parcelIdentifier}`);
      }
      if (record.requestIdentifier !== entry.parcelIdentifier) {
        throw new Error(`Manifest identity mismatch for ${entry.parcelIdentifier}`);
      }
      if (record.sourcePayload === null || record.sourcePayload === undefined) {
        throw new Error(`Missing sourcePayload for ${entry.parcelIdentifier}`);
      }
      sourcePayloadsRetained += 1;
      if (record.property !== null && record.property !== undefined) {
        exportCounts.properties = (exportCounts.properties ?? 0) + 1;
      }
      if (record.address !== null && record.address !== undefined) {
        exportCounts.addresses = (exportCounts.addresses ?? 0) + 1;
      }
      for (const key of ARRAY_FIELDS) {
        exportCounts[key] =
          (exportCounts[key] ?? 0) + recordArray(record, key).length;
      }
      const geometryHashes: string[] = [];
      for (const [geometryIndex, geometry] of recordArray(
        record,
        "geometries",
      ).entries()) {
        if (
          !isJsonObject(geometry) ||
          geometry.sourcePayload === null ||
          geometry.sourcePayload === undefined
        ) {
          throw new Error(
            `Missing geometry sourcePayload for ${entry.parcelIdentifier} component ${geometryIndex}`,
          );
        }
        const polygons = readSourcePolygons(geometry.sourcePayload);
        if (polygons === null) {
          throw new Error(
            `Invalid geometry sourcePayload for ${entry.parcelIdentifier} component ${geometryIndex}`,
          );
        }
        geometrySourcePayloadsRetained += 1;
        rawPolygonObservationsAcrossComponents += polygons.length;
        rawRingObservationsAcrossComponents += polygons.reduce(
          (sum, polygon) => sum + polygon.length,
          0,
        );
        geometryHashes.push(canonicalJsonSha256(geometry.sourcePayload));
      }
      exportGeometryHashesByFolio.set(
        entry.parcelIdentifier,
        geometryHashes,
      );
      const uniquePolygons = readSourcePolygons(record.parcelPolygon);
      if (uniquePolygons === null) {
        throw new Error(
          `Invalid parcelPolygon for ${entry.parcelIdentifier}`,
        );
      }
      uniquePolygonCount += uniquePolygons.length;
      uniqueInteriorRingCount += uniquePolygons.reduce(
        (sum, polygon) => sum + Math.max(0, polygon.length - 1),
        0,
      );
      uniqueRingCount += uniquePolygons.reduce(
        (sum, polygon) => sum + polygon.length,
        0,
      );
      if (
        typeof record.parcelPolygon === "object" &&
        record.parcelPolygon !== null &&
        "type" in record.parcelPolygon &&
        record.parcelPolygon.type === "MultiPolygon"
      ) {
        parcelMultiPolygons += 1;
        if (
          "coordinates" in record.parcelPolygon &&
          Array.isArray(record.parcelPolygon.coordinates) &&
          record.parcelPolygon.coordinates.length > 1
        ) {
          multiComponentPolygons += 1;
        }
      }
      recordsByFolio.set(entry.parcelIdentifier, record);
    }
    if (
      propertyCidMatches !== options.expectedCount ||
      sourcePayloadsRetained !== options.expectedCount ||
      totalPropertyBytes !== manifest.totalBytes ||
      recordsByFolio.size !== options.expectedCount
    ) {
      throw new Error("Full property export reconciliation failed");
    }
    let shardPropertyCount = 0;
    let shardCidMatches = 0;
    for (const shard of index.shards) {
      const shardPath = join(
        options.propertyDirectory,
        "shards",
        `shard-${String(shard.shardIndex).padStart(4, "0")}.json`,
      );
      const shardBody = await readFile(shardPath);
      const shardCid = await computeIpfsCid(shardBody);
      if (shardCid === null || shardCid !== shard.shardCid) {
        throw new Error(`Shard CID mismatch at ${shard.shardIndex}`);
      }
      shardPropertyCount += shard.count;
      shardCidMatches += 1;
    }
    if (shardPropertyCount !== options.expectedCount) {
      throw new Error("Shard entry count does not equal expected folios");
    }
    const dbCounts = await loadDbCounts(pool, sourceSystem);
    if (dbCounts.parcels !== options.expectedCount) {
      throw new Error("DB parcel folio count does not equal expected source count");
    }
    if (geometrySourcePayloadsRetained !== dbCounts.geometries) {
      throw new Error(
        `Geometry sourcePayload cardinality mismatch: export=${geometrySourcePayloadsRetained} db=${dbCounts.geometries}`,
      );
    }
    const dbGeometryPayloads = await pool.query<GeometryPayloadRow>(
      `SELECT request_identifier, source_payload
         FROM geometries
        WHERE source_system = $1
        ORDER BY request_identifier, source_record_key`,
      [sourceSystem],
    );
    const dbGeometryOffsets = new Map<string, number>();
    let geometryDbPayloadHashesMatched = 0;
    for (const row of dbGeometryPayloads.rows) {
      const offset = dbGeometryOffsets.get(row.request_identifier) ?? 0;
      const exportHashes =
        exportGeometryHashesByFolio.get(row.request_identifier) ?? [];
      const exportHash = exportHashes[offset];
      if (
        exportHash === undefined ||
        exportHash !== canonicalJsonSha256(row.source_payload)
      ) {
        throw new Error(
          `Geometry DB/export payload mismatch for ${row.request_identifier} component ${offset}`,
        );
      }
      dbGeometryOffsets.set(row.request_identifier, offset + 1);
      geometryDbPayloadHashesMatched += 1;
    }
    if (
      dbCounts.properties !== exportCounts.properties ||
      dbCounts.addresses !== exportCounts.addresses
    ) {
      throw new Error("DB parent/address counts do not equal export counts");
    }
    for (const [dbTable, exportField] of Object.entries(DB_TO_EXPORT)) {
      if (dbCounts[dbTable] !== exportCounts[exportField]) {
        throw new Error(
          `DB/export count mismatch ${dbTable}=${dbCounts[dbTable]} export=${exportCounts[exportField]}`,
        );
      }
    }
    for (const deniedTable of [
      "ownerships",
      "property_improvements",
      "business_registrations",
      "business_reputation_profiles",
    ]) {
      if (dbCounts[deniedTable] !== 0) {
        throw new Error(
          `Denied/not-ingested table ${deniedTable} has ${dbCounts[deniedTable]} rows`,
        );
      }
    }
    const sample = selectDeterministicSample(manifest.entries, 12);
    const sampledArtifactsMatched = await validateSourceSample(
      pool,
      sourceSystem,
      sample,
      recordsByFolio,
    );
    const parquetReader = await ParquetReader.openFile(options.queryTablePath);
    let queryTableRows = 0;
    let queryTableNullFolios = 0;
    let queryTableOwnerValues = 0;
    let queryTableUnexpectedEnrichment = 0;
    const queryFolios = new Set<string>();
    try {
      const cursor = parquetReader.getCursor();
      let row = (await cursor.next()) as Record<string, unknown> | null;
      while (row !== null) {
        queryTableRows += 1;
        const folio = row.request_identifier;
        if (folio === null || folio === undefined || folio === "") {
          queryTableNullFolios += 1;
        } else {
          queryFolios.add(String(folio));
        }
        if (
          (row.owner_name !== null && row.owner_name !== undefined) ||
          (row.owners_text !== null && row.owners_text !== undefined)
        ) {
          queryTableOwnerValues += 1;
        }
        if (
          row.has_permits === true ||
          row.has_sunbiz_tenant === true ||
          row.has_bbb_contractor === true
        ) {
          queryTableUnexpectedEnrichment += 1;
        }
        row = (await cursor.next()) as Record<string, unknown> | null;
      }
    } finally {
      await parquetReader.close();
    }
    if (
      queryTableRows !== options.expectedCount ||
      queryFolios.size !== options.expectedCount ||
      queryTableNullFolios !== 0 ||
      queryTableOwnerValues !== 0 ||
      queryTableUnexpectedEnrichment !== 0
    ) {
      throw new Error("Query-table cardinality or public-data gate failed");
    }
    const coverageBody = await readFile(options.coveragePath);
    const coverage = JSON.parse(coverageBody.toString("utf8")) as {
      readonly county?: unknown;
      readonly datasets?: ReadonlyArray<Record<string, unknown>>;
    };
    const coverageRows = new Map(
      (coverage.datasets ?? []).map((row) => [String(row.source), row]),
    );
    const appraisalCoverage = coverageRows.get("appraisal");
    if (
      coverage.county !== options.county ||
      appraisalCoverage?.ingested_count !== options.expectedCount ||
      appraisalCoverage.expected_count !== options.expectedCount
    ) {
      throw new Error("Coverage appraisal completeness is incorrect");
    }
    const expectedCoverageCounts = {
      permits: options.expectedPermitCount,
      corporate: options.expectedCorporateCount,
      bbb: options.expectedBbbCount,
      overture_places: options.expectedOverturePlacesCount,
    };
    for (const [track, expectedIngestedCount] of Object.entries(
      expectedCoverageCounts,
    )) {
      assertPublishedCoverageTrack(
        track,
        coverageRows.get(track),
        expectedIngestedCount,
      );
    }
    const indexCid = await computeIpfsCid(indexBody);
    const manifestCid = await computeIpfsCid(manifestBody);
    const queryTableBody = await readFile(options.queryTablePath);
    const queryTableCid = await computeIpfsCid(queryTableBody);
    const coverageCid = await computeIpfsCid(coverageBody);
    if (
      indexCid === null ||
      manifestCid === null ||
      queryTableCid === null ||
      coverageCid === null
    ) {
      throw new Error("One or more local publication CIDs could not be computed");
    }
    const report = {
      schemaVersion: "1",
      county: options.county,
      approved: false,
      pending: true,
      objectUploadsPerformed: 0,
      ipnsMutationsPerformed: 0,
      expectedFolios: options.expectedCount,
      sourceFolioCount: dbCounts.parcels,
      dbCounts,
      exportCounts,
      propertyFiles: manifest.entries.length,
      propertyBytes: totalPropertyBytes,
      propertyCidMatches,
      sourcePayloadsRetained,
      geometrySourcePayloadsRetained,
      geometryDbPayloadHashesMatched,
      rawPolygonObservationsAcrossComponents,
      rawRingObservationsAcrossComponents,
      uniquePolygonCount,
      uniqueExteriorRingCount: uniquePolygonCount,
      uniqueInteriorRingCount,
      uniqueRingCount,
      deniedPiiFindings,
      parcelMultiPolygons,
      multiComponentPolygons,
      shardCount: index.shards.length,
      shardCidMatches,
      queryTableRows,
      queryTableDistinctFolios: queryFolios.size,
      queryTableNullFolios,
      queryTableOwnerValues,
      queryTableUnexpectedEnrichment,
      sampledArtifactsMatched,
      coverageTracks: Object.fromEntries(
        [...coverageRows].map(([name, row]) => [
          name,
          {
            ingestedCount: row.ingested_count,
            expectedCount: row.expected_count,
          },
        ]),
      ),
      files: {
        manifest: {
          path: manifestPath,
          bytes: manifestBody.byteLength,
          cid: manifestCid,
        },
        index: {
          path: indexPath,
          bytes: indexBody.byteLength,
          cid: indexCid,
        },
        queryTable: {
          path: options.queryTablePath,
          bytes: (await stat(options.queryTablePath)).size,
          cid: queryTableCid,
        },
        coverage: {
          path: options.coveragePath,
          bytes: coverageBody.byteLength,
          cid: coverageCid,
        },
      },
      validatedAt: new Date().toISOString(),
    };
    await writeFile(
      options.reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        event: "publication_dry_run_validation_passed",
        reportPath: options.reportPath,
        indexCid,
        queryTableCid,
        coverageCid,
      }),
    );
    return report;
  } finally {
    await pool.end();
  }
}

/**
 * Execute the full validator when invoked directly.
 *
 * @returns A promise that resolves only after every gate passes.
 */
async function main(): Promise<void> {
  await validatePublicationDryRun(
    parsePublicationValidationOptions(process.argv.slice(2)),
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
        event: "publication_dry_run_validation_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
