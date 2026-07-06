import { createReadStream, createWriteStream, readFileSync, unlink, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import AdmZip from "adm-zip";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { from as copyFrom } from "pg-copy-streams";
import { Client, Pool, type PoolClient } from "pg";

import {
  BULK_STAGE_COLUMNS,
  addSunbizAddressReferencesToRows,
  assertAppraisalPrefixIsScoped,
  buildAppraisalTransformedArtifactUri,
  buildScopedLoadSelectionFromManifest,
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
  type BulkTableColumn,
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
  /** Artifacts per batch for disk-bounded appraisal loading. 0 = single-batch (legacy). */
  readonly batchSize: number;
  readonly bbbPrefix: string;
  readonly bucket: string;
  readonly concurrency: number;
  readonly envFile: string;
  /** When true, skip appraisal artifacts whose URI is already loaded in Neon (cadence re-runs). */
  readonly incremental: boolean;
  /** Appraisal source_system / parcel jurisdiction_key. Defaults to "lee_appraiser" to preserve Lee behavior. */
  readonly jurisdictionKey: string;
  readonly limit: number | null;
  readonly permitPrefix: string;
  /** Permit source_system. Defaults to "lee_accela" to preserve Lee behavior. */
  readonly permitSourceSystem: string;
  readonly phase: BulkLoaderPhase;
  readonly stageDir: string;
  readonly stageFile: string | null;
  /** Existing permanent stage table to reuse on a --phase load re-run (skips COPY). */
  readonly stageTable: string | null;
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

export type MutableIncrementalCounters = {
  skipped: number;
  processed: number;
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
const STAGE_TABLE_PREFIX = "elephant_bulk_stage";

// Global cross-county serialization lock. Concurrent incremental county loads
// deadlock on shared parent tables, so a single fixed-key Postgres session
// advisory lock ensures only one incremental load runs at a time across every
// county. Held for the whole run; releasing the session releases the lock.
const INCREMENTAL_LOAD_LOCK_KEY = 911001;

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

  // Incremental status is an optional machine-readable contract for a downstream
  // Step Functions loop; it is only meaningful in incremental mode.
  const incrementalStatusUri = options.incremental
    ? (process.env.INCREMENTAL_STATUS_URI ?? null)
    : null;

  // Incremental mode: serialize all county loads behind one global advisory lock so
  // that only a single incremental load runs at a time (see INCREMENTAL_LOAD_LOCK_KEY).
  // The lock client is held open for the whole run and released in the finally below.
  let lockClient: Client | null = null;
  if (options.incremental) {
    lockClient = await createKeepaliveClient(databaseUrl);
    const lockResult = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [INCREMENTAL_LOAD_LOCK_KEY],
    );
    if (lockResult.rows[0]?.acquired !== true) {
      // Another incremental load already holds the lock; a skipped cycle is not an
      // error, so record it and exit cleanly (process exits 0).
      console.log(JSON.stringify({ event: "incremental_load_lock_busy", key: INCREMENTAL_LOAD_LOCK_KEY }));
      await lockClient.end();
      if (incrementalStatusUri !== null) {
        await writeIncrementalStatus(incrementalStatusUri, { processed: 0, skipped: true });
      }
      return;
    }
    console.log(JSON.stringify({ event: "incremental_load_lock_acquired", key: INCREMENTAL_LOAD_LOCK_KEY }));
  }

  try {
    const scopeSelection = options.scopeManifest === null
      ? null
      : loadScopedSelection(options.scopeManifest);
    const counters = emptyCounters();

    // Batched appraisal mode: stage + merge each batch atomically so peak disk usage
    // equals ONE batch CSV (~few GB) rather than all 501k artifacts at once (~106 GB).
    const useAppraisalBatchMode =
      options.batchSize > 0 &&
      options.tracks.includes("appraisal") &&
      options.phase !== "load"; // --phase load resumes via --stage-table; skip batch routing

    const stageFile = options.stageFile ?? buildDefaultStageFile(options.stageDir);

    // Incremental mode: load the set of appraisal artifact URIs already present in Neon
    // ONCE up front, then filter the S3 listing so cadence re-runs only process new work.
    const incrementalCounters: MutableIncrementalCounters = { skipped: 0, processed: 0 };
    const loadedArtifactUris =
      options.incremental && options.tracks.includes("appraisal") && options.phase !== "load"
        ? await loadIncrementalWatermark({ databaseUrl, jurisdictionKey: options.jurisdictionKey })
        : null;

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
      batchMode: useAppraisalBatchMode,
      stageFile: useAppraisalBatchMode ? "(per-batch)" : stageFile,
    }));

    if (useAppraisalBatchMode) {
      // Batched path: appraisal is processed batch-by-batch inline; remaining tracks
      // (permits, sunbiz, bbb) are processed together in a single staging pass afterward.
      await stageAndMergeAppraisalBatched({
        counters,
        databaseUrl,
        incrementalCounters,
        loadedArtifactUris,
        options,
        scopeSelection,
      });

      const remainingTracks = options.tracks.filter((t) => t !== "appraisal");
      if (remainingTracks.length > 0) {
        const remainingOptions = { ...options, tracks: remainingTracks };
        if (remainingOptions.phase === "all" || remainingOptions.phase === "stage") {
          // Appraisal is handled above in batch mode; remaining tracks are never filtered.
          await stageSelectedTracks({
            counters,
            incrementalCounters,
            loadedArtifactUris: null,
            options: remainingOptions,
            scopeSelection,
            stageFile,
          });
        }
        if (remainingOptions.phase === "all" || remainingOptions.phase === "load") {
          const mergeResults = await copyAndMergeStageFile({
            databaseUrl,
            stageDir: options.stageDir,
            stageFile,
            stageTable: options.stageTable,
            tableOrder: tableOrderForTracks(remainingTracks),
          });
          console.log(JSON.stringify({ event: "bulk_merge_finished", mergeResults }));
        }
      }
    } else {
      // Legacy single-batch path (used for sunbiz/bbb/permits standalone, or explicit --batch-size 0).
      if (options.phase === "all" || options.phase === "stage") {
        await stageSelectedTracks({ counters, incrementalCounters, loadedArtifactUris, options, scopeSelection, stageFile });
      }
      if (options.phase === "all" || options.phase === "load") {
        const mergeResults = await copyAndMergeStageFile({
          databaseUrl,
          stageDir: options.stageDir,
          stageFile,
          stageTable: options.stageTable,
          tableOrder: tableOrderForTracks(options.tracks),
        });
        console.log(JSON.stringify({ event: "bulk_merge_finished", mergeResults }));
      }
    }

    console.log(JSON.stringify({ event: "bulk_loader_finished", counters, stageFile: useAppraisalBatchMode ? "(batched)" : stageFile }));

    if (incrementalStatusUri !== null) {
      await writeIncrementalStatus(incrementalStatusUri, {
        processed: incrementalCounters.processed,
        skipped: false,
      });
    }
  } finally {
    // Closing the session releases the global advisory lock held for this run.
    if (lockClient !== null) await lockClient.end();
  }
}

/**
 * Transform selected S3 artifacts through the existing source mappers into a local CSV file.
 *
 * @param params - Loader options, mutable counters, and the target staging file path.
 * @returns Promise that resolves after all selected tracks have been staged.
 */
async function stageSelectedTracks(params: {
  readonly counters: MutableBulkCounters;
  readonly incrementalCounters: MutableIncrementalCounters;
  readonly loadedArtifactUris: ReadonlySet<string> | null;
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
  readonly incrementalCounters: MutableIncrementalCounters;
  readonly loadedArtifactUris: ReadonlySet<string> | null;
  readonly options: BulkLoaderOptions;
  readonly scopeSelection: ScopedLoadSelection | null;
  readonly s3: S3Client;
  readonly writeRows: (rows: readonly PreparedRow[]) => Promise<void>;
}): Promise<void> {
  assertAppraisalPrefixIsScoped(params.options.appraisalPrefix);
  console.log(JSON.stringify({ event: "bulk_track_started", track: "appraisal" }));
  const baseArtifacts = listAppraisalArtifacts({
    bucket: params.options.bucket,
    limit: params.options.limit,
    prefix: params.options.appraisalPrefix,
    s3: params.s3,
  });
  const artifactCount = await processAsyncIterable(
    params.loadedArtifactUris === null
      ? baseArtifacts
      : filterAlreadyLoaded(baseArtifacts, params.loadedArtifactUris, params.incrementalCounters),
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
            sourceSystem: params.options.jurisdictionKey,
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
  if (params.loadedArtifactUris !== null) {
    console.log(JSON.stringify({
      event: "incremental_filter_summary",
      skipped: params.incrementalCounters.skipped,
      processed: params.incrementalCounters.processed,
    }));
  }
  console.log(JSON.stringify({ event: "bulk_track_finished", track: "appraisal", artifactCount }));
}

/**
 * Process appraisal artifacts in disk-bounded batches.
 *
 * For each batch of `options.batchSize` artifacts:
 *   1. Stage the batch into a fresh per-batch CSV.
 *   2. COPY the CSV into a new permanent stage table.
 *   3. Merge all appraisal logical tables from the stage table.
 *   4. Drop the stage table.
 *   5. Delete the batch CSV from disk.
 *
 * Peak local disk usage = ONE batch CSV (a few GB), never the full 106 GB.
 * A JSON checkpoint file records completed batch indices so a re-run resumes
 * from the first incomplete batch without re-processing committed data.
 *
 * @param params - Database URL, loader options, scope selection, and mutable counters.
 * @returns Promise that resolves after all batches have been processed.
 */
async function stageAndMergeAppraisalBatched(params: {
  readonly counters: MutableBulkCounters;
  readonly databaseUrl: string;
  readonly incrementalCounters: MutableIncrementalCounters;
  readonly loadedArtifactUris: ReadonlySet<string> | null;
  readonly options: BulkLoaderOptions;
  readonly scopeSelection: ScopedLoadSelection | null;
}): Promise<void> {
  const { counters, databaseUrl, incrementalCounters, loadedArtifactUris, options, scopeSelection } = params;
  const s3 = new S3Client({});

  assertAppraisalPrefixIsScoped(options.appraisalPrefix);
  await mkdir(options.stageDir, { recursive: true });

  // Include batch-size in the checkpoint filename so runs with different batch
  // sizes don't cross-contaminate each other's resume state.
  const batchCheckpointPath = join(options.stageDir, `appraisal-batch-checkpoint-n${options.batchSize}.json`);
  // Each incremental cadence run is an independent set of not-yet-loaded artifacts,
  // so a prior cycle's batch checkpoint must not skip this cycle's (renumbered) batches.
  const completedBatches = options.incremental
    ? new Set<number>()
    : await readBatchCheckpoint(batchCheckpointPath);

  console.log(JSON.stringify({
    event: "appraisal_batch_mode_started",
    batchSize: options.batchSize,
    completedBatches: [...completedBatches],
  }));

  const baseArtifacts = listAppraisalArtifacts({
    bucket: options.bucket,
    limit: options.limit,
    prefix: options.appraisalPrefix,
    s3,
  });
  const artifactIterator = loadedArtifactUris === null
    ? baseArtifacts
    : filterAlreadyLoaded(baseArtifacts, loadedArtifactUris, incrementalCounters);

  let batchIndex = 0;
  let batchBuffer: S3ObjectListing[] = [];

  const flushBatch = async (artifacts: readonly S3ObjectListing[]): Promise<void> => {
    const currentBatch = batchIndex;
    batchIndex += 1;

    if (completedBatches.has(currentBatch)) {
      console.log(JSON.stringify({
        event: "appraisal_batch_skipped",
        batchIndex: currentBatch,
        artifactCount: artifacts.length,
      }));
      return;
    }

    const batchStageFile = join(
      options.stageDir,
      `appraisal-batch-${String(currentBatch).padStart(6, "0")}.csv`,
    );
    const stageTableName = buildPermanentStageTableName();

    console.log(JSON.stringify({
      event: "appraisal_batch_started",
      batchIndex: currentBatch,
      artifactCount: artifacts.length,
      batchStageFile,
      stageTableName,
    }));

    // Stage this batch into its own CSV.
    const batchCounters = emptyCounters();
    const writer = createWriteStream(batchStageFile, { encoding: "utf8", flags: "w" });
    let nextRowIndex = 1;

    const writeRows = async (rows: readonly PreparedRow[]): Promise<void> => {
      let chunk = "";
      for (const row of rows) {
        chunk += serializeBulkStageCsvRow({ rowIndex: nextRowIndex, row });
        nextRowIndex += 1;
        batchCounters.stagedRows += 1;
      }
      if (chunk.length > 0 && !writer.write(chunk)) await onceDrain(writer);
    };

    try {
      writer.write(serializeBulkStageCsvHeader());
      await processIterable(artifacts, options.concurrency, async (artifact) => {
        await stageArtifact({ counters: batchCounters }, artifact.uri, async () => {
          const buffer = await readS3ObjectBuffer(s3, artifact.uri);
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
              sourceSystem: params.options.jurisdictionKey,
            });
            rows.push(...bundle.rows);
            skippedRecords += bundle.skippedRecords.length;
            batchCounters.inputRecords += 1;
          }

          if (
            scopeSelection !== null &&
            !preparedRowsContainSelectedParcel(rows, scopeSelection)
          ) {
            batchCounters.filteredRecords += entries.length;
            batchCounters.skippedRecords += skippedRecords;
            return {
              filteredRecords: entries.length,
              inputRecords: entries.length,
              preparedRows: 0,
              skippedRecords,
            };
          }

          const sortedRows = sortRows(rows, APPRAISAL_TABLE_ORDER);
          await writeRows(sortedRows);
          batchCounters.preparedRows += rows.length;
          batchCounters.skippedRecords += skippedRecords;
          return {
            filteredRecords: 0,
            inputRecords: entries.length,
            preparedRows: rows.length,
            skippedRecords,
          };
        });
      });
    } finally {
      writer.end();
      await onceFinish(writer);
    }

    // Accumulate batch counters into the shared run counters.
    counters.inputRecords += batchCounters.inputRecords;
    counters.preparedRows += batchCounters.preparedRows;
    counters.skippedRecords += batchCounters.skippedRecords;
    counters.stagedRows += batchCounters.stagedRows;
    counters.completedArtifacts += batchCounters.completedArtifacts;
    counters.failedArtifacts += batchCounters.failedArtifacts;
    counters.filteredRecords += batchCounters.filteredRecords;
    counters.missingArtifacts += batchCounters.missingArtifacts;

    console.log(JSON.stringify({
      event: "appraisal_batch_staged",
      batchIndex: currentBatch,
      batchCounters,
      batchStageFile,
    }));

    // COPY → merge → drop stage table → delete CSV.
    await copyToStagingTable({ databaseUrl, stageFile: batchStageFile, stageTableName, stageDir: options.stageDir });

    const batchCheckpoint = join(options.stageDir, `${stageTableName}-checkpoint.json`);
    const alreadyMerged = await readCheckpoint(batchCheckpoint);
    const metaClient = await createKeepaliveClient(databaseUrl);
    let columnsByTable: ReadonlyMap<LogicalTableName, readonly BulkTableColumn[]>;
    try {
      columnsByTable = await readBulkTableColumns(createQueryClient(metaClient), APPRAISAL_TABLE_ORDER);
    } finally {
      await metaClient.end();
    }

    const committed = new Set(alreadyMerged);
    for (const tableName of APPRAISAL_TABLE_ORDER) {
      if (committed.has(tableName)) {
        console.log(JSON.stringify({ event: "bulk_table_skipped_already_merged", tableName, batchIndex: currentBatch }));
        continue;
      }
      const columns = columnsByTable.get(tableName);
      if (columns === undefined) throw new Error(`Missing columns for ${tableName}`);
      const result = await mergeOneTable({ databaseUrl, stageTableName, tableName, columns });
      committed.add(tableName);
      writeCheckpoint(batchCheckpoint, committed);
      console.log(JSON.stringify({ event: "bulk_table_merged", ...result, batchIndex: currentBatch }));
    }

    await dropStagingTable(databaseUrl, stageTableName);

    // Delete the batch CSV now that it is fully merged — keeps disk usage flat.
    unlink(batchStageFile, (err) => {
      if (err !== null) {
        console.error(JSON.stringify({ event: "appraisal_batch_csv_delete_failed", batchStageFile, error: err.message }));
      } else {
        console.log(JSON.stringify({ event: "appraisal_batch_csv_deleted", batchStageFile }));
      }
    });

    completedBatches.add(currentBatch);
    // Skip persisting resume state in incremental mode: batch indices are re-numbered
    // per cadence run, so a stored checkpoint would be meaningless (and could mislead a
    // later non-incremental resume) — see the completedBatches init above.
    if (!options.incremental) {
      writeBatchCheckpoint(batchCheckpointPath, completedBatches);
    }

    console.log(JSON.stringify({
      event: "appraisal_batch_completed",
      batchIndex: currentBatch,
      stageTableName,
    }));
  };

  // Collect artifacts into batches and flush each one.
  for await (const artifact of artifactIterator) {
    batchBuffer.push(artifact);
    if (batchBuffer.length >= options.batchSize) {
      await flushBatch(batchBuffer);
      batchBuffer = [];
    }
  }
  // Flush any remaining artifacts as a final (possibly smaller) batch.
  if (batchBuffer.length > 0) {
    await flushBatch(batchBuffer);
  }

  if (loadedArtifactUris !== null) {
    console.log(JSON.stringify({
      event: "incremental_filter_summary",
      skipped: incrementalCounters.skipped,
      processed: incrementalCounters.processed,
    }));
  }

  console.log(JSON.stringify({
    event: "appraisal_batch_mode_finished",
    totalBatches: batchIndex,
  }));
}

/**
 * Read completed batch indices from the appraisal batch checkpoint file.
 *
 * @param checkpointPath - Path to the JSON batch checkpoint file.
 * @returns Mutable set of completed batch indices.
 */
async function readBatchCheckpoint(checkpointPath: string): Promise<Set<number>> {
  try {
    const text = await readFile(checkpointPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is number => typeof item === "number"));
  } catch {
    return new Set();
  }
}

/**
 * Persist completed batch indices to the batch checkpoint file.
 *
 * @param checkpointPath - Path to the JSON batch checkpoint file.
 * @param completed - Set of completed batch indices.
 */
function writeBatchCheckpoint(checkpointPath: string, completed: ReadonlySet<number>): void {
  writeFileSync(checkpointPath, JSON.stringify([...completed]), "utf8");
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
        const bundle = mapLeePermitDetail({
          artifactUri: artifact.uri,
          record: record.record,
          sourceSystem: params.options.permitSourceSystem,
        });
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
 * Create a dedicated pg Client with TCP keepalive enabled.
 *
 * Neon drops idle TCP connections after ~5 minutes. Keepalive probes prevent
 * the connection from going silent during long COPY or merge operations.
 *
 * @param databaseUrl - Postgres connection string.
 * @returns Connected pg Client.
 */
async function createKeepaliveClient(databaseUrl: string): Promise<Client> {
  const client = new Client({
    connectionString: databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 60_000,
    application_name: "elephant-query-bulk-loader",
  });
  await client.connect();
  return client;
}

/**
 * Load the set of appraisal artifact URIs already present in Neon for a jurisdiction.
 *
 * Used by incremental cadence runs as a watermark: any artifact whose
 * `source_artifact_uri` is already recorded on `parcels` has been loaded and can be
 * skipped. The exact S3 URI is stored at load time, so an exact-match set is reliable.
 *
 * @param params - Database URL and the parcel jurisdiction_key to scope the watermark.
 * @returns Set of already-loaded artifact URIs.
 */
async function loadIncrementalWatermark(params: {
  readonly databaseUrl: string;
  readonly jurisdictionKey: string;
}): Promise<Set<string>> {
  const client = await createKeepaliveClient(params.databaseUrl);
  try {
    const result = await client.query<{ source_artifact_uri: string }>(
      "SELECT source_artifact_uri FROM parcels WHERE jurisdiction_key = $1 AND source_artifact_uri IS NOT NULL",
      [params.jurisdictionKey],
    );
    const loadedUris = new Set<string>();
    for (const row of result.rows) {
      if (typeof row.source_artifact_uri === "string") loadedUris.add(row.source_artifact_uri);
    }
    console.log(JSON.stringify({
      event: "incremental_watermark_loaded",
      jurisdictionKey: params.jurisdictionKey,
      alreadyLoaded: loadedUris.size,
    }));
    return loadedUris;
  } finally {
    await client.end();
  }
}

/**
 * Wrap an appraisal artifact listing so already-loaded artifacts are skipped.
 *
 * The idempotent merges make re-processing a loaded artifact harmless, so this filter
 * is purely a work-avoidance optimization for cadence re-runs; a missed or extra
 * artifact is never a correctness bug.
 *
 * @param artifacts - Source artifact listings from `listAppraisalArtifacts`.
 * @param loadedUris - Artifact URIs already present in Neon (the incremental watermark).
 * @param counters - Mutable counters incremented for each skipped / yielded artifact.
 * @yields Only the artifacts whose URI is not already loaded.
 */
export async function* filterAlreadyLoaded(
  artifacts: AsyncIterable<S3ObjectListing>,
  loadedUris: ReadonlySet<string>,
  counters: MutableIncrementalCounters,
): AsyncGenerator<S3ObjectListing> {
  for await (const artifact of artifacts) {
    if (loadedUris.has(artifact.uri)) {
      counters.skipped += 1;
      continue;
    }
    counters.processed += 1;
    yield artifact;
  }
}

/**
 * Build a permanent (non-TEMP) stage table name from the current timestamp.
 *
 * Using a permanent table (not TEMP) ensures the staged data survives connection
 * drops between the COPY and merge phases.
 *
 * @returns Safe lowercase table name containing a timestamp.
 */
function buildPermanentStageTableName(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${STAGE_TABLE_PREFIX}_${stamp}`;
}

/**
 * Path to the per-run merge checkpoint file that records completed table merges.
 *
 * The checkpoint file lets a re-run skip tables that were already committed,
 * making the load phase safely resumable after a connection drop.
 *
 * @param stageDir - Directory where staging files live.
 * @param stageTableName - Permanent stage table name (used as a unique key).
 * @returns Absolute path to the JSON checkpoint file.
 */
function buildCheckpointPath(stageDir: string, stageTableName: string): string {
  return join(stageDir, `${stageTableName}-checkpoint.json`);
}

/**
 * Read the set of tables already committed for this run from the checkpoint file.
 *
 * @param checkpointPath - Path to the JSON checkpoint file.
 * @returns Set of table names that were previously committed.
 */
async function readCheckpoint(checkpointPath: string): Promise<ReadonlySet<string>> {
  try {
    const text = await readFile(checkpointPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Append a committed table name to the checkpoint file.
 *
 * Written synchronously so the record is flushed before the next merge starts.
 *
 * @param checkpointPath - Path to the JSON checkpoint file.
 * @param committed - Table names that have been committed so far.
 */
function writeCheckpoint(checkpointPath: string, committed: ReadonlySet<string>): void {
  writeFileSync(checkpointPath, JSON.stringify([...committed]), "utf8");
}

/**
 * Copy the staged CSV file into a permanent PostgreSQL staging table and commit.
 *
 * The stage table is permanent (not TEMP) so it survives connection drops between
 * the COPY phase and the subsequent per-table merge phase. TCP keepalive is enabled
 * to prevent Neon's proxy from tearing down a connection idle during a long COPY.
 *
 * @param params - Database connection string, CSV path, stage table name, and stage dir.
 * @returns Promise that resolves after the COPY has committed.
 */
async function copyToStagingTable(params: {
  readonly databaseUrl: string;
  readonly stageFile: string;
  readonly stageTableName: string;
  readonly stageDir: string;
}): Promise<void> {
  const client = await createKeepaliveClient(params.databaseUrl);
  try {
    const stageTable = quoteIdentifier(params.stageTableName);
    const columnsSql = BULK_STAGE_COLUMNS.map(quoteIdentifier).join(", ");

    // Create the permanent stage table and its lookup indexes.
    await client.query(`DROP TABLE IF EXISTS public.${stageTable}`, []);
    await client.query(
      [
        `CREATE TABLE public.${stageTable} (`,
        `"row_index" bigint NOT NULL,`,
        `"table_name" text NOT NULL,`,
        `"source_system" text NOT NULL,`,
        `"source_record_key" text NOT NULL,`,
        `"source_record_hash" text,`,
        `"source_artifact_uri" text,`,
        `"values_json" jsonb NOT NULL,`,
        `"references_json" jsonb NOT NULL DEFAULT '{}'::jsonb`,
        `)`,
      ].join(" "),
      [],
    );
    await client.query(
      `CREATE INDEX ${quoteIdentifier(`${params.stageTableName}_table_idx`)} ON public.${stageTable} ("table_name")`,
      [],
    );
    await client.query(
      `CREATE INDEX ${quoteIdentifier(`${params.stageTableName}_source_idx`)} ON public.${stageTable} ("source_system", "source_record_key")`,
      [],
    );

    console.log(JSON.stringify({ event: "bulk_stage_table_created", stageTableName: params.stageTableName }));

    const copySql = `COPY public.${stageTable} (${columnsSql}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;
    const copyStream = client.query(copyFrom(copySql));
    await pipeline(createReadStream(params.stageFile), copyStream);
    console.log(JSON.stringify({ event: "bulk_stage_copied", stageFile: params.stageFile, stageTableName: params.stageTableName }));
  } finally {
    await client.end();
  }
}

/**
 * Merge one logical table from the permanent staging table into its final table.
 *
 * Each table merge runs in its own BEGIN/COMMIT on a fresh keepalive connection.
 * This prevents any single long-running transaction from holding a Neon connection
 * open long enough to trigger a proxy-level TCP drop.
 *
 * The search_path is set to `public` so `mergeBulkStageTable`'s SQL builder can
 * reference the permanent stage table by its plain name without a schema prefix.
 *
 * @param params - Database URL, stage table name, target table, and column metadata.
 * @returns Merge result counters for the table.
 */
async function mergeOneTable(params: {
  readonly databaseUrl: string;
  readonly stageTableName: string;
  readonly tableName: LogicalTableName;
  readonly columns: readonly BulkTableColumn[];
}): Promise<BulkMergeResult> {
  const client = await createKeepaliveClient(params.databaseUrl);
  const queryClient = createQueryClient(client);
  try {
    // Ensure the permanent stage table is visible via its plain name in the merge SQL.
    await client.query("SET search_path TO public", []);
    // Increase per-session memory for hash joins. The merge queries build large hash tables
    // from parent tables (addresses: ~1M rows, parcels: ~200k). With the default 4MB
    // work_mem, the planner spills to disk across 16 batches, adding tens of seconds per
    // merge. 128MB lets most hash tables fit in memory and eliminates the disk spill.
    await client.query("SET work_mem TO '128MB'", []);
    // Neon runs on NVMe SSD. The default random_page_cost=4 (spinning disk) causes the
    // planner to prefer hash joins over index-nested-loop joins even when index scans are
    // much faster on flash storage. Lowering to 1.1 lets the planner pick NL index joins
    // for the reference-resolution lookups against parent tables.
    await client.query("SET random_page_cost TO 1.1", []);
    await client.query("BEGIN");
    const result = await mergeBulkStageTable(queryClient, {
      stageTableName: params.stageTableName,
      tableName: params.tableName,
      columns: params.columns,
    });
    await client.query("COMMIT");
    return result;
  } catch (caught) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw caught;
  } finally {
    await client.end();
  }
}

/**
 * Drop the permanent staging table once all merges have committed.
 *
 * @param databaseUrl - Postgres connection string.
 * @param stageTableName - Name of the permanent stage table to drop.
 */
async function dropStagingTable(databaseUrl: string, stageTableName: string): Promise<void> {
  const client = await createKeepaliveClient(databaseUrl);
  try {
    await client.query(`DROP TABLE IF EXISTS public.${quoteIdentifier(stageTableName)}`, []);
    console.log(JSON.stringify({ event: "bulk_stage_table_dropped", stageTableName }));
  } finally {
    await client.end();
  }
}

/**
 * Copy the staged CSV into a permanent Postgres table, then merge into final tables
 * one table at a time — each in its own transaction on a fresh keepalive connection.
 *
 * This replaces the previous monolithic BEGIN/COPY/merge-all/COMMIT approach, which
 * failed with EPIPE on Neon when the ~6.5 GB COPY took >26 minutes and Neon's proxy
 * dropped the idle TCP connection before the subsequent merge queries could commit.
 *
 * Resumability: a JSON checkpoint file records each committed table. A re-run with
 * the same --stage-table skips already-committed tables, so partial failures are safe.
 *
 * @param params - Database URL, stage file path, optional existing stage table, stage dir, and merge order.
 * @returns Per-table merge counters in dependency order.
 */
async function copyAndMergeStageFile(params: {
  readonly databaseUrl: string;
  readonly stageDir: string;
  readonly stageFile: string;
  readonly stageTable: string | null;
  readonly tableOrder: readonly LogicalTableName[];
}): Promise<readonly BulkMergeResult[]> {
  await mkdir(params.stageDir, { recursive: true });

  // Use an existing stage table (--stage-table re-run) or create a fresh one.
  const stageTableName = params.stageTable ?? buildPermanentStageTableName();
  const checkpointPath = buildCheckpointPath(params.stageDir, stageTableName);

  if (params.stageTable === null) {
    // Fresh run: COPY CSV into the permanent stage table.
    await copyToStagingTable({
      databaseUrl: params.databaseUrl,
      stageFile: params.stageFile,
      stageTableName,
      stageDir: params.stageDir,
    });
    console.log(JSON.stringify({ event: "bulk_copy_committed", stageTableName }));
  } else {
    console.log(JSON.stringify({ event: "bulk_reusing_stage_table", stageTableName }));
  }

  // Read which tables were already merged in a previous (possibly partial) run.
  const alreadyMerged = await readCheckpoint(checkpointPath);

  // Read column metadata once using a short-lived connection.
  const metaClient = await createKeepaliveClient(params.databaseUrl);
  let columnsByTable: ReadonlyMap<LogicalTableName, readonly BulkTableColumn[]>;
  try {
    columnsByTable = await readBulkTableColumns(createQueryClient(metaClient), params.tableOrder);
  } finally {
    await metaClient.end();
  }

  const results: BulkMergeResult[] = [];
  const committed = new Set(alreadyMerged);

  for (const tableName of params.tableOrder) {
    if (committed.has(tableName)) {
      console.log(JSON.stringify({ event: "bulk_table_skipped_already_merged", tableName }));
      continue;
    }
    const columns = columnsByTable.get(tableName);
    if (columns === undefined) throw new Error(`Missing columns for ${tableName}`);

    const result = await mergeOneTable({
      databaseUrl: params.databaseUrl,
      stageTableName,
      tableName,
      columns,
    });
    results.push(result);
    committed.add(tableName);
    writeCheckpoint(checkpointPath, committed);
    console.log(JSON.stringify({ event: "bulk_table_merged", ...result }));
  }

  // Clean up the permanent stage table now that all merges committed.
  await dropStagingTable(params.databaseUrl, stageTableName);
  console.log(JSON.stringify({ event: "bulk_load_complete", stageTableName, checkpointPath }));

  return results;
}

/**
 * List transformed appraisal artifact URIs via a single flat recursive listing.
 *
 * The lee-fullcounty run stores artifacts at:
 *   `<prefix>/row-<N>-folio-<folio>-parcel-<id>/<uuid>/transformed_output.zip`
 *
 * The previous two-level delimiter approach required ~501k individual
 * ListObjectsV2 calls (one per parcel), capping throughput at ~6–7 artifacts/sec
 * regardless of --concurrency. This implementation issues a single flat listing
 * (no Delimiter) and yields an artifact URI for every key that ends with
 * `/transformed_output.zip`, producing ~2,500 paginated API calls total and
 * saturating the concurrency pool within seconds.
 *
 * The artifact URI shape is identical to the previous implementation:
 *   `s3://<bucket>/<key-without-filename>/transformed_output.zip`
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
  const ARTIFACT_FILENAME = "transformed_output.zip";
  const artifactSuffix = `/${ARTIFACT_FILENAME}`;
  let yielded = 0;
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
      if (key === undefined || !key.endsWith(artifactSuffix)) continue;

      yield {
        uri: `s3://${params.bucket}/${key}`,
        size: object.Size ?? null,
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
 * Write the machine-readable incremental status object to S3.
 *
 * A downstream Step Functions machine parses exactly the `processed` and `skipped`
 * fields, so those names are a fixed contract and must not be renamed.
 *
 * @param uri - Destination `s3://bucket/key` status object URI.
 * @param status - Processed artifact count and whether this cycle was skipped.
 * @returns Promise that resolves once the status object has been written.
 */
async function writeIncrementalStatus(
  uri: string,
  status: { readonly processed: number; readonly skipped: boolean },
): Promise<void> {
  const { bucket, key } = parseS3Uri(uri);
  const s3 = new S3Client({});
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify({ processed: status.processed, skipped: status.skipped }),
    ContentType: "application/json",
  }));
  console.log(JSON.stringify({
    event: "incremental_status_written",
    uri,
    processed: status.processed,
    skipped: status.skipped,
  }));
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
    batchSize: parseBatchSize(values.get("batch-size")),
    bbbPrefix: values.get("bbb-prefix") ?? DEFAULT_BBB_PREFIX,
    bucket: values.get("bucket") ?? DEFAULT_BUCKET,
    concurrency: parseConcurrency(values.get("concurrency")),
    envFile: values.get("env-file") ?? ".env.local",
    incremental: values.get("incremental") === "true",
    jurisdictionKey: values.get("jurisdiction-key") ?? "lee_appraiser",
    limit: parseLimit(values.get("limit")),
    permitPrefix: values.get("permit-prefix") ?? DEFAULT_PERMIT_PREFIX,
    permitSourceSystem: values.get("permit-source-system") ?? "lee_accela",
    phase: parsePhase(values.get("phase") ?? "all"),
    scopeManifest: values.get("scope-manifest") ?? null,
    stageDir: values.get("stage-dir") ?? DEFAULT_STAGE_DIR,
    stageFile: values.get("stage-file") ?? null,
    stageTable: values.get("stage-table") ?? null,
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
 * Parse the appraisal batch size for disk-bounded loading.
 *
 * A value of 0 disables batching (legacy single-CSV path). Any positive integer
 * N causes appraisal artifacts to be processed in groups of N, each staged to its
 * own temporary CSV that is deleted after merging to keep peak disk usage bounded.
 *
 * Defaults to 20000 when the flag is omitted.
 *
 * @param value - Raw batch-size string from the CLI.
 * @returns Non-negative batch size.
 */
function parseBatchSize(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 20_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --batch-size value: ${value} (must be a non-negative integer; 0 = disable batching)`);
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
    batchSize: options.batchSize,
    bbbPrefix: options.bbbPrefix,
    bucket: options.bucket,
    concurrency: options.concurrency,
    envFile: options.envFile,
    incremental: options.incremental,
    jurisdictionKey: options.jurisdictionKey,
    limit: options.limit,
    permitPrefix: options.permitPrefix,
    permitSourceSystem: options.permitSourceSystem,
    phase: options.phase,
    scopeManifest: options.scopeManifest,
    stageDir: options.stageDir,
    stageFile: options.stageFile,
    stageTable: options.stageTable,
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
