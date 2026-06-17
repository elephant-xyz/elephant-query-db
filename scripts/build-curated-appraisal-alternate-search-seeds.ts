import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import AdmZip from "adm-zip";

import {
  buildLeeAppraisalSearchSeedWithStrap,
  buildLeeSearchAddressSeed,
  buildLeeSearchInputCsv,
  buildLeeSearchPropertySeed,
  formatLeeStrapForFinalSegmentLeftPadSearch,
  isJsonObject,
  type LeeAppraisalSearchSeed,
} from "../src/loader/index.js";

type BuildAlternateSearchSeedOptions = {
  readonly manifestPath: string;
  readonly searchStatePath: string;
  readonly outputDir: string;
  readonly manifestOutputPath: string;
  readonly limit: number | null;
};

type SearchManifestRecord = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly bestPermitAddress: string;
  readonly leeStrap: string;
};

type SearchStateRecord = {
  readonly event: "prepare_completed" | "prepare_failed";
  readonly zipPath: string;
};

type BuiltSearchSeedRecord = LeeAppraisalSearchSeed & {
  readonly zipPath: string;
  readonly originalLeeStrap: string;
  readonly retryReason: "final_segment_left_pad";
};

const DEFAULT_MANIFEST_PATH = ".loader-runs/curated-commercial-appraisal/search-seeds-2000-manifest.jsonl";
const DEFAULT_SEARCH_STATE_PATH = ".loader-runs/curated-commercial-appraisal/search-prepare-2000-state.jsonl";
const DEFAULT_OUTPUT_DIR = ".loader-runs/curated-commercial-appraisal/search-seeds-final-left-pad";
const DEFAULT_MANIFEST_OUTPUT_PATH =
  ".loader-runs/curated-commercial-appraisal/search-seeds-final-left-pad-manifest.jsonl";

/**
 * Build alternate Lee appraiser STRAP-search ZIPs for failed primary search records.
 *
 * The primary seed generator right-pads shorter Accela parcel identifiers. This
 * retry generator keeps only failed records where left-padding the final STRAP
 * segment produces a different candidate value. Successful and unprocessed
 * primary records are ignored.
 *
 * @returns Promise that resolves after retry ZIPs and manifest JSONL are written.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifestRecords = await readSearchManifest(options.manifestPath);
  const failedZipPaths = await readFailedZipPaths(options.searchStatePath);
  await mkdir(options.outputDir, { recursive: true });
  await mkdir(dirname(options.manifestOutputPath), { recursive: true });

  const builtRecords: BuiltSearchSeedRecord[] = [];
  let skippedRecords = 0;
  for (const record of manifestRecords) {
    if (!failedZipPaths.has(recordZipPath(record))) continue;
    const alternateLeeStrap = formatLeeStrapForFinalSegmentLeftPadSearch(record.parcelIdentifier);
    if (alternateLeeStrap === null || alternateLeeStrap === record.leeStrap) {
      skippedRecords += 1;
      continue;
    }
    const seed = buildLeeAppraisalSearchSeedWithStrap({
      rank: record.rank,
      parcelIdentifier: record.parcelIdentifier,
      bestPermitAddress: record.bestPermitAddress,
      leeStrap: alternateLeeStrap,
    });
    const zipPath = join(
      options.outputDir,
      `${String(seed.rank).padStart(4, "0")}-${seed.parcelIdentifier}-final-left-pad.zip`,
    );
    writeSearchSeedZip(zipPath, seed);
    builtRecords.push({
      ...seed,
      zipPath,
      originalLeeStrap: record.leeStrap,
      retryReason: "final_segment_left_pad",
    });
    if (options.limit !== null && builtRecords.length >= options.limit) break;
  }

  const jsonl = builtRecords.map((record) => JSON.stringify(record)).join("\n").concat(
    builtRecords.length > 0 ? "\n" : "",
  );
  await writeFile(options.manifestOutputPath, jsonl, "utf8");
  console.log(JSON.stringify({
    event: "curated_appraisal_alternate_search_seeds_built",
    builtSeeds: builtRecords.length,
    manifestOutputPath: options.manifestOutputPath,
    outputDir: options.outputDir,
    searchStatePath: options.searchStatePath,
    skippedRecords,
  }));
}

/**
 * Read primary search manifest records.
 *
 * @param manifestPath - JSONL manifest written by the primary search-seed builder.
 * @returns Parsed search manifest rows.
 */
async function readSearchManifest(manifestPath: string): Promise<readonly SearchManifestRecord[]> {
  const text = await readFile(manifestPath, "utf8");
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    return [readSearchManifestRecord(JSON.parse(line), `${manifestPath}:${String(index + 1)}`)];
  });
}

function readSearchManifestRecord(value: unknown, source: string): SearchManifestRecord {
  if (!isJsonObject(value)) throw new Error(`Search manifest line is not an object: ${source}`);
  return {
    rank: readNumberField(value, "rank", source),
    parcelIdentifier: readStringField(value, "parcelIdentifier", source),
    bestPermitAddress: readStringField(value, "bestPermitAddress", source),
    leeStrap: readStringField(value, "leeStrap", source),
  };
}

/**
 * Read failed ZIP paths from a primary search prepare state file.
 *
 * @param statePath - JSONL state emitted by `run-curated-appraisal-prepare.ts`.
 * @returns Failed primary seed ZIP paths.
 */
async function readFailedZipPaths(statePath: string): Promise<ReadonlySet<string>> {
  const text = await readFile(statePath, "utf8");
  const failedZipPaths = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    const record = readSearchStateRecord(JSON.parse(line), `${statePath}:${String(index + 1)}`);
    if (record.event === "prepare_failed") failedZipPaths.add(record.zipPath);
  }
  return failedZipPaths;
}

function readSearchStateRecord(value: unknown, source: string): SearchStateRecord {
  if (!isJsonObject(value)) throw new Error(`Search state line is not an object: ${source}`);
  const event = value.event;
  if (event !== "prepare_completed" && event !== "prepare_failed") {
    throw new Error(`Search state line has unsupported event: ${source}`);
  }
  return {
    event,
    zipPath: readStringField(value, "zipPath", source),
  };
}

function recordZipPath(record: SearchManifestRecord): string {
  return `.loader-runs/curated-commercial-appraisal/search-seeds-2000/${String(record.rank).padStart(4, "0")}-${record.parcelIdentifier}.zip`;
}

function writeSearchSeedZip(zipPath: string, seed: LeeAppraisalSearchSeed): void {
  const zip = new AdmZip();
  zip.addFile("property_seed.json", Buffer.from(JSON.stringify(buildLeeSearchPropertySeed(seed)), "utf8"));
  zip.addFile("unnormalized_address.json", Buffer.from(JSON.stringify(buildLeeSearchAddressSeed(seed)), "utf8"));
  zip.addFile("input.csv", Buffer.from(buildLeeSearchInputCsv(seed), "utf8"));
  zip.writeZip(zipPath);
}

function parseOptions(args: readonly string[]): BuildAlternateSearchSeedOptions {
  const values = readCliValues(args);
  return {
    manifestPath: values.get("manifest") ?? DEFAULT_MANIFEST_PATH,
    searchStatePath: values.get("search-state") ?? DEFAULT_SEARCH_STATE_PATH,
    outputDir: values.get("output-dir") ?? DEFAULT_OUTPUT_DIR,
    manifestOutputPath: values.get("manifest-output") ?? DEFAULT_MANIFEST_OUTPUT_PATH,
    limit: parseOptionalPositiveInteger(values.get("limit"), "limit"),
  };
}

function readCliValues(args: readonly string[]): Map<string, string> {
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
  return values;
}

function parseOptionalPositiveInteger(value: string | undefined, fieldName: string): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${fieldName}: ${value}`);
  return parsed;
}

function readStringField(value: Record<string, unknown>, key: string, source: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`Record is missing string field ${key}: ${source}`);
  }
  return field;
}

function readNumberField(value: Record<string, unknown>, key: string, source: string): number {
  const field = value[key];
  if (typeof field !== "number" || Number.isFinite(field) === false) {
    throw new Error(`Record is missing number field ${key}: ${source}`);
  }
  return field;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "curated_appraisal_alternate_search_seeds_failed", error: message }));
    process.exitCode = 1;
  });
}
