import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, appendFile, copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";

import { isJsonObject, parseS3Uri } from "../src/loader/index.js";

type TransformRunOptions = {
  readonly detailStatePath: string;
  readonly transformStatePath: string;
  readonly scriptsZipUri: string;
  readonly outputS3Prefix: string;
  readonly oracleNodeDir: string;
  readonly profile: string;
  readonly region: string;
  readonly concurrency: number;
  readonly limit: number | null;
  readonly scriptTimeoutMs: number;
  readonly continueOnError: boolean;
};

type DetailPrepareStateRecord = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly zipPath: string;
  readonly outputS3Uri: string;
};

type TransformStateRecord = {
  readonly event: "transform_completed" | "transform_failed";
  readonly completedAt: string;
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly inputS3Uri: string;
  readonly outputS3Uri: string | null;
  readonly outputFileCount: number | null;
  readonly error: string | null;
};

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

type BodyWithTransformToByteArray = {
  readonly transformToByteArray: () => Promise<Uint8Array>;
};

const DEFAULT_DETAIL_STATE_PATH = ".loader-runs/curated-commercial-appraisal/detail-prepare-state.jsonl";
const DEFAULT_TRANSFORM_STATE_PATH = ".loader-runs/curated-commercial-appraisal/transform-data-only-state.jsonl";
const DEFAULT_SCRIPTS_ZIP_URI = "s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/transforms/lee.zip";
const DEFAULT_OUTPUT_S3_PREFIX = "s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/curated-commercial-1000-20260528/appraisal/transformed-data-only";
const DEFAULT_ORACLE_NODE_DIR = "../oracle-node";
const COUNTY_SCRIPT_NAMES = [
  "ownerMapping.js",
  "structureMapping.js",
  "layoutMapping.js",
  "utilityMapping.js",
  "data_extractor.js",
] as const;

/**
 * Run the Lee appraisal generated scripts and package only `data/*.json`.
 *
 * The stock Elephant transform command generates fact-sheet HTML after the JSON
 * files are created, and that step can exceed Lambda/local time budgets. The
 * query database loader only consumes `data/*.json`, so this runner keeps the
 * useful transform output and deliberately skips fact-sheet generation.
 *
 * @returns Promise that resolves after selected detail prepare outputs are transformed.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  process.env.AWS_PROFILE = options.profile;
  process.env.AWS_REGION = options.region;

  await mkdir(dirname(options.transformStatePath), { recursive: true });
  const completedInputs = await readCompletedDetailPrepareRecords(options.detailStatePath);
  const completedTransforms = await readCompletedTransformInputs(options.transformStatePath);
  const pendingInputs = completedInputs
    .filter((record) => completedTransforms.has(record.outputS3Uri) === false)
    .slice(0, options.limit ?? undefined);

  const s3 = new S3Client({ region: options.region });
  let nextIndex = 0;
  let shouldStop = false;
  const failures: string[] = [];

  console.log(JSON.stringify({
    event: "lee_appraisal_transform_data_only_started",
    detailStatePath: options.detailStatePath,
    transformStatePath: options.transformStatePath,
    scriptsZipUri: options.scriptsZipUri,
    outputS3Prefix: options.outputS3Prefix,
    selectedPendingRecords: pendingInputs.length,
    alreadyCompletedRecords: completedTransforms.size,
    concurrency: options.concurrency,
  }));

  const workers = Array.from({ length: options.concurrency }, async (_unused, workerIndex) => {
    while (shouldStop === false) {
      const recordIndex = nextIndex;
      nextIndex += 1;
      const record = pendingInputs[recordIndex];
      if (record === undefined) return;

      try {
        const stateRecord = await transformRecord({ options, record, s3 });
        await appendStateRecord(options.transformStatePath, stateRecord);
        console.log(JSON.stringify({
          event: "lee_appraisal_transform_data_only_completed",
          workerIndex,
          rank: record.rank,
          parcelIdentifier: record.parcelIdentifier,
          outputS3Uri: stateRecord.outputS3Uri,
          outputFileCount: stateRecord.outputFileCount,
          completedCount: recordIndex + 1,
          selectedPendingRecords: pendingInputs.length,
        }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        failures.push(message);
        await appendStateRecord(options.transformStatePath, {
          event: "transform_failed",
          completedAt: new Date().toISOString(),
          rank: record.rank,
          parcelIdentifier: record.parcelIdentifier,
          inputS3Uri: record.outputS3Uri,
          outputS3Uri: null,
          outputFileCount: null,
          error: message,
        });
        console.error(JSON.stringify({
          event: "lee_appraisal_transform_data_only_failed_record",
          workerIndex,
          rank: record.rank,
          parcelIdentifier: record.parcelIdentifier,
          error: message,
        }));
        if (options.continueOnError === false) shouldStop = true;
      }
    }
  });

  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(`${failures.length} Lee appraisal transform(s) failed; see ${options.transformStatePath}`);
  }
}

async function transformRecord(params: {
  readonly options: TransformRunOptions;
  readonly record: DetailPrepareStateRecord;
  readonly s3: S3Client;
}): Promise<TransformStateRecord> {
  const tempRoot = await mkdtemp(join(tmpdir(), "lee-transform-data-only-"));
  try {
    const inputZipPath = join(tempRoot, "input.zip");
    const scriptsZipPath = join(tempRoot, "scripts.zip");
    const outputZipPath = join(tempRoot, "transformed_output.zip");
    await writeFile(inputZipPath, await readArtifactBuffer(params.s3, params.record.outputS3Uri));
    await writeFile(scriptsZipPath, await readArtifactBuffer(params.s3, params.options.scriptsZipUri));

    const inputDir = join(tempRoot, "input");
    const scriptsDir = join(tempRoot, "scripts");
    const dataDir = join(tempRoot, "data");
    await mkdir(inputDir, { recursive: true });
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    new AdmZip(inputZipPath).extractAllTo(inputDir, true);
    new AdmZip(scriptsZipPath).extractAllTo(scriptsDir, true);
    await normalizeInputsForScripts(inputDir, tempRoot);
    await linkOracleNodeModules(params.options.oracleNodeDir, tempRoot);
    for (const scriptName of COUNTY_SCRIPT_NAMES) {
      const scriptPath = await findFileRecursive(scriptsDir, scriptName);
      if (scriptPath === null) throw new Error(`Required Lee transform script not found: ${scriptName}`);
      const result = await runNodeScript(scriptPath, tempRoot, params.options.scriptTimeoutMs);
      if (result.code !== 0) {
        throw new Error(`Script ${scriptName} failed code=${String(result.code)} timedOut=${String(result.timedOut)} stderr=${tail(result.stderr) || tail(result.stdout)}`);
      }
    }

    const outputFileCount = await finalizeDataJsonFiles(tempRoot, dataDir);
    writeDataZip(dataDir, outputZipPath);
    const outputS3Uri = joinS3Uri(
      params.options.outputS3Prefix,
      `${stripZipExtension(basename(params.record.zipPath))}/transformed_output.zip`,
    );
    await uploadArtifactBuffer(params.s3, outputS3Uri, await readFile(outputZipPath));
    return {
      event: "transform_completed",
      completedAt: new Date().toISOString(),
      rank: params.record.rank,
      parcelIdentifier: params.record.parcelIdentifier,
      inputS3Uri: params.record.outputS3Uri,
      outputS3Uri,
      outputFileCount,
      error: null,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function normalizeInputsForScripts(inputDir: string, tempRoot: string): Promise<void> {
  for (const fileName of ["address.json", "parcel.json", "unnormalized_address.json", "property_seed.json"]) {
    await copyIfFileExists(join(inputDir, fileName), join(tempRoot, fileName));
  }
  const entries = await readdir(inputDir, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const htmlFileNames = fileNames.filter((fileName) => /\.html?$/i.test(fileName));
  const primaryHtml = htmlFileNames.find((fileName) => /cost.?card|tax.?roll.?letter/i.test(fileName) === false)
    ?? htmlFileNames[0];
  const htmlOrJson = primaryHtml
    ?? fileNames.find((fileName) => /\.json$/i.test(fileName) && [
      "address.json",
      "parcel.json",
      "unnormalized_address.json",
      "property_seed.json",
    ].includes(fileName) === false);
  if (htmlOrJson !== undefined) {
    const destinationName = /\.html?$/i.test(htmlOrJson) ? "input.html" : "input.json";
    await copyFile(join(inputDir, htmlOrJson), join(tempRoot, destinationName));
  }
  for (const fileName of htmlFileNames) {
    if (fileName === primaryHtml) continue;
    await copyFile(join(inputDir, fileName), join(tempRoot, fileName));
  }
  for (const fileName of fileNames.filter((entry) => /(?:^|_)source_http_request\.json$/i.test(entry))) {
    await copyFile(join(inputDir, fileName), join(tempRoot, fileName));
  }
  for (const fileName of fileNames.filter((entry) => /\.csv$/i.test(entry))) {
    await copyFile(join(inputDir, fileName), join(tempRoot, fileName));
  }
}

async function finalizeDataJsonFiles(tempRoot: string, dataDir: string): Promise<number> {
  const addressSeed = await readSeedJson(tempRoot, "address.json")
    ?? await readSeedJson(tempRoot, "unnormalized_address.json");
  if (addressSeed === null) throw new Error("Lee transform input is missing address/unnormalized_address seed");
  const sourceHttpRequest = isJsonObject(addressSeed.source_http_request) ? addressSeed.source_http_request : null;
  const requestIdentifier = typeof addressSeed.request_identifier === "string" ? addressSeed.request_identifier : null;
  if (requestIdentifier === null) throw new Error("Lee transform input seed is missing request_identifier");

  for (const fileName of ["address.json", "parcel.json", "unnormalized_address.json", "property_seed.json"]) {
    const sourcePath = join(tempRoot, fileName);
    const destinationPath = join(dataDir, fileName);
    const destinationExists = await fileExists(destinationPath);
    if (destinationExists === false) await copyIfFileExists(sourcePath, destinationPath);
  }

  const dataFileNames = (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  for (const fileName of dataFileNames) {
    const filePath = join(dataDir, fileName);
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isJsonObject(parsed)) continue;
    if (!isJsonObject(parsed.source_http_request) && sourceHttpRequest !== null) {
      parsed.source_http_request = sourceHttpRequest;
    }
    parsed.request_identifier = requestIdentifier;
    await writeFile(filePath, JSON.stringify(parsed), "utf8");
  }
  return dataFileNames.length;
}

function writeDataZip(dataDir: string, outputZipPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(dataDir, "data");
  zip.writeZip(outputZipPath);
}

async function runNodeScript(scriptPath: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--unhandled-rejections=strict",
      "--trace-uncaught",
      scriptPath,
    ], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (settled === false) {
        settled = true;
        resolve({ code: -1, stdout, stderr, timedOut: true });
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut: false });
    });
    child.on("error", (caught) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${caught.message}`, timedOut: false });
    });
  });
}

async function linkOracleNodeModules(oracleNodeDir: string, tempRoot: string): Promise<void> {
  const source = resolve(oracleNodeDir, "node_modules");
  const destination = join(tempRoot, "node_modules");
  if (await fileExists(destination)) return;
  await symlink(source, destination, "dir");
}

async function readArtifactBuffer(s3: S3Client, artifactUri: string): Promise<Buffer> {
  if (artifactUri.startsWith("s3://") === false) return readFile(artifactUri);
  const { bucket, key } = parseS3Uri(artifactUri);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body;
  if (body === undefined || isBodyWithTransformToByteArray(body) === false) {
    throw new Error(`S3 object had no readable body: ${artifactUri}`);
  }
  return Buffer.from(await body.transformToByteArray());
}

async function uploadArtifactBuffer(s3: S3Client, artifactUri: string, body: Buffer): Promise<void> {
  const { bucket, key } = parseS3Uri(artifactUri);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function readCompletedDetailPrepareRecords(statePath: string): Promise<readonly DetailPrepareStateRecord[]> {
  const text = await readFile(statePath, "utf8");
  const records: DetailPrepareStateRecord[] = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed) || parsed.event !== "prepare_completed") continue;
    records.push({
      rank: readRequiredNumber(parsed, "rank", `${statePath}:${String(lineIndex + 1)}`),
      parcelIdentifier: readRequiredString(parsed, "parcelIdentifier", `${statePath}:${String(lineIndex + 1)}`),
      zipPath: readRequiredString(parsed, "zipPath", `${statePath}:${String(lineIndex + 1)}`),
      outputS3Uri: readRequiredString(parsed, "outputS3Uri", `${statePath}:${String(lineIndex + 1)}`),
    });
  }
  return records;
}

async function readCompletedTransformInputs(statePath: string): Promise<ReadonlySet<string>> {
  let text = "";
  try {
    text = await readFile(statePath, "utf8");
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
      return new Set<string>();
    }
    throw caught;
  }
  const completed = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (isJsonObject(parsed) && parsed.event === "transform_completed" && typeof parsed.inputS3Uri === "string") {
      completed.add(parsed.inputS3Uri);
    }
  }
  return completed;
}

async function appendStateRecord(statePath: string, record: TransformStateRecord): Promise<void> {
  await appendFile(statePath, JSON.stringify(record).concat("\n"), "utf8");
}

async function readSeedJson(tempRoot: string, fileName: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(tempRoot, fileName), "utf8"));
    return isJsonObject(parsed) ? parsed : null;
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return null;
    throw caught;
  }
}

async function copyIfFileExists(source: string, destination: string): Promise<void> {
  try {
    const sourceStat = await stat(source);
    if (sourceStat.isFile()) await copyFile(source, destination);
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return;
    throw caught;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return false;
    throw caught;
  }
}

async function findFileRecursive(root: string, fileName: string): Promise<string | null> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile() && entry.name === fileName) {
        return absolutePath;
      }
    }
  }
  return null;
}

function isBodyWithTransformToByteArray(value: unknown): value is BodyWithTransformToByteArray {
  return isJsonObject(value) && typeof value.transformToByteArray === "function";
}

function parseOptions(args: readonly string[]): TransformRunOptions {
  const values = readCliValues(args);
  return {
    detailStatePath: values.get("detail-state") ?? DEFAULT_DETAIL_STATE_PATH,
    transformStatePath: values.get("state") ?? DEFAULT_TRANSFORM_STATE_PATH,
    scriptsZipUri: values.get("scripts-zip") ?? DEFAULT_SCRIPTS_ZIP_URI,
    outputS3Prefix: values.get("output-s3-prefix") ?? DEFAULT_OUTPUT_S3_PREFIX,
    oracleNodeDir: values.get("oracle-node-dir") ?? DEFAULT_ORACLE_NODE_DIR,
    profile: values.get("profile") ?? process.env.AWS_PROFILE ?? "elephant-oracle-node",
    region: values.get("region") ?? process.env.AWS_REGION ?? "us-east-1",
    concurrency: parsePositiveInteger(values.get("concurrency"), 1, "concurrency"),
    limit: parseOptionalPositiveInteger(values.get("limit"), "limit"),
    scriptTimeoutMs: parsePositiveInteger(values.get("script-timeout-ms"), 120_000, "script-timeout-ms"),
    continueOnError: values.get("continue-on-error") === "true",
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

function parsePositiveInteger(value: string | undefined, defaultValue: number, fieldName: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${fieldName}: ${value}`);
  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, fieldName: string): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  return parsePositiveInteger(value, 1, fieldName);
}

function readRequiredString(value: Record<string, unknown>, key: string, source: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`State line is missing string field ${key}: ${source}`);
  }
  return field;
}

function readRequiredNumber(value: Record<string, unknown>, key: string, source: string): number {
  const field = value[key];
  if (typeof field !== "number" || Number.isFinite(field) === false) {
    throw new Error(`State line is missing number field ${key}: ${source}`);
  }
  return field;
}

function joinS3Uri(prefix: string, keyPart: string): string {
  return `${prefix.replace(/\/+$/, "")}/${keyPart.replace(/^\/+/, "")}`;
}

function stripZipExtension(value: string): string {
  return value.toLowerCase().endsWith(".zip") ? value.slice(0, -4) : value;
}

function tail(value: string): string {
  return value.split(/\r?\n/).slice(-20).join("\n").trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "lee_appraisal_transform_data_only_failed", error: message }));
    process.exitCode = 1;
  });
}
