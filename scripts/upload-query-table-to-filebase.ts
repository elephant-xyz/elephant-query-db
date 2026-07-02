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
 * Query-table PUBLISH mechanics.
 *
 * Publishes ONLY the single per-county query-table Parquet under its OWN IPNS
 * pointer, so the MCP's embedded DuckDB can range-read the parquet straight from
 * an IPFS gateway. It deliberately shares none of the property publisher's
 * surface: it never uploads `properties/*`, `shards/*`, `index.json`, or
 * `manifest.json`, and it HARD-REFUSES to write either the property dataset's
 * IPNS label (`oracle-open-data-<county>`) or the geo-index label
 * (`oracle-geo-index-<county>`) — re-pointing either would clobber that dataset.
 *
 * All external collaborators (the S3 client, the Filebase IPNS REST `fetch`, and
 * the credential/label source `env`) are injected so the publish mechanics are
 * unit-testable without any network I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The credential + label source. Injected so nothing reads `process.env`. */
export type QueryTablePublishEnv = Record<string, string | undefined>;

export type QueryTableUploadObject = {
  readonly key: string;
  readonly contentType: string;
};

export type QueryTableUploadPlan = {
  readonly objects: QueryTableUploadObject[];
};

export type QueryTableGatewayUrls = {
  /** Filebase's own gateway — the reliable form for DuckDB httpfs range reads. */
  readonly filebase: string;
  /** Public dweb.link subdomain gateway (secondary; range support can be flaky). */
  readonly dweb: string;
};

export type QueryTablePublishResult = {
  readonly key: string;
  readonly cid: string;
  readonly ipnsLabel: string;
  readonly ipnsName: string;
  readonly gatewayUrls: QueryTableGatewayUrls;
};

/** Minimal S3 surface we use — satisfied by the AWS SDK v3 `S3Client`. */
type QueryTableUploadClient = Pick<S3Client, "send" | "middlewareStack">;

/** Minimal Filebase IPNS REST response surface. */
type FilebaseFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json: () => Promise<unknown>;
};

/** Injected `fetch` for the Filebase IPNS REST API. */
type QueryTableFetch = (
  url: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FilebaseFetchResponse>;

/**
 * A Filebase IPNS name as returned by `GET/POST/PUT /v1/names`. The endpoint
 * returns a BARE JSON ARRAY of these (no `items` wrapper). The resolvable IPNS
 * name (`k51q…`) is the `network_key` field.
 */
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

/** Content type for the parquet object. */
const PARQUET_CONTENT_TYPE = "application/vnd.apache.parquet";

/** Required Filebase/S3 credentials, named explicitly for actionable errors. */
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

/** The property dataset's IPNS label for a county — must never be re-pointed here. */
export function propertyIpnsLabel(county: string): string {
  return `oracle-open-data-${normalizeCounty(county)}`;
}

/** The geo-index IPNS label for a county — must never be re-pointed here. */
export function geoIndexIpnsLabel(county: string): string {
  return `oracle-geo-index-${normalizeCounty(county)}`;
}

/** The county-generic default IPNS label for the query table. */
export function defaultQueryTableIpnsLabel(county: string): string {
  return `oracle-query-table-${normalizeCounty(county)}`;
}

/**
 * The single object key for the query-table parquet. Never a `properties/*`,
 * `shards/*`, `index.json`, or `manifest.json` key.
 */
export function buildQueryTableKey(county: string): string {
  return `query-tables/${normalizeCounty(county)}/query-table.parquet`;
}

/**
 * The complete upload plan for the query table: EXACTLY ONE object. The property
 * publisher uploads 511k property files + shards + index + manifest; this
 * publisher touches none of those.
 */
export function planQueryTableUpload(opts: { county: string }): QueryTableUploadPlan {
  return {
    objects: [{ key: buildQueryTableKey(opts.county), contentType: PARQUET_CONTENT_TYPE }],
  };
}

/**
 * The two gateway URL forms the MCP can read the parquet through. The Filebase
 * gateway is the reliable form for DuckDB `httpfs` range reads; dweb.link is a
 * secondary public gateway whose Range support can be flaky.
 */
export function buildQueryTableGatewayUrls(networkKey: string): QueryTableGatewayUrls {
  const key = networkKey.trim();
  return {
    filebase: `https://ipfs.filebase.io/ipns/${key}`,
    dweb: `https://${key}.ipns.dweb.link/`,
  };
}

/**
 * Resolve the query-table IPNS label from `FILEBASE_QUERY_TABLE_IPNS_LABEL`, or
 * fall back to the county-generic default `oracle-query-table-<county>`. Throws
 * — crucially — when the resolved label is the property dataset's label or the
 * geo-index label, so the query-table pointer can never clobber another dataset.
 */
export function resolveQueryTableIpnsLabel(env: QueryTablePublishEnv, county: string): string {
  const label =
    trimToUndefined(env["FILEBASE_QUERY_TABLE_IPNS_LABEL"]) ?? defaultQueryTableIpnsLabel(county);

  const property = propertyIpnsLabel(county);
  if (label === property) {
    throw new Error(
      `Refusing to publish the query table under the property dataset label "${property}". ` +
        `Set FILEBASE_QUERY_TABLE_IPNS_LABEL to a separate label (e.g. ${defaultQueryTableIpnsLabel(county)}) ` +
        "so the query-table pointer cannot clobber the property dataset.",
    );
  }

  const geo = geoIndexIpnsLabel(county);
  if (label === geo) {
    throw new Error(
      `Refusing to publish the query table under the geo-index label "${geo}". ` +
        `Set FILEBASE_QUERY_TABLE_IPNS_LABEL to a separate label (e.g. ${defaultQueryTableIpnsLabel(county)}) ` +
        "so the query-table pointer cannot clobber the geo index.",
    );
  }

  return label;
}

/** Resolve a required credential, throwing an explicit, named error when absent. */
function requireCredential(env: QueryTablePublishEnv, name: string): string {
  const value = trimToUndefined(env[name]);
  if (value === undefined) {
    throw new Error(
      `Required Filebase/S3 credential ${name} is not set. Export it from the vault credentials before publishing the query table.`,
    );
  }
  return value;
}

/**
 * Throw an explicit, variable-named error when any required Filebase/S3
 * credential is missing. Called FIRST in {@link uploadQueryTable} so a missing
 * credential fails before any S3 send or IPNS call.
 */
export function assertFilebaseCredentials(env: QueryTablePublishEnv): void {
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

/**
 * Compute the IPFS CID of a buffer locally (no network). Authoritative when
 * available; the captured Filebase header acts as a fallback/cross-check.
 */
async function computeIpfsCid(content: Buffer): Promise<string | undefined> {
  try {
    // ipfs-only-hash is CommonJS; createRequire keeps it NodeNext-compatible.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const ipfsHash = require("ipfs-only-hash") as { of: (content: Buffer) => Promise<string> };
    const cid = await ipfsHash.of(content);
    return trimToUndefined(cid);
  } catch {
    return undefined;
  }
}

/**
 * PUT the single parquet object and capture the `x-amz-meta-cid` header that
 * Filebase returns. Mirrors the property publisher's capture middleware.
 */
async function putQueryTableObject(
  client: QueryTableUploadClient,
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
    name: "captureQueryTableCidHeader",
    priority: "low",
  });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: PARQUET_CONTENT_TYPE,
      }),
    );
  } finally {
    client.middlewareStack.remove("captureQueryTableCidHeader");
  }

  return capturedHeaders?.["x-amz-meta-cid"];
}

// ---------------------------------------------------------------------------
// Filebase IPNS REST helpers (injected fetch — no implicit global)
// ---------------------------------------------------------------------------

function ipnsHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
}

async function listIpnsNames(fetchImpl: QueryTableFetch, apiToken: string): Promise<FilebaseIpnsName[]> {
  const response = await fetchImpl(FILEBASE_IPNS_API, { method: "GET", headers: ipnsHeaders(apiToken) });
  if (!response.ok) {
    throw new Error(`Filebase IPNS list failed: ${response.status} ${response.statusText}`);
  }
  // `GET /v1/names` returns a bare JSON array — there is no `items` wrapper.
  return (await response.json()) as FilebaseIpnsName[];
}

/** Create the IPNS name AND point it at `cid` in one `POST /v1/names`. */
async function createIpnsName(
  fetchImpl: QueryTableFetch,
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

/** Re-point an existing IPNS name at `cid` via `PUT /v1/names/{label}`. */
async function updateIpnsName(
  fetchImpl: QueryTableFetch,
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
 * Create the query-table IPNS label if it does not exist, then re-point it at
 * the parquet CID. Returns the resolvable IPNS name — the `network_key`
 * (`k51q…`). Names are addressed BY LABEL; `network_key` is stable per label, so
 * for an existing name we reuse the value from the list rather than re-fetching.
 */
async function upsertQueryTableIpnsPointer(
  fetchImpl: QueryTableFetch,
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
 * Publish the single query-table parquet object and re-point its OWN IPNS label
 * at the derived CID. Validation order is load-bearing:
 *   1. credentials (throws before any upload/IPNS call when missing),
 *   2. label resolution + property/geo-label guard (throws before any write),
 *   3. upload the single object and derive its CID,
 *   4. re-point the query-table IPNS label.
 */
export async function uploadQueryTable(opts: {
  client: QueryTableUploadClient;
  fetchImpl: QueryTableFetch;
  env: QueryTablePublishEnv;
  county: string;
  body: Buffer;
}): Promise<QueryTablePublishResult> {
  assertFilebaseCredentials(opts.env);
  const ipnsLabel = resolveQueryTableIpnsLabel(opts.env, opts.county);

  const bucket = requireCredential(opts.env, "S3_BUCKET");
  const apiToken = requireCredential(opts.env, "FILEBASE_API_TOKEN");
  const key = buildQueryTableKey(opts.county);

  const headerCid = await putQueryTableObject(opts.client, { bucket, key, body: opts.body });
  const localCid = await computeIpfsCid(opts.body);
  const cid = localCid ?? trimToUndefined(headerCid);

  if (cid === undefined) {
    throw new Error(
      `Failed to derive a query-table CID for ${key}. Filebase returned no x-amz-meta-cid header and local CID computation failed.`,
    );
  }

  const ipnsName = await upsertQueryTableIpnsPointer(opts.fetchImpl, apiToken, ipnsLabel, cid);

  return { key, cid, ipnsLabel, ipnsName, gatewayUrls: buildQueryTableGatewayUrls(ipnsName) };
}

// ---------------------------------------------------------------------------
// Env file loader (mirrors run-query-table-export.ts, incl. quote-stripping)
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
      // Strip a single pair of surrounding quotes; a quoted value otherwise
      // parses with the quotes still attached and breaks downstream consumers.
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
// CLI entry point (only when invoked directly — importing stays side-effect free)
// ---------------------------------------------------------------------------

type QueryTablePublishCliOptions = {
  readonly county: string;
  readonly parquetPath: string;
  readonly envFile: string;
  readonly dryRun: boolean;
};

function parseCliOptions(argv: readonly string[]): QueryTablePublishCliOptions {
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
  const parquet = values.get("parquet");
  return {
    county,
    parquetPath: parquet !== undefined && parquet !== "true"
      ? parquet
      : join(".query-table-export", county, "query-table.parquet"),
    envFile: values.get("env-file") ?? ".env.local",
    dryRun: values.get("dry-run") === "true",
  };
}

async function runDryRun(options: QueryTablePublishCliOptions, env: QueryTablePublishEnv): Promise<void> {
  const bucket = requireCredential(env, "S3_BUCKET");
  const ipnsLabel = resolveQueryTableIpnsLabel(env, options.county);
  const key = buildQueryTableKey(options.county);

  const body = await readFile(options.parquetPath);
  const cid = await computeIpfsCid(body);

  console.log(
    JSON.stringify({
      event: "query_table_publish_dry_run",
      county: options.county,
      parquetPath: options.parquetPath,
      bytes: body.byteLength,
      bucket,
      key,
      ipnsLabel,
      localCid: cid ?? null,
    }),
  );
  console.log(`\n=== QUERY TABLE (dry-run — no S3 PUT, no IPNS write) ===`);
  console.log(`County:      ${options.county}`);
  console.log(`Parquet:     ${options.parquetPath} (${body.byteLength} bytes)`);
  console.log(`Would PUT:   s3://${bucket}/${key}`);
  console.log(`Local CID:   ${cid ?? "(unavailable — ipfs-only-hash not resolvable)"}`);
  console.log(`IPNS label:  ${ipnsLabel} (would create/upsert; network_key resolved on real publish)`);
  console.log(`No uploads performed.\n`);
}

async function runPublish(options: QueryTablePublishCliOptions, env: QueryTablePublishEnv): Promise<void> {
  const { S3Client: S3ClientCtor } = await import("@aws-sdk/client-s3");

  const body = await readFile(options.parquetPath);

  const client = new S3ClientCtor({
    endpoint: requireCredential(env, "S3_ENDPOINT"),
    region: "us-east-1",
    credentials: {
      accessKeyId: requireCredential(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: requireCredential(env, "S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });

  const fetchImpl: QueryTableFetch = async (url, init) => fetch(url, init);

  const result = await uploadQueryTable({ client, fetchImpl, env, county: options.county, body });

  const envMapValue = JSON.stringify({ [options.county]: result.gatewayUrls.filebase });

  console.log(
    JSON.stringify({
      event: "query_table_publish_complete",
      county: options.county,
      key: result.key,
      cid: result.cid,
      ipnsLabel: result.ipnsLabel,
      ipnsName: result.ipnsName,
    }),
  );
  console.log(`\n=== QUERY TABLE ===`);
  console.log(`County:       ${options.county}`);
  console.log(`Object CID:   ${result.cid}`);
  console.log(`IPNS label:   ${result.ipnsLabel}`);
  console.log(`IPNS name:    ${result.ipnsName}`);
  console.log(`Gateway URLs the MCP can read the parquet from:`);
  console.log(`  ${result.gatewayUrls.filebase}   (reliable for DuckDB httpfs range reads)`);
  console.log(`  ${result.gatewayUrls.dweb}`);
  console.log(`\nSet in the MCP environment:`);
  console.log(`PROPERTY_QUERY_TABLE_MAP=${envMapValue}\n`);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);
  const env: QueryTablePublishEnv = process.env;

  // Fail fast on bad credentials / unsafe label before any upload — uploadQueryTable
  // re-validates as the authoritative gate.
  assertFilebaseCredentials(env);
  resolveQueryTableIpnsLabel(env, options.county);

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
    console.error(JSON.stringify({ event: "query_table_publish_failed", error: message }));
    process.exit(1);
  });
}
