import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";

import {
  buildLeeAppraisalDetailSeed,
  buildLeeDetailAddressSeed,
  buildLeeDetailInputCsv,
  buildLeeDetailPropertySeed,
  extractLeeAppraisalSearchResult,
  formatLeeStrapForSearch,
  isJsonObject,
  parseS3Uri,
  type LeeAppraisalDetailSeed,
  type LeeAppraisalSearchResult,
  type LeeAppraisalSearchSeed,
} from "../src/loader/index.js";

type DetailSeedBuildOptions = {
  readonly searchStatePath: string;
  readonly outputDir: string;
  readonly manifestOutputPath: string;
  readonly profile: string;
  readonly region: string;
  readonly limit: number | null;
};

type CompletedSearchPrepareRecord = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly bestPermitAddress: string;
  readonly leeStrap: string;
  readonly requestIdentifier: string;
  readonly outputS3Uri: string;
};

type BuiltDetailSeedRecord = LeeAppraisalDetailSeed & {
  readonly zipPath: string;
  readonly searchOutputS3Uri: string;
};

type BodyWithTransformToByteArray = {
  readonly transformToByteArray: () => Promise<Uint8Array>;
};

const DEFAULT_SEARCH_STATE_PATH = ".loader-runs/curated-commercial-appraisal/search-prepare-state.jsonl";
const DEFAULT_OUTPUT_DIR = ".loader-runs/curated-commercial-appraisal/detail-seeds";
const DEFAULT_MANIFEST_OUTPUT_PATH = ".loader-runs/curated-commercial-appraisal/detail-seeds-manifest.jsonl";

/**
 * Build Folio detail prepare ZIPs from successful Lee STRAP-search prepare
 * outputs.
 *
 * The search phase discovers a Folio ID. This script downloads each search
 * output ZIP from S3, parses the captured result page, and writes a second ZIP
 * that points oracle-node at the Lee DisplayParcel detail page with the normal
 * Lee browser flow.
 *
 * @returns Promise that resolves after ZIPs and the JSONL manifest are written.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  process.env.AWS_PROFILE = options.profile;
  process.env.AWS_REGION = options.region;

  const s3 = new S3Client({ region: options.region });
  const completedSearchRecords = (await readCompletedSearchRecords(options.searchStatePath))
    .slice(0, options.limit ?? undefined);
  await mkdir(options.outputDir, { recursive: true });
  await mkdir(dirname(options.manifestOutputPath), { recursive: true });

  const builtRecords: BuiltDetailSeedRecord[] = [];
  let skippedRecords = 0;

  for (const completedRecord of completedSearchRecords) {
    const buffer = await readS3ObjectBuffer(s3, completedRecord.outputS3Uri);
    const searchResult = extractSearchResultFromZip(buffer);
    if (searchResult === null) {
      skippedRecords += 1;
      console.warn(JSON.stringify({
        event: "curated_appraisal_detail_seed_skipped",
        reason: "no_search_result",
        rank: completedRecord.rank,
        parcelIdentifier: completedRecord.parcelIdentifier,
        searchOutputS3Uri: completedRecord.outputS3Uri,
      }));
      continue;
    }

    const searchSeed = buildSearchSeedFromCompletedRecord(completedRecord);
    const detailSeed = buildLeeAppraisalDetailSeed({ searchSeed, searchResult });
    const zipPath = join(
      options.outputDir,
      `${String(detailSeed.rank).padStart(4, "0")}-${detailSeed.normalizedParcelIdentifier}-folio-${detailSeed.folioId}.zip`,
    );
    writeDetailSeedZip(zipPath, detailSeed);
    builtRecords.push({
      ...detailSeed,
      zipPath,
      searchOutputS3Uri: completedRecord.outputS3Uri,
    });
  }

  const jsonl = builtRecords.map((record) => JSON.stringify(record)).join("\n").concat(
    builtRecords.length > 0 ? "\n" : "",
  );
  await writeFile(options.manifestOutputPath, jsonl, "utf8");
  console.log(JSON.stringify({
    event: "curated_appraisal_detail_seeds_built",
    searchStatePath: options.searchStatePath,
    outputDir: options.outputDir,
    manifestOutputPath: options.manifestOutputPath,
    searchRecords: completedSearchRecords.length,
    builtSeeds: builtRecords.length,
    skippedRecords,
  }));
}

function extractSearchResultFromZip(buffer: Buffer): LeeAppraisalSearchResult | null {
  const zip = new AdmZip(buffer);
  const htmlEntry = zip.getEntries().find((entry) => entry.entryName.endsWith(".html"));
  if (htmlEntry === undefined) return null;
  return extractLeeAppraisalSearchResult(zip.readAsText(htmlEntry));
}

function buildSearchSeedFromCompletedRecord(record: CompletedSearchPrepareRecord): LeeAppraisalSearchSeed {
  return {
    rank: record.rank,
    parcelIdentifier: record.parcelIdentifier,
    bestPermitAddress: record.bestPermitAddress,
    leeStrap: record.leeStrap,
    requestIdentifier: record.requestIdentifier,
  };
}

function writeDetailSeedZip(zipPath: string, seed: LeeAppraisalDetailSeed): void {
  const zip = new AdmZip();
  zip.addFile("property_seed.json", Buffer.from(JSON.stringify(buildLeeDetailPropertySeed(seed)), "utf8"));
  zip.addFile("unnormalized_address.json", Buffer.from(JSON.stringify(buildLeeDetailAddressSeed(seed)), "utf8"));
  zip.addFile("input.csv", Buffer.from(buildLeeDetailInputCsv(seed), "utf8"));
  zip.writeZip(zipPath);
}

async function readS3ObjectBuffer(s3: S3Client, artifactUri: string): Promise<Buffer> {
  const { bucket, key } = parseS3Uri(artifactUri);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body;
  if (body === undefined || isBodyWithTransformToByteArray(body) === false) {
    throw new Error(`S3 object had no readable body: ${artifactUri}`);
  }
  return Buffer.from(await body.transformToByteArray());
}

function isBodyWithTransformToByteArray(value: unknown): value is BodyWithTransformToByteArray {
  return isJsonObject(value) && typeof value.transformToByteArray === "function";
}

async function readCompletedSearchRecords(statePath: string): Promise<readonly CompletedSearchPrepareRecord[]> {
  const text = await readFile(statePath, "utf8");
  const records: CompletedSearchPrepareRecord[] = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed) || parsed.event !== "prepare_completed") continue;
    records.push(readCompletedSearchRecord(parsed, `${statePath}:${String(lineIndex + 1)}`));
  }
  return dedupeByOutputUri(records);
}

function readCompletedSearchRecord(value: Record<string, unknown>, source: string): CompletedSearchPrepareRecord {
  const parcelIdentifier = readRequiredString(value, "parcelIdentifier", source);
  const leeStrap = readOptionalString(value, "leeStrap") ?? formatLeeStrapForSearch(parcelIdentifier);
  if (leeStrap === null) throw new Error(`Could not derive Lee STRAP for completed state line: ${source}`);
  return {
    rank: readRequiredNumber(value, "rank", source),
    parcelIdentifier,
    bestPermitAddress: readOptionalString(value, "bestPermitAddress") ?? "",
    leeStrap,
    requestIdentifier: readOptionalString(value, "requestIdentifier") ?? leeStrap,
    outputS3Uri: readRequiredString(value, "outputS3Uri", source),
  };
}

function dedupeByOutputUri(records: readonly CompletedSearchPrepareRecord[]): readonly CompletedSearchPrepareRecord[] {
  const seen = new Set<string>();
  const deduped: CompletedSearchPrepareRecord[] = [];
  for (const record of records) {
    if (seen.has(record.outputS3Uri)) continue;
    seen.add(record.outputS3Uri);
    deduped.push(record);
  }
  return deduped;
}

function parseOptions(args: readonly string[]): DetailSeedBuildOptions {
  const values = readCliValues(args);
  return {
    searchStatePath: values.get("search-state") ?? DEFAULT_SEARCH_STATE_PATH,
    outputDir: values.get("output-dir") ?? DEFAULT_OUTPUT_DIR,
    manifestOutputPath: values.get("manifest-output") ?? DEFAULT_MANIFEST_OUTPUT_PATH,
    profile: values.get("profile") ?? process.env.AWS_PROFILE ?? "elephant-oracle-node",
    region: values.get("region") ?? process.env.AWS_REGION ?? "us-east-1",
    limit: parseOptionalPositiveInteger(values.get("limit"), "limit"),
  };
}

function readCliValues(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === undefined || raw.startsWith("--") === false) continue;
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex > 2) {
      values.set(raw.slice(2, equalsIndex), raw.slice(equalsIndex + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = args[index + 1];
    if (next !== undefined && next.startsWith("--") === false) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }
  return values;
}

function parseOptionalPositiveInteger(value: string | undefined, fieldName: string): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${fieldName}: ${value}`);
  return parsed;
}

function readRequiredString(value: Record<string, unknown>, key: string, source: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`State line is missing string field ${key}: ${source}`);
  }
  return field;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function readRequiredNumber(value: Record<string, unknown>, key: string, source: string): number {
  const field = value[key];
  if (typeof field !== "number" || Number.isFinite(field) === false) {
    throw new Error(`State line is missing number field ${key}: ${source}`);
  }
  return field;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "curated_appraisal_detail_seeds_failed", error: message }));
    process.exitCode = 1;
  });
}
