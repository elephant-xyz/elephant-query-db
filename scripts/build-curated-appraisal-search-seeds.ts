import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import AdmZip from "adm-zip";

import {
  buildLeeAppraisalSearchSeed,
  buildLeeSearchAddressSeed,
  buildLeeSearchInputCsv,
  buildLeeSearchPropertySeed,
  isJsonObject,
  type CuratedCommercialCandidate,
  type LeeAppraisalSearchSeed,
} from "../src/loader/index.js";

type BuildSearchSeedOptions = {
  readonly manifestPath: string;
  readonly outputDir: string;
  readonly manifestOutputPath: string;
  readonly limit: number | null;
};

type BuiltSearchSeedRecord = LeeAppraisalSearchSeed & {
  readonly zipPath: string;
  readonly s3KeyHint: string;
};

type CuratedCommercialManifestFile = {
  readonly candidates: readonly CuratedCommercialCandidate[];
};

const DEFAULT_MANIFEST_PATH = ".loader-runs/curated-commercial-sample/curated-commercial-1000-manifest.json";
const DEFAULT_OUTPUT_DIR = ".loader-runs/curated-commercial-appraisal/search-seeds";
const DEFAULT_MANIFEST_OUTPUT_PATH = ".loader-runs/curated-commercial-appraisal/search-seeds-manifest.jsonl";

/**
 * Build one oracle-node downloader input ZIP per curated candidate for the
 * LEEPA STRAP-search phase.
 *
 * The ZIPs intentionally set `input.csv` county to `LeeCurated` so the
 * downloader picks `browser-flows/LeeCurated.json` from S3, while the JSON seed
 * files keep `county_jurisdiction: "Lee"` for appraisal transforms.
 *
 * @returns Promise that resolves after ZIPs and the JSONL manifest are written.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = await readCuratedManifest(options.manifestPath);
  await mkdir(options.outputDir, { recursive: true });
  await mkdir(dirname(options.manifestOutputPath), { recursive: true });

  const selected = options.limit === null
    ? manifest.candidates
    : manifest.candidates.slice(0, options.limit);
  const builtRecords: BuiltSearchSeedRecord[] = [];
  let skipped = 0;

  for (const candidate of selected) {
    const seed = buildLeeAppraisalSearchSeed(candidate);
    if (seed === null) {
      skipped += 1;
      continue;
    }
    const zipPath = join(options.outputDir, `${String(seed.rank).padStart(4, "0")}-${seed.parcelIdentifier}.zip`);
    writeSearchSeedZip(zipPath, seed);
    builtRecords.push({
      ...seed,
      zipPath,
      s3KeyHint: `curated-commercial-1000-20260527/appraisal/search-inputs/${String(seed.rank).padStart(4, "0")}-${seed.parcelIdentifier}.zip`,
    });
  }

  const jsonl = builtRecords.map((record) => JSON.stringify(record)).join("\n").concat("\n");
  await writeFile(options.manifestOutputPath, jsonl, "utf8");
  console.log(JSON.stringify({
    event: "curated_appraisal_search_seeds_built",
    manifestPath: options.manifestPath,
    outputDir: options.outputDir,
    manifestOutputPath: options.manifestOutputPath,
    requestedCandidates: selected.length,
    builtSeeds: builtRecords.length,
    skippedCandidates: skipped,
  }));
}

/**
 * Read and validate the curated commercial sample manifest.
 *
 * @param manifestPath - Path to the JSON manifest written by curated sample selection.
 * @returns Manifest object with typed candidate rows.
 */
async function readCuratedManifest(manifestPath: string): Promise<CuratedCommercialManifestFile> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isJsonObject(parsed) || !Array.isArray(parsed.candidates)) {
    throw new Error(`Curated manifest is missing candidates array: ${manifestPath}`);
  }
  return {
    candidates: parsed.candidates.map(readCandidate),
  };
}

/**
 * Convert one unknown manifest entry into the small candidate shape required
 * for appraisal seed generation.
 *
 * @param value - Unknown JSON candidate entry.
 * @returns Validated curated candidate subset.
 */
function readCandidate(value: unknown): CuratedCommercialCandidate {
  if (!isJsonObject(value)) throw new Error("Curated candidate must be an object");
  const rank = readNumberField(value, "rank");
  const parcelIdentifier = readStringField(value, "parcelIdentifier");
  const bestPermitAddress = readStringField(value, "bestPermitAddress");
  return {
    rank,
    parcelIdentifier,
    rawParcelIdentifiers: [],
    score: readNumberField(value, "score"),
    addressBase: readStringField(value, "addressBase"),
    bestPermitAddress,
    permitCount: readNumberField(value, "permitCount"),
    commercialPermitCount: readNumberField(value, "commercialPermitCount"),
    nonVoidPermitCount: readNumberField(value, "nonVoidPermitCount"),
    inspectionCount: readNumberField(value, "inspectionCount"),
    contactCount: readNumberField(value, "contactCount"),
    permitLinkCount: readNumberField(value, "permitLinkCount"),
    storableDocumentLinkCount: readNumberField(value, "storableDocumentLinkCount"),
    sunbizAddressCount: readNumberField(value, "sunbizAddressCount"),
    sunbizCities: [],
    sunbizPostalCodes: [],
    samplePermits: [],
  };
}

/**
 * Write one appraisal search input ZIP in the shape expected by downloader.
 *
 * @param zipPath - Local output ZIP path.
 * @param seed - Search seed for a single curated parcel.
 */
function writeSearchSeedZip(zipPath: string, seed: LeeAppraisalSearchSeed): void {
  const zip = new AdmZip();
  zip.addFile("property_seed.json", Buffer.from(JSON.stringify(buildLeeSearchPropertySeed(seed)), "utf8"));
  zip.addFile("unnormalized_address.json", Buffer.from(JSON.stringify(buildLeeSearchAddressSeed(seed)), "utf8"));
  zip.addFile("input.csv", Buffer.from(buildLeeSearchInputCsv(seed), "utf8"));
  zip.writeZip(zipPath);
}

/**
 * Parse CLI options for search-seed generation.
 *
 * @param args - Raw command-line arguments after the script name.
 * @returns Normalized options with defaults.
 */
function parseOptions(args: readonly string[]): BuildSearchSeedOptions {
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
    manifestPath: values.get("manifest") ?? DEFAULT_MANIFEST_PATH,
    outputDir: values.get("output-dir") ?? DEFAULT_OUTPUT_DIR,
    manifestOutputPath: values.get("manifest-output") ?? DEFAULT_MANIFEST_OUTPUT_PATH,
    limit: parseLimit(values.get("limit")),
  };
}

/**
 * Parse an optional positive row limit.
 *
 * @param value - Raw CLI limit.
 * @returns Positive integer or `null` when omitted.
 */
function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --limit value: ${value}`);
  return parsed;
}

function readStringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`Curated candidate is missing string field ${key}`);
  }
  return field;
}

function readNumberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || Number.isFinite(field) === false) {
    throw new Error(`Curated candidate is missing number field ${key}`);
  }
  return field;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "curated_appraisal_search_seeds_failed", error: message }));
    process.exitCode = 1;
  });
}
