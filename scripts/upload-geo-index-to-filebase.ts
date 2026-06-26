import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

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
 * Story 3 — geo-index PUBLISH mechanics.
 *
 * Publishes ONLY the single derived geo-index.json under its OWN IPNS pointer.
 * It deliberately shares none of the property publisher's surface: it never
 * uploads `properties/*`, `shards/*`, `index.json`, or `manifest.json`, and it
 * refuses to write the property dataset's IPNS label
 * (`oracle-open-data-lee`) — doing so would clobber the property dataset.
 *
 * All external collaborators (the S3 client, the Filebase IPNS REST `fetch`,
 * and the credential/label source `env`) are injected so the publish mechanics
 * are unit-testable without any network I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The credential + label source. Injected so nothing reads `process.env`. */
export type GeoIndexPublishEnv = Record<string, string | undefined>;

export type GeoIndexUploadObject = {
  readonly key: string;
  readonly contentType: string;
};

export type GeoIndexUploadPlan = {
  readonly objects: GeoIndexUploadObject[];
};

export type GeoIndexPublishResult = {
  readonly key: string;
  readonly cid: string;
  readonly ipnsLabel: string;
  readonly ipnsName: string;
};

/** Minimal S3 surface we use — satisfied by the AWS SDK v3 `S3Client`. */
type GeoIndexUploadClient = Pick<S3Client, "send" | "middlewareStack">;

/** Minimal Filebase IPNS REST response surface. */
type FilebaseFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json: () => Promise<unknown>;
};

/** Injected `fetch` for the Filebase IPNS REST API. */
type GeoIndexFetch = (
  url: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FilebaseFetchResponse>;

/**
 * A Filebase IPNS name as returned by `GET/POST/PUT /v1/names`. The endpoint
 * returns a BARE JSON ARRAY of these (no `items` wrapper). The resolvable IPNS
 * name (`k51q…`) is the `network_key` field — there is no `_id` or `record`.
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

/**
 * The property dataset's IPNS label. The geo index MUST NOT be published under
 * it — re-pointing this label at the geo CID would replace the 511k-property
 * pointer and break the property dataset.
 */
const PROPERTY_IPNS_LABEL = "oracle-open-data-lee";

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

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The single object key for the derived geo index. Never a `properties/*`,
 * `shards/*`, `index.json`, or `manifest.json` key.
 */
export function buildGeoIndexKey(county: string): string {
  const normalized = county.trim().toLowerCase();
  return `geo-indexes/${normalized}/geo-index.json`;
}

/**
 * The complete upload plan for the geo index: EXACTLY ONE object. The property
 * publisher uploads 511k property files + shards + index + manifest; this
 * publisher touches none of those.
 */
export function planGeoIndexUpload(opts: { county: string }): GeoIndexUploadPlan {
  return {
    objects: [{ key: buildGeoIndexKey(opts.county), contentType: "application/json" }],
  };
}

/**
 * Resolve the geo IPNS label from `FILEBASE_GEO_IPNS_LABEL` (preferred) or
 * `FILEBASE_IPNS_LABEL` (fallback). Throws when no label is set, and — crucially
 * — when the resolved label is the property dataset's label.
 */
export function resolveGeoIpnsLabel(env: GeoIndexPublishEnv): string {
  const label = trimToUndefined(env["FILEBASE_GEO_IPNS_LABEL"]) ?? trimToUndefined(env["FILEBASE_IPNS_LABEL"]);

  if (label === undefined) {
    throw new Error(
      "Geo IPNS label is not set. Set FILEBASE_GEO_IPNS_LABEL (preferred) or FILEBASE_IPNS_LABEL to a label distinct from the property dataset.",
    );
  }

  if (label === PROPERTY_IPNS_LABEL) {
    throw new Error(
      `Refusing to publish the geo index under the property dataset label "${PROPERTY_IPNS_LABEL}". ` +
        "Set FILEBASE_GEO_IPNS_LABEL to a separate label (e.g. oracle-geo-index-lee) so the geo pointer cannot clobber the property dataset.",
    );
  }

  return label;
}

/** Resolve a required credential, throwing an explicit, named error when absent. */
function requireCredential(env: GeoIndexPublishEnv, name: string): string {
  const value = trimToUndefined(env[name]);
  if (value === undefined) {
    throw new Error(
      `Required Filebase/S3 credential ${name} is not set. Export it from the vault credentials before publishing the geo index.`,
    );
  }
  return value;
}

/**
 * Throw an explicit, variable-named error when any required Filebase/S3
 * credential is missing. Called FIRST in {@link uploadGeoIndex} so a missing
 * credential fails before any S3 send or IPNS call.
 */
export function assertFilebaseCredentials(env: GeoIndexPublishEnv): void {
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
 * Compute the IPFS CIDv0 of a buffer locally (no network). Authoritative when
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
 * PUT the single geo-index object and capture the `x-amz-meta-cid` header that
 * Filebase returns. Mirrors the property publisher's capture middleware.
 */
async function putGeoIndexObject(
  client: GeoIndexUploadClient,
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
    name: "captureGeoIndexCidHeader",
    priority: "low",
  });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: "application/json",
      }),
    );
  } finally {
    client.middlewareStack.remove("captureGeoIndexCidHeader");
  }

  return capturedHeaders?.["x-amz-meta-cid"];
}

// ---------------------------------------------------------------------------
// Filebase IPNS REST helpers (injected fetch — no implicit global)
// ---------------------------------------------------------------------------

function ipnsHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
}

async function listIpnsNames(fetchImpl: GeoIndexFetch, apiToken: string): Promise<FilebaseIpnsName[]> {
  const response = await fetchImpl(FILEBASE_IPNS_API, { method: "GET", headers: ipnsHeaders(apiToken) });
  if (!response.ok) {
    throw new Error(`Filebase IPNS list failed: ${response.status} ${response.statusText}`);
  }
  // `GET /v1/names` returns a bare JSON array — there is no `items` wrapper.
  return (await response.json()) as FilebaseIpnsName[];
}

/** Create the IPNS name AND point it at `cid` in one `POST /v1/names`. */
async function createIpnsName(
  fetchImpl: GeoIndexFetch,
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
  fetchImpl: GeoIndexFetch,
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
 * Create the geo IPNS label if it does not exist, then re-point it at the geo
 * index CID. Returns the resolvable IPNS name — the `network_key` (`k51q…`).
 * Names are addressed BY LABEL; `network_key` is stable per label, so for an
 * existing name we reuse the value from the list rather than re-fetching it.
 */
async function upsertGeoIpnsPointer(
  fetchImpl: GeoIndexFetch,
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
 * Publish the single geo index object and re-point its OWN IPNS label at the
 * derived CID. Validation order is load-bearing:
 *   1. credentials (throws before any upload/IPNS call when missing),
 *   2. label resolution + property-label guard (throws before any write),
 *   3. upload the single object and derive its CID,
 *   4. re-point the geo IPNS label.
 */
export async function uploadGeoIndex(opts: {
  client: GeoIndexUploadClient;
  fetchImpl: GeoIndexFetch;
  env: GeoIndexPublishEnv;
  county: string;
  body: Buffer;
}): Promise<GeoIndexPublishResult> {
  assertFilebaseCredentials(opts.env);
  const ipnsLabel = resolveGeoIpnsLabel(opts.env);

  const bucket = requireCredential(opts.env, "S3_BUCKET");
  const apiToken = requireCredential(opts.env, "FILEBASE_API_TOKEN");
  const key = buildGeoIndexKey(opts.county);

  const headerCid = await putGeoIndexObject(opts.client, { bucket, key, body: opts.body });
  const localCid = await computeIpfsCid(opts.body);
  const cid = localCid ?? trimToUndefined(headerCid);

  if (cid === undefined) {
    throw new Error(
      `Failed to derive a geo index CID for ${key}. Filebase returned no x-amz-meta-cid header and local CID computation failed.`,
    );
  }

  const ipnsName = await upsertGeoIpnsPointer(opts.fetchImpl, apiToken, ipnsLabel, cid);

  return { key, cid, ipnsLabel, ipnsName };
}

// ---------------------------------------------------------------------------
// CLI entry point (only when invoked directly — importing stays side-effect free)
// ---------------------------------------------------------------------------

type GeoIndexPublishCliOptions = {
  readonly county: string;
  readonly exportDir: string;
};

function parseCliOptions(argv: readonly string[]): GeoIndexPublishCliOptions {
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
  return {
    county: values.get("county") ?? "lee",
    exportDir: values.get("export-dir") ?? ".geo-index-export",
  };
}

async function main(): Promise<void> {
  const { S3Client: S3ClientCtor } = await import("@aws-sdk/client-s3");
  const options = parseCliOptions(process.argv.slice(2));
  const env: GeoIndexPublishEnv = process.env;

  // Fail fast on bad credentials / unsafe label before reading the file or
  // building any client — uploadGeoIndex re-validates as the authoritative gate.
  assertFilebaseCredentials(env);
  resolveGeoIpnsLabel(env);

  const body = await readFile(join(options.exportDir, "geo-index.json"));

  const client = new S3ClientCtor({
    endpoint: requireCredential(env, "S3_ENDPOINT"),
    region: "us-east-1",
    credentials: {
      accessKeyId: requireCredential(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: requireCredential(env, "S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });

  const fetchImpl: GeoIndexFetch = async (url, init) => fetch(url, init);

  const result = await uploadGeoIndex({ client, fetchImpl, env, county: options.county, body });

  console.log(
    JSON.stringify({
      event: "geo_index_publish_complete",
      key: result.key,
      cid: result.cid,
      ipnsLabel: result.ipnsLabel,
      ipnsName: result.ipnsName,
    }),
  );
  console.log(`\n=== GEO INDEX ===`);
  console.log(`CID: ${result.cid}`);
  console.log(`IPNS label: ${result.ipnsLabel}`);
  console.log(`IPNS name: ${result.ipnsName}`);
  console.log(`Set ORACLE_GEO_INDEX_IPNS=${result.ipnsName} in your MCP environment.\n`);
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
    console.error(JSON.stringify({ event: "geo_index_publish_failed", error: message }));
    process.exit(1);
  });
}
