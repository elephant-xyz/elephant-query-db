import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PutObjectCommand,
  type S3Client,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import type {
  DeserializeHandler,
  DeserializeHandlerArguments,
  DeserializeHandlerOutput,
  DeserializeMiddleware,
  HandlerExecutionContext,
} from "@smithy/types";

/**
 * Dataset-coverage PUBLISH mechanics.
 *
 * Publishes ONLY the single per-county `dataset-coverage.json` under its OWN
 * IPNS pointer (`oracle-dataset-coverage-<county>`), so the MCP can read it via
 * DATASET_COVERAGE_MAP and `getOracleDatasetInfo` can report per-source count/%/
 * date-range. It shares none of the property / query-table / permit-table
 * surface and HARD-REFUSES to write any of those labels — re-pointing one would
 * clobber that dataset.
 *
 * All external collaborators (the S3 client, the Filebase IPNS REST `fetch`, and
 * the credential/label source `env`) are injected so the publish mechanics are
 * unit-testable without any network I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoveragePublishEnv = Record<string, string | undefined>;

export type CoverageGatewayUrls = {
  /** Filebase's own gateway — the reliable form for the MCP HTTP read. */
  readonly filebase: string;
  /** Public dweb.link subdomain gateway (secondary). */
  readonly dweb: string;
};

export type CoveragePublishResult = {
  readonly key: string;
  readonly cid: string;
  readonly ipnsLabel: string;
  readonly ipnsName: string;
  readonly gatewayUrls: CoverageGatewayUrls;
};

/** Minimal S3 surface we use — satisfied by the AWS SDK v3 `S3Client`. */
type CoverageUploadClient = Pick<S3Client, "send" | "middlewareStack">;

/** Minimal Filebase IPNS REST response surface. */
type FilebaseFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json: () => Promise<unknown>;
};

/** Injected `fetch` for the Filebase IPNS REST API. */
type CoverageFetch = (
  url: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FilebaseFetchResponse>;

type FilebaseIpnsName = {
  readonly enabled: boolean;
  readonly label: string;
  readonly network_key: string;
  readonly cid: string;
  readonly sequence: number;
  readonly published_at: string;
  readonly created_at: string;
  readonly updated_at: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSON_CONTENT_TYPE = "application/json";

const REQUIRED_CREDENTIALS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "FILEBASE_API_TOKEN",
] as const;

const FILEBASE_IPNS_API = "https://api.filebase.io/v1/names";

// ---------------------------------------------------------------------------
// Pure helpers (the tested contract)
// ---------------------------------------------------------------------------

function normalizeCounty(county: string): string {
  return county.trim().toLowerCase();
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The property dataset's IPNS label — must never be re-pointed here. */
export function propertyIpnsLabel(county: string): string {
  return `oracle-open-data-${normalizeCounty(county)}`;
}

/** The geo-index IPNS label — must never be re-pointed here. */
export function geoIndexIpnsLabel(county: string): string {
  return `oracle-geo-index-${normalizeCounty(county)}`;
}

/** The property query-table IPNS label — must never be re-pointed here. */
export function queryTableIpnsLabel(county: string): string {
  return `oracle-query-table-${normalizeCounty(county)}`;
}

/** The permit-table IPNS label — must never be re-pointed here. */
export function permitTableIpnsLabel(county: string): string {
  return `oracle-permit-table-${normalizeCounty(county)}`;
}

/** The county-generic default IPNS label for the coverage snapshot. */
export function defaultCoverageIpnsLabel(county: string): string {
  return `oracle-dataset-coverage-${normalizeCounty(county)}`;
}

/** The single object key for the coverage JSON. */
export function buildCoverageKey(county: string): string {
  return `dataset-coverage/${normalizeCounty(county)}/dataset-coverage.json`;
}

/**
 * The two gateway URL forms the MCP can read the coverage JSON through. The
 * IPNS points at the single JSON object, so both URLs return the JSON directly.
 * The Filebase form is used for DATASET_COVERAGE_MAP.
 */
export function buildCoverageGatewayUrls(networkKey: string): CoverageGatewayUrls {
  const key = networkKey.trim();
  return {
    filebase: `https://ipfs.filebase.io/ipns/${key}`,
    dweb: `https://${key}.ipns.dweb.link/`,
  };
}

/**
 * Resolve the coverage IPNS label from `FILEBASE_COVERAGE_IPNS_LABEL`, or fall
 * back to `oracle-dataset-coverage-<county>`. Throws when the resolved label is
 * any other dataset's label (property, geo, query-table, permit-table), so the
 * coverage pointer can never clobber another dataset.
 */
export function resolveCoverageIpnsLabel(env: CoveragePublishEnv, county: string): string {
  const label =
    trimToUndefined(env["FILEBASE_COVERAGE_IPNS_LABEL"]) ?? defaultCoverageIpnsLabel(county);

  const guarded: ReadonlyArray<readonly [string, string]> = [
    [propertyIpnsLabel(county), "property dataset"],
    [geoIndexIpnsLabel(county), "geo-index"],
    [queryTableIpnsLabel(county), "query-table"],
    [permitTableIpnsLabel(county), "permit-table"],
  ];
  for (const [reserved, name] of guarded) {
    if (label === reserved) {
      throw new Error(
        `Refusing to publish dataset coverage under the ${name} label "${reserved}". ` +
          `Set FILEBASE_COVERAGE_IPNS_LABEL to a separate label (e.g. ${defaultCoverageIpnsLabel(county)}) ` +
          `so the coverage pointer cannot clobber the ${name} dataset.`,
      );
    }
  }

  return label;
}

function requireCredential(env: CoveragePublishEnv, name: string): string {
  const value = trimToUndefined(env[name]);
  if (value === undefined) {
    throw new Error(
      `Required Filebase/S3 credential ${name} is not set. Export it from the vault credentials before publishing dataset coverage.`,
    );
  }
  return value;
}

/** Throw an explicit, named error when any required credential is missing. */
export function assertFilebaseCredentials(env: CoveragePublishEnv): void {
  for (const name of REQUIRED_CREDENTIALS) {
    requireCredential(env, name);
  }
}

// ---------------------------------------------------------------------------
// CID derivation
// ---------------------------------------------------------------------------

interface RawHttpResponse {
  headers: Record<string, string>;
  statusCode: number;
}

function isRawHttpResponse(value: unknown): value is RawHttpResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "headers" in value &&
    typeof (value as RawHttpResponse).headers === "object"
  );
}

/** Compute the IPFS CID of a buffer locally (no network). */
async function computeIpfsCid(content: Buffer): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const ipfsHash = require("ipfs-only-hash") as { of: (content: Buffer) => Promise<string> };
    const cid = await ipfsHash.of(content);
    return trimToUndefined(cid);
  } catch {
    return undefined;
  }
}

/** PUT the single JSON object and capture the `x-amz-meta-cid` header. */
async function putCoverageObject(
  client: CoverageUploadClient,
  params: { readonly bucket: string; readonly key: string; readonly body: Buffer },
): Promise<string | undefined> {
  let capturedHeaders: Record<string, string> | undefined;

  const captureMiddleware: DeserializeMiddleware<ServiceInputTypes, ServiceOutputTypes> =
    (
      next: DeserializeHandler<ServiceInputTypes, ServiceOutputTypes>,
      _context: HandlerExecutionContext,
    ) =>
    async (
      args: DeserializeHandlerArguments<ServiceInputTypes>,
    ): Promise<DeserializeHandlerOutput<ServiceOutputTypes>> => {
      const result = await next(args);
      if (isRawHttpResponse(result.response)) {
        capturedHeaders = result.response.headers;
      }
      return result;
    };

  client.middlewareStack.add(captureMiddleware, {
    step: "deserialize",
    name: "captureCoverageCidHeader",
    priority: "low",
  });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: JSON_CONTENT_TYPE,
      }),
    );
  } finally {
    client.middlewareStack.remove("captureCoverageCidHeader");
  }

  return capturedHeaders?.["x-amz-meta-cid"];
}

// ---------------------------------------------------------------------------
// Filebase IPNS REST helpers (injected fetch — no implicit global)
// ---------------------------------------------------------------------------

function ipnsHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
}

async function listIpnsNames(fetchImpl: CoverageFetch, apiToken: string): Promise<FilebaseIpnsName[]> {
  const response = await fetchImpl(FILEBASE_IPNS_API, { method: "GET", headers: ipnsHeaders(apiToken) });
  if (!response.ok) {
    throw new Error(`Filebase IPNS list failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as FilebaseIpnsName[];
}

async function createIpnsName(
  fetchImpl: CoverageFetch,
  apiToken: string,
  label: string,
  cid: string,
): Promise<FilebaseIpnsName> {
  const response = await fetchImpl(FILEBASE_IPNS_API, {
    method: "POST",
    headers: ipnsHeaders(apiToken),
    body: JSON.stringify({ label, cid, enabled: true }),
  });
  if (!response.ok) {
    throw new Error(`Filebase IPNS create failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as FilebaseIpnsName;
}

async function updateIpnsName(
  fetchImpl: CoverageFetch,
  apiToken: string,
  label: string,
  cid: string,
): Promise<void> {
  const response = await fetchImpl(`${FILEBASE_IPNS_API}/${encodeURIComponent(label)}`, {
    method: "PUT",
    headers: ipnsHeaders(apiToken),
    body: JSON.stringify({ cid, enabled: true }),
  });
  if (!response.ok) {
    throw new Error(`Filebase IPNS update failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Create the coverage IPNS label if absent, then re-point it at the JSON CID.
 * Returns the resolvable IPNS name (`network_key`, `k51q…`).
 */
async function upsertCoverageIpnsPointer(
  fetchImpl: CoverageFetch,
  apiToken: string,
  label: string,
  cid: string,
): Promise<string> {
  const names = await listIpnsNames(fetchImpl, apiToken);
  const existing = names.find((name) => name.label === label);

  if (existing === undefined) {
    const created = await createIpnsName(fetchImpl, apiToken, label, cid);
    return created.network_key;
  }

  await updateIpnsName(fetchImpl, apiToken, label, cid);
  return existing.network_key;
}

// ---------------------------------------------------------------------------
// Publish flow
// ---------------------------------------------------------------------------

/**
 * Publish the single `dataset-coverage.json` object and re-point its OWN IPNS
 * label at the derived CID. Validation order is load-bearing:
 *   1. credentials (throws before any upload/IPNS call when missing),
 *   2. label resolution + clobber guard (throws before any write),
 *   3. upload the single object and derive its CID,
 *   4. re-point the coverage IPNS label.
 */
export async function uploadCoverage(opts: {
  client: CoverageUploadClient;
  fetchImpl: CoverageFetch;
  env: CoveragePublishEnv;
  county: string;
  body: Buffer;
}): Promise<CoveragePublishResult> {
  assertFilebaseCredentials(opts.env);
  const ipnsLabel = resolveCoverageIpnsLabel(opts.env, opts.county);

  const bucket = requireCredential(opts.env, "S3_BUCKET");
  const apiToken = requireCredential(opts.env, "FILEBASE_API_TOKEN");
  const key = buildCoverageKey(opts.county);

  const headerCid = await putCoverageObject(opts.client, { bucket, key, body: opts.body });
  const localCid = await computeIpfsCid(opts.body);
  const cid = localCid ?? trimToUndefined(headerCid);

  if (cid === undefined) {
    throw new Error(
      `Failed to derive a coverage CID for ${key}. Filebase returned no x-amz-meta-cid header and local CID computation failed.`,
    );
  }

  const ipnsName = await upsertCoverageIpnsPointer(opts.fetchImpl, apiToken, ipnsLabel, cid);

  return { key, cid, ipnsLabel, ipnsName, gatewayUrls: buildCoverageGatewayUrls(ipnsName) };
}

// ---------------------------------------------------------------------------
// Env file loader (mirrors upload-query-table-to-filebase.ts)
// ---------------------------------------------------------------------------

function loadEnvFile(envFile: string): void {
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex);
      let value = trimmed.slice(equalsIndex + 1);
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (caught) {
    if (
      caught instanceof Error &&
      "code" in caught &&
      (caught as NodeJS.ErrnoException).code === "ENOENT"
    )
      return;
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point (only when invoked directly)
// ---------------------------------------------------------------------------

type CoveragePublishCliOptions = {
  readonly county: string;
  readonly coveragePath: string;
  readonly envFile: string;
  readonly dryRun: boolean;
};

function parseCliOptions(argv: readonly string[]): CoveragePublishCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const county = normalizeCounty(values.get("county") ?? "lee");
  const coverage = values.get("coverage");
  return {
    county,
    coveragePath:
      coverage !== undefined && coverage !== "true"
        ? coverage
        : join(".dataset-coverage", county, "dataset-coverage.json"),
    envFile: values.get("env-file") ?? ".env.local",
    dryRun: values.get("dry-run") === "true",
  };
}

async function runDryRun(options: CoveragePublishCliOptions, env: CoveragePublishEnv): Promise<void> {
  const bucket = requireCredential(env, "S3_BUCKET");
  const ipnsLabel = resolveCoverageIpnsLabel(env, options.county);
  const key = buildCoverageKey(options.county);

  const body = await readFile(options.coveragePath);
  const cid = await computeIpfsCid(body);

  console.log(
    JSON.stringify({
      event: "coverage_publish_dry_run",
      county: options.county,
      coveragePath: options.coveragePath,
      bytes: body.byteLength,
      bucket,
      key,
      ipnsLabel,
      localCid: cid ?? null,
    }),
  );
  console.log(`\n=== DATASET COVERAGE (dry-run — no S3 PUT, no IPNS write) ===`);
  console.log(`County:      ${options.county}`);
  console.log(`Coverage:    ${options.coveragePath} (${body.byteLength} bytes)`);
  console.log(`Would PUT:   s3://${bucket}/${key}`);
  console.log(`Local CID:   ${cid ?? "(unavailable — ipfs-only-hash not resolvable)"}`);
  console.log(`IPNS label:  ${ipnsLabel} (would create/upsert; network_key resolved on real publish)`);
  console.log(`No uploads performed.\n`);
}

async function runPublish(options: CoveragePublishCliOptions, env: CoveragePublishEnv): Promise<void> {
  const { S3Client: S3ClientCtor } = await import("@aws-sdk/client-s3");

  const body = await readFile(options.coveragePath);

  const client = new S3ClientCtor({
    endpoint: requireCredential(env, "S3_ENDPOINT"),
    region: "us-east-1",
    credentials: {
      accessKeyId: requireCredential(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: requireCredential(env, "S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });

  const fetchImpl: CoverageFetch = async (url, init) => fetch(url, init);

  const result = await uploadCoverage({ client, fetchImpl, env, county: options.county, body });

  const envMapValue = JSON.stringify({ [options.county]: result.gatewayUrls.filebase });

  console.log(
    JSON.stringify({
      event: "coverage_publish_complete",
      county: options.county,
      key: result.key,
      cid: result.cid,
      ipnsLabel: result.ipnsLabel,
      ipnsName: result.ipnsName,
    }),
  );
  console.log(`\n=== DATASET COVERAGE ===`);
  console.log(`County:       ${options.county}`);
  console.log(`Object CID:   ${result.cid}`);
  console.log(`IPNS label:   ${result.ipnsLabel}`);
  console.log(`IPNS name:    ${result.ipnsName}`);
  console.log(`Gateway URLs the MCP can read the coverage JSON from:`);
  console.log(`  ${result.gatewayUrls.filebase}   (use for DATASET_COVERAGE_MAP)`);
  console.log(`  ${result.gatewayUrls.dweb}`);
  console.log(`\nSet in the MCP environment:`);
  console.log(`DATASET_COVERAGE_MAP=${envMapValue}\n`);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);
  const env: CoveragePublishEnv = process.env;

  assertFilebaseCredentials(env);
  resolveCoverageIpnsLabel(env, options.county);

  if (options.dryRun) {
    await runDryRun(options, env);
    return;
  }

  await runPublish(options, env);
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "coverage_publish_failed", error: message }));
    process.exit(1);
  });
}
