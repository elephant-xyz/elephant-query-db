import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import AdmZip from "adm-zip";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { from as copyFrom } from "pg-copy-streams";
import { Pool, type PoolClient } from "pg";

import {
  BULK_STAGE_COLUMNS,
  addSunbizAddressReferencesToRows,
  assertAppraisalPrefixIsScoped,
  buildAppraisalTransformedArtifactUri,
  buildScopedLoadSelectionFromManifest,
  createBulkStageTable,
  createS3ArtifactReader,
  expandBbbBusinessProfileRecords,
  isLeePermitRecordSelected,
  isSunbizAddressRecordSelected,
  isSunbizClassRecordSelected,
  mapAppraisalTransformedFile,
  mapBbbBusinessProfile,
  mapLeePermitDetail,
  mapSunbizAnnualReportsFromRegistration,
  mapSunbizClassRecord,
  mergeBulkStageTable,
  parseS3Uri,
  preparedRowsContainSelectedParcel,
  readBulkTableColumns,
  readJsonArtifactRecords,
  readSunbizAddressSourceRecordKey,
  readSunbizRelatedAddressPair,
  serializeBulkStageCsvHeader,
  serializeBulkStageCsvRow,
  type BulkMergeResult,
  type JsonObject,
  type LogicalTableName,
  type PreparedRow,
  type QueryClient,
  type QueryRowsResult,
  type ScopedLoadSelection,
  type SunbizRelatedAddressPair,
  type SunbizClassType,
  type TextArtifactReader,
} from "../src/loader/index.js";

type TrackName = "appraisal" | "bbb" | "permits" | "sunbiz";

type BulkLoaderPhase = "all" | "stage" | "load";

type BulkLoaderOptions = {
  readonly appraisalPrefix: string;
  readonly bbbPrefix: string;
  readonly bucket: string;
  readonly concurrency: number;
  readonly envFile: string;
  readonly limit: number | null;
  readonly permitPrefix: string;
  readonly phase: BulkLoaderPhase;
  readonly stageDir: string;
  readonly stageFile: string | null;
  readonly scopeManifest: string | null;
  readonly sunbizPrefix: string;
  readonly tracks: readonly TrackName[];
};

type MutableBulkCounters = {
  inputRecords: number;
  preparedRows: number;
  skippedRecords: number;
  stagedRows: number;
  completedArtifacts: number;
  failedArtifacts: number;
  filteredRecords: number;
  missingArtifacts: number;
};

type StageArtifactResult = {
  readonly filteredRecords: number;
  readonly inputRecords: number;
  readonly preparedRows: number;
  readonly skippedRecords: number;
};

type S3ObjectListing = {
  readonly uri: string;
  readonly size: number | null;
};

type S3BodyWithByteArray = {
  readonly transformToByteArray: () => Promise<Uint8Array>;
};

type DatabaseQueryRunner = {
  readonly query: <Row extends JsonObject = JsonObject>(
    text: string,
    values: readonly unknown[],
  ) => Promise<QueryRowsResult<Row>>;
};

type ScopedSunbizPlan = {
  readonly addressSourceRecordKeyByRelatedSourceRecordKey: ReadonlyMap<string, string>;
  readonly selectedAddressSourceRecordKeys: ReadonlySet<string>;
  readonly selectedDocumentNumbers: ReadonlySet<string>;
};

const DEFAULT_BUCKET = "elephant-oracle-node-environmentbucket-mmsoo3xbdi80";
const DEFAULT_APPRAISAL_PREFIX = "outputs/";
const DEFAULT_PERMIT_PREFIX =
  "permit-harvest/lee-permit-backfill-20260525/lee/extracted/permits/";
const DEFAULT_SUNBIZ_PREFIX =
  "permit-harvest/sunbiz-lee-corporate-quarterly-2026q2-expanded/lexicon-transform/business-registration-v1/classes/";
const DEFAULT_BBB_PREFIX = "permit-harvest/bbb/category-data/browser-harvest-v1/profiles/";
const DEFAULT_STAGE_DIR = ".loader-runs/bulk-staging";
const STAGE_TABLE_NAME = "elephant_bulk_stage_rows";

const APPRAISAL_TABLE_ORDER: readonly LogicalTableName[] = [
  "unnormalized_addresses",
  "addresses",
  "parcels",
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

const PERMIT_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "people",
  "companies",
  "property_improvements",
  "permit_contacts",
  "inspections",
  "permit_events",
  "permit_fees",
  "permit_links",
  "permit_custom_fields",
  "permit_list_windows",
];

const SUNBIZ_CLASS_ORDER: readonly SunbizClassType[] = [
  "address",
  "company",
  "business_registration",
  "business_registration_address",
  "business_registration_party",
];

const SUNBIZ_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "companies",
  "business_registrations",
  "business_registration_annual_reports",
  "business_registration_addresses",
  "business_registration_parties",
];

const BBB_TABLE_ORDER: readonly LogicalTableName[] = [
  "addresses",
  "companies",
  "people",
  "business_reputation_profiles",
  "business_reputation_alternate_names",
  "business_reputation_categories",
  "business_reputation_rating_reasons",
  "business_reputation_contacts",
  "business_reputation_licenses",
  "business_reputation_service_areas",
  "business_reputation_locations",
  "business_reputation_reviews",
  "business_reputation_complaints",
  "business_reputation_complaint_events",
  "business_reputation_media",
  "business_reputation_external_links",
  "contractor_quality_scores",
];

/**
 * Run the local bulk loader from S3 artifacts into Neon/Postgres.
 *
 * The loader stages mapper output into one local CSV file, streams that file into
 * a temporary JSONB staging table with PostgreSQL `COPY FROM STDIN`, and then
 * performs set-based idempotent merges into the final logical tables.
 *
 * @returns Promise that resolves once the selected phase completes.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile} or the environment`);
  }

  const stageFile = options.stageFile ?? buildDefaultStageFile(options.stageDir);
  const scopeSelection = options.scopeManifest === null
    ? null
    : loadScopedSelection(options.scopeManifest);
  const counters = emptyCounters();
  console.log(JSON.stringify({
    event: "bulk_loader_started",
    options: redactedOptions(options),
    scope: scopeSelection === null
      ? null
      : {
          appraisalArtifactUriCount: scopeSelection.appraisalArtifactUris.size,
          addressBaseCount: scopeSelection.addressBases.size,
          parcelIdentifierCount: scopeSelection.parcelIdentifiers.size,
          sourceCandidateCount: scopeSelection.sourceCandidateCount,
        },
    stageFile,
  }));

  if (options.phase === "all" || options.phase === "stage") {
    await stageSelectedTracks({ counters, options, scopeSelection, stageFile });
  }
  if (options.phase === "all" || options.phase === "load") {
    const mergeResults = await copyAndMergeStageFile({
      databaseUrl,
      stageFile,
      tableOrder: tableOrderForTracks(options.tracks),
    });
    console.log(JSON.stringify({ event: "bulk_merge_finished", mergeResults }));
  }

  console.log(JSON.stringify({ event: "bulk_loader_finished", counters, stageFile }));
}

/**
 * Transform selected S3 artifacts through the existing source mappers into a local CSV file.
 *
 * @param params - Loader options, mutable counters, and the target staging file path.
 * @returns Promise that resolves after all selected tracks have been staged.
 */
async function stageSelectedTracks(params: {
  readonly counters: MutableBulkCounters;
  readonly options: BulkLoaderOptions;
  readonly scopeSelection: ScopedLoadSelection | null;
  readonly stageFile: string;
}): Promise<void> {
  await mkdir(dirname(params.stageFile), { recursive: true });
  const s3 = new S3Client({});
  const writer = createWriteStream(params.stageFile, { encoding: "utf8", flags: "w" });
  let nextRowIndex = 1;

  try {
    writer.write(serializeBulkStageCsvHeader());
    const writeRows = async (rows: readonly PreparedRow[]): Promise<void> => {
      let chunk = "";
      for (const row of rows) {
        chunk += serializeBulkStageCsvRow({ rowIndex: nextRowIndex, row });
        nextRowIndex += 1;
        params.counters.stagedRows += 1;
      }
      if (chunk.length > 0 && !writer.write(chunk)) await onceDrain(writer);
    };

    if (params.options.tracks.includes("appraisal")) {
      await stageAppraisal({ ...params, s3, writeRows });
    }
    if (params.options.tracks.includes("permits")) {
      await stagePermits({ ...params, s3, writeRows });
    }
    if (params.options.tracks.includes("sunbiz")) {
      await stageSunbiz({ ...params, s3, writeRows });
    }
    if (params.options.tracks.includes("bbb")) {
      await stageBbb({ ...params, s3, writeRows });
    }
  } finally {
    writer.end();
    await onceFinish(writer);
  }
}

/**
 * Stage Lee appraiser transformed ZIP artifacts into the generic CSV file.
 *
 * @param params - Shared S3 client, options, counters, and row writer callback.
 * @returns Promise that resolves after appraisal artifacts have been visited.
 */
async function stageAppraisal(params: {
  readonly counters: MutableBulkCounters;
  readonly options: BulkLoaderOptions;
  readonly scopeSelection: ScopedLoadSelection | null;
  readonly s3: S3Client;
  readonly writeRows: (rows: readonly PreparedRow[]) => Promise<void>;
}): Promise<void> {
  assertAppraisalPrefixIsScoped(params.options.appraisalPrefix);
  console.log(JSON.stringify({ event: "bulk_track_started", track: "appraisal" }));
  const artifactCount = await processAsyncIterable(
    listAppraisalArtifacts({
      bucket: params.options.bucket,
      limit: params.options.limit,
      prefix: params.options.appraisalPrefix,
      s3: params.s3,
    }),
    params.options.concurrency,
    async (artifact) => {
      await stageArtifact(params, artifact.uri, async () => {
        const buffer = await readS3ObjectBuffer(params.s3, artifact.uri);
        const zip = new AdmZip(buffer);
        const rows: PreparedRow[] = [];
        let skippedRecords = 0;
        const entries = zip
          .getEntries()
          .filter((entry) => entry.isDirectory === false && /^data\/.+\.json$/.test(entry.entryName))
          .sort((left, right) => left.entryName.localeCompare(right.entryName));

        for (const entry of entries) {
          const text = entry.getData().toString("utf8");
          const record: unknown = JSON.parse(text);
          const bundle = mapAppraisalTransformedFile({
            artifactUri: artifact.uri,
            filePath: entry.entryName,
            record,
          });
          rows.push(...bundle.rows);
          skippedRecords += bundle.skippedRecords.length;
          params.counters.inputRecords += 1;
        }

        if (
          params.scopeSelection !== null &&
          !preparedRowsContainSelectedParcel(rows, params.scopeSelection)
        ) {
          params.counters.filteredRecords += entries.length;
          params.counters.skippedRecords += skippedRecords;
          return {
            filteredRecords: entries.length,
            inputRecords: entries.length,
            preparedRows: 0,
            skippedRecords,
          };
        }

        const sortedRows = sortRows(rows, APPRAISAL_TABLE_ORDER);
        await params.writeRows(sortedRows);
        params.counters.preparedRows += rows.length;
        params.counters.skippedRecords += skippedRecords;
        return {
          filteredRecords: 0,
          inputRecords: entries.length,
          preparedRows: rows.length,
          skippedRecords,
        };
      });
    },
  );
  console.log(JSON.stringify({ event: "bulk_track_finished", track: "appraisal", artifactCount }));
}

/**
 * Stage Lee Accela permit detail JSON artifacts into the generic CSV file.
 *
 * @param params - Shared S3 client, options, counters, and row writer callback.
 * @returns Promise that resolves after permit artifacts have been visited.
 */
async function stagePermits(params: {
  readonly counters: MutableBulkCounters;
  readonly options: BulkLoaderOptions;
  readonly scopeSelection: ScopedLoadSelection | null;
  readonly s3: S3Client;
  readonly writeRows: (rows: readonly PreparedRow[]) => Promise<void>;
}): Promise<void> {
  const reader = createS3ArtifactReader({ client: params.s3 });
  const artifacts = await listS3Objects({
    bucket: params.options.bucket,
    limit: params.options.limit,
    prefix: params.options.permitPrefix,
    s3: params.s3,
    suffix: ".json",
  });
  console.log(JSON.stringify({ event: "bulk_track_started", track: "permits", artifactCount: artifacts.length }));

  await processIterable(artifacts, params.options.concurrency, async (artifact) => {
    await stageArtifact(params, artifact.uri, async () => {
      const records = await readJsonArtifactRecords(reader, artifact.uri, "json");
      const rows: PreparedRow[] = [];
      let filteredRecords = 0;
      let skippedRecords = 0;
      for (const record of records) {
        if (
          params.scopeSelection !== null &&
          !isLeePermitRecordSelected(record.record, params.scopeSelection)
        ) {
          filteredRecords += 1;
          continue;
        }
        const bundle = mapLeePermitDetail({ artifactUri: artifact.uri, record: record.record });
        rows.push(...bundle.rows);
        skippedRecords += bundle.skippedRecords.length;
      }
      const sortedRows = sortRows(rows, PERMIT_TABLE_ORDER);
      await params.writeRows(sortedRows);
      params.counters.inputRecords += records.length;
      params.counters.preparedRows += rows.length;
      params.counters.filteredRecords += filteredRecords;
      params.counters.skippedRecords += skippedRecords;
      return {
        filteredRecords,
        inputRecords: records.length,
        preparedRows: rows.length,
        skippedRecords,
      };
    });
  });
  console.log(JSON.stringify({ event: "bulk_track_finished", track: "permits", artifactCount: artifacts.length }));
}

/**
 * Stage Sunbiz transformed JSONL class artifacts into the generic CSV file.
 *
 * @param params - Shared S3 client, options, counters, and row writer callback.
 * @returns Promise that resolves after Sunbiz class artifacts have been visited.
 */
async function stageSunbiz(params: {
  readonly counters: MutableBulkCounters;
  readonly options: BulkLoaderOptions;
  readonly scopeSelection: ScopedLoadSelection | null;
  readonly s3: S3Client;
  readonly writeRows: (rows: readonly PreparedRow[]) => Promise<void>;
}): Promise<void> {
  const reader = createS3ArtifactReader({ client: params.s3 });
  const scopedPlan = params.scopeSelection === null
    ? null
    : await buildScopedSunbizPlan({
        bucket: params.options.bucket,
        reader,
        s3: params.s3,
        selection: params.scopeSelection,
        sunbizPrefix: params.options.sunbizPrefix,
      });
  const addressSourceRecordKeyByRelatedSourceRecordKey = scopedPlan === null
    ? await buildFullSunbizAddressReferenceMap({
        bucket: params.options.bucket,
        reader,
        s3: params.s3,
        sunbizPrefix: params.options.sunbizPrefix,
      })
    : scopedPlan.addressSourceRecordKeyByRelatedSourceRecordKey;
  for (const classType of SUNBIZ_CLASS_ORDER) {
    const artifacts = await listS3Objects({
      bucket: params.options.bucket,
      limit: params.options.limit,
      prefix: `${params.options.sunbizPrefix}${classType}/`,
      s3: params.s3,
      suffix: ".jsonl",
    });
    console.log(JSON.stringify({ event: "bulk_class_started", track: "sunbiz", classType, artifactCount: artifacts.length }));

    for (const artifact of artifacts) {
      await stageArtifact(params, artifact.uri, async () => {
        const records = await readJsonArtifactRecords(reader, artifact.uri, "jsonl");
        let filteredRecords = 0;
        let preparedRows = 0;
        let skippedRecords = 0;
        for (const record of records) {
          if (
            scopedPlan !== null &&
            !isSunbizClassRecordSelected({
              classType,
              record: record.record,
              selectedAddressSourceRecordKeys: scopedPlan.selectedAddressSourceRecordKeys,
              selectedDocumentNumbers: scopedPlan.selectedDocumentNumbers,
            })
          ) {
            filteredRecords += 1;
            continue;
          }
          const classBundle = mapSunbizClassRecord({
            artifactUri: artifact.uri,
            classType,
            record: record.record,
          });
          const annualReportBundle =
            classType === "business_registration"
              ? mapSunbizAnnualReportsFromRegistration({
                  artifactUri: artifact.uri,
                  record: record.record,
                })
              : { rows: [], skippedRecords: [] };
          const rows = sortRows(
            addSunbizAddressReferencesToRows(
              [...classBundle.rows, ...annualReportBundle.rows],
              addressSourceRecordKeyByRelatedSourceRecordKey,
            ),
            SUNBIZ_TABLE_ORDER,
          );
          await params.writeRows(rows);
          preparedRows += rows.length;
          skippedRecords += classBundle.skippedRecords.length + annualReportBundle.skippedRecords.length;
        }
        params.counters.inputRecords += records.length;
        params.counters.preparedRows += preparedRows;
        params.counters.filteredRecords += filteredRecords;
        params.counters.skippedRecords += skippedRecords;
        return {
          filteredRecords,
          inputRecords: records.length,
          preparedRows,
          skippedRecords,
        };
      });
    }
    console.log(JSON.stringify({ event: "bulk_class_finished", track: "sunbiz", classType, artifactCount: artifacts.length }));
  }
}

/**
 * Stage BBB business-profile JSON/JSONL artifacts into the generic CSV file.
 *
 * BBB inputs are expected to be profile artifacts already staged in S3, either
 * from the oracle-node browser harvester or from a compatible feed/export. The
 * mapper preserves the full source profile JSON in
 * `business_reputation_profiles.source_payload` and emits normalized child rows
 * for known repeatable profile sections.
 *
 * @param params - Shared S3 client, options, counters, and row writer callback.
 * @returns Promise that resolves after BBB profile artifacts have been visited.
 */
async function stageBbb(params: {
  readonly counters: MutableBulkCounters;
  readonly options: BulkLoaderOptions;
  readonly s3: S3Client;
  readonly writeRows: (rows: readonly PreparedRow[]) => Promise<void>;
}): Promise<void> {
  const reader = createS3ArtifactReader({ client: params.s3 });
  const artifacts = await listS3Objects({
    bucket: params.options.bucket,
    limit: params.options.limit,
    prefix: params.options.bbbPrefix,
    s3: params.s3,
    suffix: [".json", ".jsonl"],
  });
  console.log(JSON.stringify({ event: "bulk_track_started", track: "bbb", artifactCount: artifacts.length }));

  await processIterable(artifacts, params.options.concurrency, async (artifact) => {
    await stageArtifact(params, artifact.uri, async () => {
      const artifactRecords = await readJsonArtifactRecords(reader, artifact.uri, "auto");
      const rows: PreparedRow[] = [];
      let inputRecords = 0;
      let skippedRecords = 0;
      for (const artifactRecord of artifactRecords) {
        const profileRecords = expandBbbBusinessProfileRecords(artifactRecord.record);
        inputRecords += profileRecords.length;
        for (const profileRecord of profileRecords) {
          const bundle = mapBbbBusinessProfile({ artifactUri: artifact.uri, record: profileRecord });
          rows.push(...bundle.rows);
          skippedRecords += bundle.skippedRecords.length;
        }
      }
      const sortedRows = sortRows(rows, BBB_TABLE_ORDER);
      await params.writeRows(sortedRows);
      params.counters.inputRecords += inputRecords;
      params.counters.preparedRows += rows.length;
      params.counters.skippedRecords += skippedRecords;
      return {
        filteredRecords: 0,
        inputRecords,
        preparedRows: rows.length,
        skippedRecords,
      };
    });
  });
  console.log(JSON.stringify({ event: "bulk_track_finished", track: "bbb", artifactCount: artifacts.length }));
}

/**
 * Build the complete Sunbiz row-to-address reference map from transform relationship files.
 *
 * Full Sunbiz loads do not use the scoped-property filter, but they still need
 * the transform's relationship files to collapse graph edges into direct
 * `address_id` foreign keys on logical registration-address and party tables.
 *
 * @param params - S3 reader/client, Sunbiz class prefix, and bucket.
 * @returns Map from a business-registration child source key to its address source key.
 */
async function buildFullSunbizAddressReferenceMap(params: {
  readonly bucket: string;
  readonly reader: TextArtifactReader;
  readonly s3: S3Client;
  readonly sunbizPrefix: string;
}): Promise<ReadonlyMap<string, string>> {
  const addressSourceRecordKeyByRelatedSourceRecordKey = new Map<string, string>();
  await scanSunbizAddressRelationships(params, async (pair) => {
    addressSourceRecordKeyByRelatedSourceRecordKey.set(
      pair.relatedSourceRecordKey,
      pair.addressSourceRecordKey,
    );
  });
  console.log(JSON.stringify({
    event: "bulk_sunbiz_full_address_reference_map_built",
    relationshipAddressReferenceCount: addressSourceRecordKeyByRelatedSourceRecordKey.size,
  }));
  return addressSourceRecordKeyByRelatedSourceRecordKey;
}

/**
 * Build the relationship-derived Sunbiz scope for the selected property address bases.
 *
 * The class files alone cannot tell which `business_registration_address` or
 * `business_registration_party` row owns a normalized `address` row; that link is
 * represented in relationship files. This pass first finds address vertices that
 * match selected property address bases, then promotes all documents touching
 * those addresses, and finally gathers every address relationship for those
 * documents so direct address foreign keys can be resolved during the merge.
 *
 * @param params - S3 reader/client, Sunbiz prefix, bucket, and selected address bases.
 * @returns Document and address-key sets used to filter Sunbiz class rows.
 */
async function buildScopedSunbizPlan(params: {
  readonly bucket: string;
  readonly reader: TextArtifactReader;
  readonly s3: S3Client;
  readonly selection: ScopedLoadSelection;
  readonly sunbizPrefix: string;
}): Promise<ScopedSunbizPlan> {
  const propertyMatchedAddressSourceKeys = await readSelectedSunbizAddressSourceKeys(params);
  const selectedDocumentNumbers = new Set<string>();

  await scanSunbizAddressRelationships(params, async (pair) => {
    if (propertyMatchedAddressSourceKeys.has(pair.addressSourceRecordKey)) {
      selectedDocumentNumbers.add(pair.documentNumber);
    }
  });

  const selectedAddressSourceRecordKeys = new Set<string>(propertyMatchedAddressSourceKeys);
  const addressSourceRecordKeyByRelatedSourceRecordKey = new Map<string, string>();
  await scanSunbizAddressRelationships(params, async (pair) => {
    if (!selectedDocumentNumbers.has(pair.documentNumber)) return;
    addressSourceRecordKeyByRelatedSourceRecordKey.set(
      pair.relatedSourceRecordKey,
      pair.addressSourceRecordKey,
    );
    selectedAddressSourceRecordKeys.add(pair.addressSourceRecordKey);
  });

  console.log(JSON.stringify({
    event: "bulk_sunbiz_scope_built",
    selectedAddressSourceKeyCount: selectedAddressSourceRecordKeys.size,
    selectedDocumentCount: selectedDocumentNumbers.size,
    relationshipAddressReferenceCount: addressSourceRecordKeyByRelatedSourceRecordKey.size,
  }));

  return {
    addressSourceRecordKeyByRelatedSourceRecordKey,
    selectedAddressSourceRecordKeys,
    selectedDocumentNumbers,
  };
}

/**
 * Read Sunbiz address class records and keep those whose street base matches the selected properties.
 *
 * @param params - S3 reader/client, Sunbiz prefix, bucket, and selected address bases.
 * @returns Set of Sunbiz address source keys that directly match selected property addresses.
 */
async function readSelectedSunbizAddressSourceKeys(params: {
  readonly bucket: string;
  readonly reader: TextArtifactReader;
  readonly s3: S3Client;
  readonly selection: ScopedLoadSelection;
  readonly sunbizPrefix: string;
}): Promise<ReadonlySet<string>> {
  const selectedAddressSourceKeys = new Set<string>();
  const artifacts = await listS3Objects({
    bucket: params.bucket,
    limit: null,
    prefix: `${params.sunbizPrefix}address/`,
    s3: params.s3,
    suffix: ".jsonl",
  });
  for (const artifact of artifacts) {
    const records = await readJsonArtifactRecords(params.reader, artifact.uri, "jsonl");
    for (const record of records) {
      if (!isSunbizAddressRecordSelected(record.record, params.selection)) continue;
      const addressSourceRecordKey = readSunbizAddressSourceRecordKey(record.record);
      if (addressSourceRecordKey !== null) selectedAddressSourceKeys.add(addressSourceRecordKey);
    }
  }
  console.log(JSON.stringify({
    addressBaseCount: params.selection.addressBases.size,
    event: "bulk_sunbiz_address_scope_read",
    matchingAddressSourceKeyCount: selectedAddressSourceKeys.size,
  }));
  return selectedAddressSourceKeys;
}

/**
 * Visit Sunbiz address relationship JSONL records and call a handler for relevant pairs.
 *
 * @param params - S3 reader/client, Sunbiz prefix, and bucket.
 * @param handler - Callback invoked for each registration-address/party-to-address pair.
 * @returns Promise that resolves once both address relationship groups have been scanned.
 */
async function scanSunbizAddressRelationships(
  params: {
    readonly bucket: string;
    readonly reader: TextArtifactReader;
    readonly s3: S3Client;
    readonly sunbizPrefix: string;
  },
  handler: (pair: SunbizRelatedAddressPair) => Promise<void>,
): Promise<void> {
  for (const relationshipType of [
    "business_registration_address_has_address",
    "business_registration_party_has_address",
  ] as const) {
    const artifacts = await listS3Objects({
      bucket: params.bucket,
      limit: null,
      prefix: deriveSunbizRelationshipPrefix(params.sunbizPrefix, relationshipType),
      s3: params.s3,
      suffix: ".jsonl",
    });
    for (const artifact of artifacts) {
      const records = await readJsonArtifactRecords(params.reader, artifact.uri, "jsonl");
      for (const record of records) {
        const pair = readSunbizRelatedAddressPair(record.record);
        if (pair !== null) await handler(pair);
      }
    }
  }
}

/**
 * Derive a relationship class prefix from the configured Sunbiz class prefix.
 *
 * @param sunbizPrefix - Configured class prefix ending in `classes/`.
 * @param relationshipType - Relationship subdirectory name.
 * @returns S3 key prefix for the requested relationship type.
 */
function deriveSunbizRelationshipPrefix(
  sunbizPrefix: string,
  relationshipType: string,
): string {
  const normalizedPrefix = sunbizPrefix.endsWith("/") ? sunbizPrefix : `${sunbizPrefix}/`;
  const classSuffix = "classes/";
  if (!normalizedPrefix.endsWith(classSuffix)) {
    throw new Error(`--sunbiz-prefix must end with ${classSuffix} when --scope-manifest is used`);
  }
  return `${normalizedPrefix.slice(0, -classSuffix.length)}relationships/${relationshipType}/`;
}

/**
 * Stage one artifact and record success/failure counters without aborting the full run.
 *
 * @param params - Mutable counters updated for completed and failed artifacts.
 * @param artifactUri - S3 URI currently being transformed.
 * @param callback - Artifact-specific transform and CSV-write callback.
 * @returns Promise that resolves after the artifact is staged or recorded as failed.
 */
async function stageArtifact(
  params: {
    readonly counters: MutableBulkCounters;
  },
  artifactUri: string,
  callback: () => Promise<StageArtifactResult>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await callback();
    params.counters.completedArtifacts += 1;
    console.log(JSON.stringify({
      event: "bulk_artifact_staged",
      artifactUri,
      elapsedMs: Date.now() - startedAt,
      ...result,
    }));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (isS3NotFoundError(caught)) {
      params.counters.missingArtifacts += 1;
      console.log(JSON.stringify({ event: "bulk_artifact_missing", artifactUri, error: message }));
      return;
    }
    params.counters.failedArtifacts += 1;
    console.error(JSON.stringify({ event: "bulk_artifact_failed", artifactUri, error: message }));
  }
}

/**
 * Copy the staged CSV file into a temporary PostgreSQL table and merge final tables.
 *
 * @param params - Database connection string, local stage file path, and merge table order.
 * @returns Per-table merge counters in dependency order.
 */
async function copyAndMergeStageFile(params: {
  readonly databaseUrl: string;
  readonly stageFile: string;
  readonly tableOrder: readonly LogicalTableName[];
}): Promise<readonly BulkMergeResult[]> {
  const pool = new Pool({
    application_name: "elephant-query-bulk-loader",
    connectionString: params.databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  pool.on("error", (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "bulk_database_pool_error", error: message }));
  });

  const client = await pool.connect();
  const queryClient = createQueryClient(client);
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await createBulkStageTable(queryClient, STAGE_TABLE_NAME);
    await copyStageCsv(client, STAGE_TABLE_NAME, params.stageFile);
    const columnsByTable = await readBulkTableColumns(queryClient, params.tableOrder);
    const results: BulkMergeResult[] = [];
    for (const tableName of params.tableOrder) {
      const columns = columnsByTable.get(tableName);
      if (columns === undefined) throw new Error(`Missing columns for ${tableName}`);
      const result = await mergeBulkStageTable(queryClient, {
        stageTableName: STAGE_TABLE_NAME,
        tableName,
        columns,
      });
      results.push(result);
      console.log(JSON.stringify({ event: "bulk_table_merged", ...result }));
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return results;
  } catch (caught) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackCaught) {
        const message = rollbackCaught instanceof Error ? rollbackCaught.message : String(rollbackCaught);
        console.error(JSON.stringify({ event: "bulk_transaction_rollback_failed", error: message }));
      }
    }
    throw caught;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Stream a local bulk-stage CSV file into the active PostgreSQL staging table.
 *
 * @param client - Raw pg client because `COPY FROM STDIN` uses the pg submittable stream API.
 * @param stageTableName - Temporary stage table name created earlier on the same connection.
 * @param stageFile - Local CSV file path to stream.
 * @returns Promise that resolves when PostgreSQL has accepted the full CSV stream.
 */
async function copyStageCsv(
  client: PoolClient,
  stageTableName: string,
  stageFile: string,
): Promise<void> {
  const stageTable = quoteIdentifier(stageTableName);
  const columnsSql = BULK_STAGE_COLUMNS.map(quoteIdentifier).join(", ");
  const copySql = `COPY ${stageTable} (${columnsSql}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;
  const copyStream = client.query(copyFrom(copySql));
  await pipeline(createReadStream(stageFile), copyStream);
  console.log(JSON.stringify({ event: "bulk_stage_copied", stageFile }));
}

/**
 * List transformed appraisal artifact URIs from immediate `.csv/` child prefixes.
 *
 * The appraiser workflow stores query-db-ready artifacts at
 * `<outputs>/<parcel>.csv/transformed_output.zip`. This generator uses S3
 * delimiter pagination so it does not recurse into every object below each
 * parcel folder while discovering candidate artifacts.
 *
 * @param params - S3 client, bucket, prefix, and optional artifact limit.
 * @yields Appraisal transformed artifact URI listings in S3 listing order.
 */
async function* listAppraisalArtifacts(params: {
  readonly bucket: string;
  readonly limit: number | null;
  readonly prefix: string;
  readonly s3: S3Client;
}): AsyncGenerator<S3ObjectListing> {
  let continuationToken: string | undefined;
  let yielded = 0;
  do {
    const response = await params.s3.send(new ListObjectsV2Command({
      Bucket: params.bucket,
      Prefix: params.prefix,
      Delimiter: "/",
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const commonPrefix of response.CommonPrefixes ?? []) {
      const artifactUri = buildAppraisalTransformedArtifactUri({
        bucket: params.bucket,
        commonPrefix: commonPrefix.Prefix,
      });
      if (artifactUri === null) continue;
      yield {
        uri: artifactUri,
        size: null,
      };
      yielded += 1;
      if (params.limit !== null && yielded >= params.limit) return;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
}

/**
 * List S3 object URIs under a prefix with optional suffix filtering.
 *
 * @param params - S3 client, bucket, prefix, suffix, and optional object limit.
 * @returns Object URI listings sorted by S3 listing order.
 */
async function listS3Objects(params: {
  readonly bucket: string;
  readonly limit: number | null;
  readonly prefix: string;
  readonly s3: S3Client;
  readonly suffix: string | readonly string[];
}): Promise<readonly S3ObjectListing[]> {
  const objects: S3ObjectListing[] = [];
  const suffixes = typeof params.suffix === "string" ? [params.suffix] : params.suffix;
  let continuationToken: string | undefined;
  do {
    const response = await params.s3.send(new ListObjectsV2Command({
      Bucket: params.bucket,
      Prefix: params.prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (key === undefined || !suffixes.some((suffix) => key.endsWith(suffix))) continue;
      objects.push({
        uri: `s3://${params.bucket}/${key}`,
        size: object.Size ?? null,
      });
      if (params.limit !== null && objects.length >= params.limit) return objects;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  return objects;
}

/**
 * Download an S3 object body as a Node buffer for ZIP processing.
 *
 * @param s3 - AWS SDK S3 client.
 * @param artifactUri - S3 URI of the ZIP artifact to download.
 * @returns Promise resolving to the object body bytes.
 */
async function readS3ObjectBuffer(s3: S3Client, artifactUri: string): Promise<Buffer> {
  const { bucket, key } = parseS3Uri(artifactUri);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body: unknown = response.Body;
  if (body === undefined) throw new Error(`S3 object had no body: ${artifactUri}`);
  if (isS3BodyWithByteArray(body)) {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }
  throw new Error(`Unsupported S3 body type for ${artifactUri}`);
}

/**
 * Adapt a pg client into the narrow query interface used by loader helpers.
 *
 * @param runner - Database runner with a `pg`-compatible query method.
 * @returns Query client that always returns a readonly row array.
 */
function createQueryClient(runner: DatabaseQueryRunner): QueryClient {
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ): Promise<QueryRowsResult<Row>> {
      const result = await runner.query<Row>(text, values);
      return { rows: result.rows };
    },
  };
}

/**
 * Sort prepared rows according to the dependency order for their track.
 *
 * @param rows - Prepared rows from a source mapper.
 * @param tableOrder - Table dependency order for the current source track.
 * @returns New row array sorted by table dependency position.
 */
function sortRows(
  rows: readonly PreparedRow[],
  tableOrder: readonly LogicalTableName[],
): readonly PreparedRow[] {
  const order = new Map(tableOrder.map((tableName, index) => [tableName, index]));
  return [...rows].sort((left, right) => {
    const leftOrder = order.get(left.tableName) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.tableName) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

/**
 * Build the final table merge order for selected tracks without duplicates.
 *
 * @param tracks - Selected source tracks.
 * @returns Logical table names in parent-before-child merge order.
 */
function tableOrderForTracks(tracks: readonly TrackName[]): readonly LogicalTableName[] {
  const order: LogicalTableName[] = [];
  const append = (tables: readonly LogicalTableName[]): void => {
    for (const tableName of tables) {
      if (!order.includes(tableName)) order.push(tableName);
    }
  };
  if (tracks.includes("appraisal")) append(APPRAISAL_TABLE_ORDER);
  if (tracks.includes("permits")) append(PERMIT_TABLE_ORDER);
  if (tracks.includes("sunbiz")) append(SUNBIZ_TABLE_ORDER);
  if (tracks.includes("bbb")) append(BBB_TABLE_ORDER);
  return order;
}

/**
 * Load key-value pairs from a local `.env` file into `process.env`.
 *
 * Existing process environment variables win over file values so callers can
 * override credentials without editing the Vercel-pulled env file.
 *
 * @param envFile - Path to a dotenv-style file.
 */
function loadEnvFile(envFile: string): void {
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return;
    throw caught;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index);
    let value = trimmed.slice(index + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

/**
 * Parse CLI options for the local bulk loader.
 *
 * @param args - Raw command-line arguments after the script name.
 * @returns Normalized loader options.
 */
function parseOptions(args: readonly string[]): BulkLoaderOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === undefined || !raw.startsWith("--")) continue;
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex > 2) {
      values.set(raw.slice(2, equalsIndex), raw.slice(equalsIndex + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  return {
    appraisalPrefix: values.get("appraisal-prefix") ?? DEFAULT_APPRAISAL_PREFIX,
    bbbPrefix: values.get("bbb-prefix") ?? DEFAULT_BBB_PREFIX,
    bucket: values.get("bucket") ?? DEFAULT_BUCKET,
    concurrency: parseConcurrency(values.get("concurrency")),
    envFile: values.get("env-file") ?? ".env.local",
    limit: parseLimit(values.get("limit")),
    permitPrefix: values.get("permit-prefix") ?? DEFAULT_PERMIT_PREFIX,
    phase: parsePhase(values.get("phase") ?? "all"),
    scopeManifest: values.get("scope-manifest") ?? null,
    stageDir: values.get("stage-dir") ?? DEFAULT_STAGE_DIR,
    stageFile: values.get("stage-file") ?? null,
    sunbizPrefix: values.get("sunbiz-prefix") ?? DEFAULT_SUNBIZ_PREFIX,
    tracks: parseTracks(values.get("tracks") ?? "appraisal,permits,sunbiz"),
  };
}

/**
 * Parse a comma-separated track list.
 *
 * @param value - Raw comma-separated value from the CLI.
 * @returns Validated track names.
 */
function parseTracks(value: string): readonly TrackName[] {
  const tracks = value.split(",").map((track) => track.trim()).filter(Boolean);
  if (tracks.length === 0) throw new Error("At least one track is required");
  return tracks.map((track): TrackName => {
    if (track !== "appraisal" && track !== "bbb" && track !== "permits" && track !== "sunbiz") {
      throw new Error(`Unsupported track: ${track}`);
    }
    return track;
  });
}

/**
 * Parse the requested loader phase.
 *
 * @param value - Raw phase string from the CLI.
 * @returns Validated phase name.
 */
function parsePhase(value: string): BulkLoaderPhase {
  if (value === "all" || value === "stage" || value === "load") return value;
  throw new Error(`Unsupported phase: ${value}`);
}

/**
 * Parse an optional positive artifact limit.
 *
 * @param value - Raw limit string from the CLI.
 * @returns Positive limit or `null` when no limit was supplied.
 */
function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --limit value: ${value}`);
  return parsed;
}

/**
 * Parse bounded local artifact-processing concurrency.
 *
 * @param value - Raw concurrency string from the CLI.
 * @returns Positive concurrency value, defaulting to eight workers.
 */
function parseConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 8;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --concurrency value: ${value}`);
  }
  return parsed;
}

/**
 * Create a timestamped default staging file path.
 *
 * @param stageDir - Directory where bulk staging files should live.
 * @returns Path to a new CSV staging file.
 */
function buildDefaultStageFile(stageDir: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(stageDir, `bulk-stage-${stamp}.csv`);
}

/**
 * Create a zero-filled mutable counter object for one bulk-loader process.
 *
 * @returns Mutable counters used for JSON progress logging.
 */
function emptyCounters(): MutableBulkCounters {
  return {
    inputRecords: 0,
    preparedRows: 0,
    skippedRecords: 0,
    stagedRows: 0,
    completedArtifacts: 0,
    failedArtifacts: 0,
    filteredRecords: 0,
    missingArtifacts: 0,
  };
}

/**
 * Redact or trim options before printing them to logs.
 *
 * @param options - Full parsed loader options.
 * @returns Log-safe options without credentials.
 */
function redactedOptions(options: BulkLoaderOptions): JsonObject {
  return {
    appraisalPrefix: options.appraisalPrefix,
    bbbPrefix: options.bbbPrefix,
    bucket: options.bucket,
    concurrency: options.concurrency,
    envFile: options.envFile,
    limit: options.limit,
    permitPrefix: options.permitPrefix,
    phase: options.phase,
    scopeManifest: options.scopeManifest,
    stageDir: options.stageDir,
    stageFile: options.stageFile,
    sunbizPrefix: options.sunbizPrefix,
    tracks: options.tracks,
  };
}

/**
 * Read and validate a curated-commercial manifest for scoped loading.
 *
 * @param manifestPath - Local JSON manifest path.
 * @returns Parsed selection sets used by the bulk loader filters.
 */
function loadScopedSelection(manifestPath: string): ScopedLoadSelection {
  const manifestText = readFileSync(manifestPath, "utf8");
  return buildScopedLoadSelectionFromManifest(JSON.parse(manifestText));
}

function isS3BodyWithByteArray(value: unknown): value is S3BodyWithByteArray {
  return (
    typeof value === "object" &&
    value !== null &&
    "transformToByteArray" in value &&
    typeof value.transformToByteArray === "function"
  );
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isS3NotFoundError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const named = value as Error & {
    readonly name?: string;
    readonly Code?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    named.name === "NoSuchKey" ||
    named.name === "NotFound" ||
    named.Code === "NoSuchKey" ||
    named.Code === "NotFound" ||
    named.$metadata?.httpStatusCode === 404
  );
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/**
 * Process an async iterable with bounded concurrency and return the scheduled item count.
 *
 * @param items - Async iterable of work items.
 * @param concurrency - Maximum number of simultaneously running handlers.
 * @param handler - Async item handler.
 * @returns Number of items pulled from the iterable.
 */
async function processAsyncIterable<Item>(
  items: AsyncIterable<Item>,
  concurrency: number,
  handler: (item: Item) => Promise<void>,
): Promise<number> {
  const running = new Set<Promise<void>>();
  let count = 0;
  for await (const item of items) {
    count += 1;
    const promise = handler(item).finally(() => {
      running.delete(promise);
    });
    running.add(promise);
    if (running.size >= concurrency) await Promise.race(running);
  }
  await Promise.all(running);
  return count;
}

/**
 * Process an in-memory iterable with bounded concurrency.
 *
 * @param items - Iterable work items.
 * @param concurrency - Maximum number of simultaneously running handlers.
 * @param handler - Async item handler.
 * @returns Promise that resolves when every item has been handled.
 */
async function processIterable<Item>(
  items: Iterable<Item>,
  concurrency: number,
  handler: (item: Item) => Promise<void>,
): Promise<void> {
  await processAsyncIterable(toAsyncIterable(items), concurrency, handler);
}

async function* toAsyncIterable<Item>(items: Iterable<Item>): AsyncGenerator<Item> {
  for (const item of items) yield item;
}

function onceDrain(writer: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.once("drain", resolve);
    if (writer.destroyed === true) reject(new Error("Write stream was destroyed before drain"));
  });
}

function onceFinish(writer: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.once("finish", resolve);
    if (writer.destroyed === true) reject(new Error("Write stream was destroyed before finish"));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "bulk_loader_failed", error: message }));
    process.exitCode = 1;
  });
}
