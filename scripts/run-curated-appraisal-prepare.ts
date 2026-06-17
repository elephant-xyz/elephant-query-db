import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { isJsonObject, parseS3Uri } from "../src/loader/index.js";

type PrepareRunOptions = {
  readonly manifestPath: string;
  readonly statePath: string;
  readonly inputS3Prefix: string;
  readonly outputS3Prefix: string;
  readonly functionName: string;
  readonly profile: string;
  readonly region: string;
  readonly concurrency: number;
  readonly limit: number | null;
  readonly cliReadTimeoutSeconds: number;
  readonly continueOnError: boolean;
  readonly skipFailed: boolean;
};

type PrepareManifestRecord = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly zipPath: string;
  readonly bestPermitAddress: string | null;
  readonly requestIdentifier: string | null;
  readonly leeStrap: string | null;
};

type PrepareStateRecord = {
  readonly event: "prepare_completed" | "prepare_failed";
  readonly completedAt: string;
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly zipPath: string;
  readonly bestPermitAddress: string | null;
  readonly requestIdentifier: string | null;
  readonly leeStrap: string | null;
  readonly inputS3Uri: string;
  readonly outputS3Prefix: string;
  readonly outputS3Uri: string | null;
  readonly error: string | null;
};

type LambdaInvokeResponse = {
  readonly StatusCode?: number;
  readonly FunctionError?: string;
  readonly ExecutedVersion?: string;
};

type DownloaderPayload = {
  readonly input_s3_uri: string;
  readonly output_s3_uri_prefix: string;
};

type DownloaderResponse = {
  readonly output_s3_uri?: string;
  readonly county?: string;
};

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
};

const DEFAULT_MANIFEST_PATH = ".loader-runs/curated-commercial-appraisal/search-seeds-manifest.jsonl";
const DEFAULT_STATE_PATH = ".loader-runs/curated-commercial-appraisal/search-prepare-state.jsonl";
const DEFAULT_INPUT_S3_PREFIX = "s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/curated-commercial-1000-20260528/appraisal/search-inputs";
const DEFAULT_OUTPUT_S3_PREFIX = "s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/curated-commercial-1000-20260528/appraisal/search-results";
const DEFAULT_DOWNLOADER_FUNCTION_NAME = "elephant-oracle-node-DownloaderFunction-8GbNMvP3cL1H";

/**
 * Upload curated oracle-node prepare ZIPs to S3 and invoke the downloader Lambda
 * synchronously with bounded local concurrency.
 *
 * This runner is intentionally queue-free: it does not enable Lambda event
 * source mappings or enqueue SQS messages. Each completed/failed ZIP is recorded
 * in a local JSONL state file so the run can be resumed.
 *
 * @returns Promise that resolves after all selected pending ZIPs are processed.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  process.env.AWS_PROFILE = options.profile;
  process.env.AWS_REGION = options.region;

  await mkdir(dirname(options.statePath), { recursive: true });
  const manifestRecords = await readManifest(options.manifestPath);
  const completedZipPaths = await readProcessedZipPaths(options.statePath, options.skipFailed);
  const pendingRecords = manifestRecords
    .filter((record) => completedZipPaths.has(record.zipPath) === false)
    .slice(0, options.limit ?? undefined);

  const s3 = new S3Client({ region: options.region });
  let nextIndex = 0;
  let shouldStop = false;
  const failures: string[] = [];

  console.log(JSON.stringify({
    event: "curated_appraisal_prepare_started",
    manifestPath: options.manifestPath,
    statePath: options.statePath,
    inputS3Prefix: options.inputS3Prefix,
    outputS3Prefix: options.outputS3Prefix,
    functionName: options.functionName,
    concurrency: options.concurrency,
    selectedPendingRecords: pendingRecords.length,
    skippedStateRecords: completedZipPaths.size,
  }));

  const workers = Array.from({ length: options.concurrency }, async (_unused, workerIndex) => {
    while (shouldStop === false) {
      const recordIndex = nextIndex;
      nextIndex += 1;
      const record = pendingRecords[recordIndex];
      if (record === undefined) return;

      try {
        const stateRecord = await processRecord({
          options,
          record,
          s3,
        });
        await appendStateRecord(options.statePath, stateRecord);
        console.log(JSON.stringify({
          event: "curated_appraisal_prepare_completed",
          workerIndex,
          rank: record.rank,
          parcelIdentifier: record.parcelIdentifier,
          outputS3Uri: stateRecord.outputS3Uri,
          completedCount: recordIndex + 1,
          selectedPendingRecords: pendingRecords.length,
        }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        failures.push(message);
        const failedRecord = buildFailedStateRecord({ options, record, error: message });
        await appendStateRecord(options.statePath, failedRecord);
        console.error(JSON.stringify({
          event: "curated_appraisal_prepare_failed_record",
          workerIndex,
          rank: record.rank,
          parcelIdentifier: record.parcelIdentifier,
          error: message,
        }));
        if (options.continueOnError === false) {
          shouldStop = true;
        }
      }
    }
  });

  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(`${failures.length} prepare invocation(s) failed; see ${options.statePath}`);
  }

  console.log(JSON.stringify({
    event: "curated_appraisal_prepare_finished",
    processedRecords: pendingRecords.length,
    statePath: options.statePath,
  }));
}

async function processRecord(params: {
  readonly options: PrepareRunOptions;
  readonly record: PrepareManifestRecord;
  readonly s3: S3Client;
}): Promise<PrepareStateRecord> {
  const zipName = basename(params.record.zipPath);
  const inputS3Uri = joinS3Uri(params.options.inputS3Prefix, zipName);
  const outputS3Prefix = joinS3Uri(params.options.outputS3Prefix, stripZipExtension(zipName));
  await uploadZip(params.s3, params.record.zipPath, inputS3Uri);

  const downloaderPayload: DownloaderPayload = {
    input_s3_uri: inputS3Uri,
    output_s3_uri_prefix: outputS3Prefix,
  };
  const invokeResult = await invokeDownloader({
    options: params.options,
    payload: downloaderPayload,
  });
  if (invokeResult.output_s3_uri === undefined || invokeResult.output_s3_uri.trim().length === 0) {
    throw new Error(`Downloader response did not include output_s3_uri for ${params.record.zipPath}`);
  }

  return {
    event: "prepare_completed",
    completedAt: new Date().toISOString(),
    rank: params.record.rank,
    parcelIdentifier: params.record.parcelIdentifier,
    zipPath: params.record.zipPath,
    bestPermitAddress: params.record.bestPermitAddress,
    requestIdentifier: params.record.requestIdentifier,
    leeStrap: params.record.leeStrap,
    inputS3Uri,
    outputS3Prefix,
    outputS3Uri: invokeResult.output_s3_uri,
    error: null,
  };
}

async function uploadZip(s3: S3Client, zipPath: string, inputS3Uri: string): Promise<void> {
  const { bucket, key } = parseS3Uri(inputS3Uri);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: await readFile(zipPath),
  }));
}

async function invokeDownloader(params: {
  readonly options: PrepareRunOptions;
  readonly payload: DownloaderPayload;
}): Promise<DownloaderResponse> {
  const tempDir = await mkdtemp(join(tmpdir(), "curated-prepare-"));
  try {
    const payloadPath = join(tempDir, "payload.json");
    const responsePath = join(tempDir, "response.json");
    await writeFile(payloadPath, JSON.stringify(params.payload), "utf8");
    const commandResult = await runCommand("aws", [
      "lambda",
      "invoke",
      "--profile",
      params.options.profile,
      "--region",
      params.options.region,
      "--function-name",
      params.options.functionName,
      "--payload",
      `fileb://${payloadPath}`,
      "--cli-read-timeout",
      String(params.options.cliReadTimeoutSeconds),
      "--cli-connect-timeout",
      "20",
      responsePath,
    ]);
    const cliResponse = parseJsonObject<LambdaInvokeResponse>(commandResult.stdout, "lambda invoke CLI response");
    if (cliResponse.StatusCode !== 200) {
      throw new Error(`Lambda invoke returned status ${String(cliResponse.StatusCode)}: ${commandResult.stderr}`);
    }
    const functionResponseText = await readFile(responsePath, "utf8");
    if (cliResponse.FunctionError !== undefined) {
      throw new Error(`Downloader function error ${cliResponse.FunctionError}: ${functionResponseText}`);
    }
    return parseJsonObject<DownloaderResponse>(functionResponseText, "downloader function response");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (caught) => {
      reject(caught);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${String(code)}: ${stderr}`));
    });
  });
}

async function readManifest(manifestPath: string): Promise<readonly PrepareManifestRecord[]> {
  const text = await readFile(manifestPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => readManifestRecord(JSON.parse(line), `${manifestPath}:${String(index + 1)}`));
}

function readManifestRecord(value: unknown, source: string): PrepareManifestRecord {
  if (!isJsonObject(value)) throw new Error(`Manifest line must be an object: ${source}`);
  return {
    rank: readRequiredNumber(value, "rank", source),
    parcelIdentifier: readRequiredString(value, "parcelIdentifier", source),
    zipPath: readRequiredString(value, "zipPath", source),
    bestPermitAddress: readOptionalString(value, "bestPermitAddress"),
    requestIdentifier: readOptionalString(value, "requestIdentifier"),
    leeStrap: readOptionalString(value, "leeStrap"),
  };
}

async function readProcessedZipPaths(statePath: string, includeFailures: boolean): Promise<ReadonlySet<string>> {
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
    if (!isJsonObject(parsed)) continue;
    const isSkippableEvent = parsed.event === "prepare_completed"
      || (includeFailures && parsed.event === "prepare_failed");
    if (isSkippableEvent && typeof parsed.zipPath === "string") {
      completed.add(parsed.zipPath);
    }
  }
  return completed;
}

async function appendStateRecord(statePath: string, record: PrepareStateRecord): Promise<void> {
  await appendFile(statePath, JSON.stringify(record).concat("\n"), "utf8");
}

function buildFailedStateRecord(params: {
  readonly options: PrepareRunOptions;
  readonly record: PrepareManifestRecord;
  readonly error: string;
}): PrepareStateRecord {
  const zipName = basename(params.record.zipPath);
  return {
    event: "prepare_failed",
    completedAt: new Date().toISOString(),
    rank: params.record.rank,
    parcelIdentifier: params.record.parcelIdentifier,
    zipPath: params.record.zipPath,
    bestPermitAddress: params.record.bestPermitAddress,
    requestIdentifier: params.record.requestIdentifier,
    leeStrap: params.record.leeStrap,
    inputS3Uri: joinS3Uri(params.options.inputS3Prefix, zipName),
    outputS3Prefix: joinS3Uri(params.options.outputS3Prefix, stripZipExtension(zipName)),
    outputS3Uri: null,
    error: params.error,
  };
}

function parseJsonObject<T extends Record<string, unknown>>(text: string, label: string): T {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new Error(`Expected ${label} to be a JSON object`);
  return parsed as T;
}

function parseOptions(args: readonly string[]): PrepareRunOptions {
  const values = readCliValues(args);
  const profile = values.get("profile") ?? process.env.AWS_PROFILE ?? "elephant-oracle-node";
  const region = values.get("region") ?? process.env.AWS_REGION ?? "us-east-1";
  return {
    manifestPath: values.get("manifest") ?? DEFAULT_MANIFEST_PATH,
    statePath: values.get("state") ?? DEFAULT_STATE_PATH,
    inputS3Prefix: values.get("input-s3-prefix") ?? DEFAULT_INPUT_S3_PREFIX,
    outputS3Prefix: values.get("output-s3-prefix") ?? DEFAULT_OUTPUT_S3_PREFIX,
    functionName: values.get("function-name") ?? process.env.DOWNLOADER_FUNCTION_NAME ?? DEFAULT_DOWNLOADER_FUNCTION_NAME,
    profile,
    region,
    concurrency: parsePositiveInteger(values.get("concurrency"), 2, "concurrency"),
    limit: parseOptionalPositiveInteger(values.get("limit"), "limit"),
    cliReadTimeoutSeconds: parsePositiveInteger(values.get("cli-read-timeout"), 900, "cli-read-timeout"),
    continueOnError: values.get("continue-on-error") === "true",
    skipFailed: values.get("skip-failed") === "true",
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
    throw new Error(`Manifest line is missing string field ${key}: ${source}`);
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
    throw new Error(`Manifest line is missing number field ${key}: ${source}`);
  }
  return field;
}

function joinS3Uri(prefix: string, keyPart: string): string {
  return `${prefix.replace(/\/+$/, "")}/${keyPart.replace(/^\/+/, "")}`;
}

function stripZipExtension(value: string): string {
  const extension = extname(value);
  return extension.toLowerCase() === ".zip" ? value.slice(0, -extension.length) : value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "curated_appraisal_prepare_failed", error: message }));
    process.exitCode = 1;
  });
}
