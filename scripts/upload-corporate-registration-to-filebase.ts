import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PutObjectCommand,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import type {
  DeserializeHandler,
  DeserializeHandlerArguments,
  DeserializeHandlerOutput,
  DeserializeMiddleware,
  HandlerExecutionContext,
} from "@smithy/types";
import { createRequire } from "node:module";

import {
  PUBLIC_CORPORATE_SCHEMA_VERSION,
  type PublicCorporateManifest,
} from "./run-public-corporate-registration-export.js";

export type CorporatePublishEnv = Record<string, string | undefined>;

export type CorporatePublishArtifact = {
  readonly key: string;
  readonly contentType:
    | "application/json"
    | "application/vnd.apache.parquet";
  readonly path: string;
  readonly body: Buffer;
  readonly sha256: string;
  readonly cid: string;
};

export type CorporatePublishResult = {
  readonly bucket: string;
  readonly manifestCid: string;
  readonly parquetCid: string;
  readonly schemaCid: string;
  readonly ipnsLabel: string;
  readonly ipnsName: string;
  readonly gatewayUrl: string;
  readonly rowCount: number;
  readonly publishedVerification: {
    readonly manifestSha256Matches: true;
    readonly parquetSha256Matches: true;
    readonly schemaSha256Matches: true;
    readonly rowCountMatches: true;
    readonly schemaVersionMatches: true;
  };
};

type CorporateUploadClient = Pick<S3Client, "send">;

type FilebaseIpnsName = {
  readonly enabled: boolean;
  readonly label: string;
  readonly network_key: string;
  readonly cid: string;
  readonly sequence: number;
};

type FilebaseFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type CorporateFetch = (
  url: string | URL,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<FilebaseFetchResponse>;

const FILEBASE_IPNS_API = "https://api.filebase.io/v1/names";
const CORPORATE_PARQUET_KEY =
  "corporate-registrations/rock-island/corporate-registrations.parquet";
const CORPORATE_SCHEMA_KEY =
  "corporate-registrations/rock-island/corporate-registration-schema.json";
const CORPORATE_MANIFEST_KEY =
  "corporate-registrations/rock-island/manifest.json";
const REQUIRED_CREDENTIALS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "FILEBASE_API_TOKEN",
  "FILEBASE_CORPORATE_IPNS_LABEL",
] as const;
const RESERVED_ROCK_ISLAND_LABELS = new Set([
  "oracle-open-data-rock-island",
  "oracle-geo-index-rock-island",
  "oracle-query-table-rock-island",
  "oracle-dataset-coverage-rock-island",
  "oracle-permit-table-rock-island",
]);

const require = createRequire(import.meta.url);
const ipfsHash = require("ipfs-only-hash") as {
  of: (content: Buffer) => Promise<string>;
};

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireCredential(
  env: CorporatePublishEnv,
  name: (typeof REQUIRED_CREDENTIALS)[number],
): string {
  const value = trimToUndefined(env[name]);
  if (value === undefined) {
    throw new Error(`Required corporate publication setting ${name} is missing`);
  }
  return value;
}

/**
 * Fail before network I/O unless credentials, endpoint, bucket, and IPNS label
 * are explicit and isolated from every Rock Island property publication.
 *
 * @param env - Injected credential and destination source.
 */
export function assertCorporatePublishEnvironment(
  env: CorporatePublishEnv,
): void {
  for (const name of REQUIRED_CREDENTIALS) {
    requireCredential(env, name);
  }
  if (requireCredential(env, "S3_ENDPOINT") !== "https://s3.filebase.com") {
    throw new Error("Corporate publication requires the Filebase S3 endpoint");
  }
  const bucket = requireCredential(env, "S3_BUCKET");
  if (!/^elephant-oracle-corporate-registration-rock-island(?:-[a-z0-9-]+)?$/u.test(bucket)) {
    throw new Error("Corporate publication requires its dedicated bucket");
  }
  const label = requireCredential(env, "FILEBASE_CORPORATE_IPNS_LABEL");
  if (
    label !== "oracle-corporate-registration-rock-island" ||
    RESERVED_ROCK_ISLAND_LABELS.has(label)
  ) {
    throw new Error("Corporate IPNS label is missing or reserved by another dataset");
  }
}

/**
 * Return the exact isolated object keys used by this corporate dataset.
 *
 * @returns Three non-property keys: Parquet, schema, and manifest.
 */
export function corporatePublicationKeys(): readonly string[] {
  return [
    CORPORATE_PARQUET_KEY,
    CORPORATE_SCHEMA_KEY,
    CORPORATE_MANIFEST_KEY,
  ];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseManifest(body: Buffer): PublicCorporateManifest {
  const parsed = JSON.parse(body.toString("utf8")) as PublicCorporateManifest;
  if (
    parsed.schemaVersion !== PUBLIC_CORPORATE_SCHEMA_VERSION ||
    parsed.dataset !== "rock_island_corporate_registrations" ||
    parsed.rowCount !== 11_741 ||
    parsed.uniqueIllinoisFileNumberCount !== 11_741 ||
    parsed.scope.countyCode !== "081" ||
    parsed.scope.type !== "registered_agent_office_county" ||
    parsed.snapshotConsistency !== "mixed_date" ||
    parsed.statewideIntersection.coveragePercent !== 99.9933 ||
    parsed.statewideIntersection.excludedCount !== 133 ||
    parsed.statewideIntersection.excludedCounty081Count !== 0 ||
    parsed.privacy.semanticScanPassed !== true
  ) {
    throw new Error("Corporate manifest does not satisfy the approved public contract");
  }
  return parsed;
}

async function buildArtifact(
  key: string,
  path: string,
  contentType: CorporatePublishArtifact["contentType"],
): Promise<CorporatePublishArtifact> {
  const body = await readFile(path);
  return {
    key,
    path,
    contentType,
    body,
    sha256: sha256(body),
    cid: await ipfsHash.of(body),
  };
}

/**
 * Read and cross-hash the complete local corporate publication artifact set.
 *
 * @param root - Directory containing the generated files.
 * @returns Manifest plus three upload artifacts in safe dependency order.
 */
export async function buildCorporatePublicationPlan(root: string): Promise<{
  readonly manifest: PublicCorporateManifest;
  readonly artifacts: readonly CorporatePublishArtifact[];
}> {
  const parquet = await buildArtifact(
    CORPORATE_PARQUET_KEY,
    join(root, "corporate-registrations.parquet"),
    "application/vnd.apache.parquet",
  );
  const schema = await buildArtifact(
    CORPORATE_SCHEMA_KEY,
    join(root, "corporate-registration-schema.json"),
    "application/json",
  );
  const manifest = await buildArtifact(
    CORPORATE_MANIFEST_KEY,
    join(root, "manifest.json"),
    "application/json",
  );
  const parsedManifest = parseManifest(manifest.body);
  const expectedParquet = parsedManifest.artifacts.find(
    (artifact) => artifact.key === CORPORATE_PARQUET_KEY,
  );
  const expectedSchema = parsedManifest.artifacts.find(
    (artifact) => artifact.key === CORPORATE_SCHEMA_KEY,
  );
  if (
    expectedParquet?.sha256 !== parquet.sha256 ||
    expectedParquet.cid !== parquet.cid ||
    expectedParquet.bytes !== parquet.body.byteLength ||
    expectedSchema?.sha256 !== schema.sha256 ||
    expectedSchema.cid !== schema.cid ||
    expectedSchema.bytes !== schema.body.byteLength
  ) {
    throw new Error("Corporate manifest artifact digest mismatch");
  }
  return {
    manifest: parsedManifest,
    artifacts: [parquet, schema, manifest],
  };
}

interface RawHttpResponse {
  readonly headers: Record<string, string>;
  readonly statusCode: number;
}

function isRawHttpResponse(value: unknown): value is RawHttpResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "headers" in value &&
    typeof (value as RawHttpResponse).headers === "object"
  );
}

async function putArtifact(
  client: CorporateUploadClient,
  bucket: string,
  artifact: CorporatePublishArtifact,
): Promise<void> {
  let capturedHeaders: Record<string, string> | undefined;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: artifact.key,
    Body: artifact.body,
    ContentType: artifact.contentType,
  });
  const captureMiddleware: DeserializeMiddleware<
    PutObjectCommandInput,
    PutObjectCommandOutput
  > =
    (
      next: DeserializeHandler<PutObjectCommandInput, PutObjectCommandOutput>,
      _context: HandlerExecutionContext,
    ) =>
    async (
      args: DeserializeHandlerArguments<PutObjectCommandInput>,
    ): Promise<DeserializeHandlerOutput<PutObjectCommandOutput>> => {
      const result = await next(args);
      if (isRawHttpResponse(result.response)) {
        capturedHeaders = result.response.headers;
      }
      return result;
    };
  command.middlewareStack.add(captureMiddleware, {
    step: "deserialize",
    name: `captureCorporateCid-${artifact.key.replace(/[^a-z0-9]/giu, "-")}`,
    priority: "low",
  });
  await client.send(command);
  const headerCid = capturedHeaders?.["x-amz-meta-cid"];
  if (headerCid !== undefined && headerCid !== artifact.cid) {
    throw new Error(`Filebase CID mismatch for ${artifact.key}`);
  }
}

function ipnsHeaders(apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

function isIpnsNameArray(value: unknown): value is FilebaseIpnsName[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "label" in entry &&
        typeof entry.label === "string" &&
        "network_key" in entry &&
        typeof entry.network_key === "string" &&
        "cid" in entry &&
        typeof entry.cid === "string",
    )
  );
}

async function listIpnsNames(
  fetchImpl: CorporateFetch,
  apiToken: string,
): Promise<FilebaseIpnsName[]> {
  const response = await fetchImpl(FILEBASE_IPNS_API, {
    method: "GET",
    headers: ipnsHeaders(apiToken),
  });
  if (!response.ok) {
    throw new Error(
      `Filebase IPNS list failed: ${response.status} ${response.statusText}`,
    );
  }
  const parsed = await response.json();
  if (!isIpnsNameArray(parsed)) {
    throw new Error("Filebase IPNS list returned an invalid response");
  }
  return parsed;
}

async function upsertCorporateIpns(
  fetchImpl: CorporateFetch,
  apiToken: string,
  label: string,
  manifestCid: string,
): Promise<string> {
  const existing = (await listIpnsNames(fetchImpl, apiToken)).find(
    (name) => name.label === label,
  );
  const url =
    existing === undefined
      ? FILEBASE_IPNS_API
      : `${FILEBASE_IPNS_API}/${encodeURIComponent(label)}`;
  const method = existing === undefined ? "POST" : "PUT";
  const response = await fetchImpl(url, {
    method,
    headers: ipnsHeaders(apiToken),
    body: JSON.stringify({
      ...(existing === undefined ? { label } : {}),
      cid: manifestCid,
      enabled: true,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Filebase corporate IPNS ${method} failed: ${response.status} ${response.statusText}`,
    );
  }
  const verified = (await listIpnsNames(fetchImpl, apiToken)).find(
    (name) => name.label === label,
  );
  if (
    verified === undefined ||
    verified.cid !== manifestCid ||
    verified.network_key.trim().length === 0
  ) {
    throw new Error("Corporate IPNS API readback does not match manifest CID");
  }
  return verified.network_key;
}

async function fetchWithRetry(
  fetchImpl: CorporateFetch,
  url: string,
  expectedSha256: string,
): Promise<Buffer> {
  let lastStatus = "not_requested";
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const response = await fetchImpl(url, { method: "GET" });
    lastStatus = `${response.status} ${response.statusText}`;
    if (response.ok) {
      const body = Buffer.from(await response.arrayBuffer());
      if (sha256(body) === expectedSha256) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Published corporate artifact failed verification: ${lastStatus}`);
}

/**
 * Upload only the validated corporate artifact set, point the dedicated IPNS
 * label at its manifest, then compare gateway bytes with every local hash.
 *
 * @param options - Injected clients, environment, and local artifact root.
 * @returns Public identifiers and post-publication verification results.
 */
export async function uploadCorporateRegistration(options: {
  readonly client: CorporateUploadClient;
  readonly fetchImpl: CorporateFetch;
  readonly env: CorporatePublishEnv;
  readonly root: string;
}): Promise<CorporatePublishResult> {
  assertCorporatePublishEnvironment(options.env);
  const bucket = requireCredential(options.env, "S3_BUCKET");
  const apiToken = requireCredential(options.env, "FILEBASE_API_TOKEN");
  const ipnsLabel = requireCredential(
    options.env,
    "FILEBASE_CORPORATE_IPNS_LABEL",
  );
  const plan = await buildCorporatePublicationPlan(options.root);
  for (const artifact of plan.artifacts) {
    await putArtifact(options.client, bucket, artifact);
  }
  const manifestArtifact = plan.artifacts.find(
    (artifact) => artifact.key === CORPORATE_MANIFEST_KEY,
  );
  const parquetArtifact = plan.artifacts.find(
    (artifact) => artifact.key === CORPORATE_PARQUET_KEY,
  );
  const schemaArtifact = plan.artifacts.find(
    (artifact) => artifact.key === CORPORATE_SCHEMA_KEY,
  );
  if (
    manifestArtifact === undefined ||
    parquetArtifact === undefined ||
    schemaArtifact === undefined
  ) {
    throw new Error("Corporate publication plan is incomplete");
  }
  const ipnsName = await upsertCorporateIpns(
    options.fetchImpl,
    apiToken,
    ipnsLabel,
    manifestArtifact.cid,
  );
  const gatewayUrl = `https://ipfs.filebase.io/ipns/${ipnsName}`;
  const publishedManifest = await fetchWithRetry(
    options.fetchImpl,
    gatewayUrl,
    manifestArtifact.sha256,
  );
  const publishedParquet = await fetchWithRetry(
    options.fetchImpl,
    `https://ipfs.filebase.io/ipfs/${parquetArtifact.cid}`,
    parquetArtifact.sha256,
  );
  const publishedSchema = await fetchWithRetry(
    options.fetchImpl,
    `https://ipfs.filebase.io/ipfs/${schemaArtifact.cid}`,
    schemaArtifact.sha256,
  );
  const remoteManifest = parseManifest(publishedManifest);
  if (
    publishedParquet.byteLength !== parquetArtifact.body.byteLength ||
    publishedSchema.byteLength !== schemaArtifact.body.byteLength ||
    remoteManifest.rowCount !== plan.manifest.rowCount ||
    remoteManifest.schemaVersion !== plan.manifest.schemaVersion
  ) {
    throw new Error("Published corporate count, size, or schema mismatch");
  }
  return {
    bucket,
    manifestCid: manifestArtifact.cid,
    parquetCid: parquetArtifact.cid,
    schemaCid: schemaArtifact.cid,
    ipnsLabel,
    ipnsName,
    gatewayUrl,
    rowCount: plan.manifest.rowCount,
    publishedVerification: {
      manifestSha256Matches: true,
      parquetSha256Matches: true,
      schemaSha256Matches: true,
      rowCountMatches: true,
      schemaVersionMatches: true,
    },
  };
}

function loadEnvFile(envFile: string): void {
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/u)) {
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
  } catch (caught: unknown) {
    if (
      caught instanceof Error &&
      "code" in caught &&
      (caught as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw caught;
  }
}

type CorporatePublishCliOptions = {
  readonly root: string;
  readonly envFile: string;
};

function parseCliOptions(argv: readonly string[]): CorporatePublishCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const root = values.get("root");
  if (root === undefined) throw new Error("--root is required");
  return {
    root,
    envFile: values.get("env-file") ?? ".env.local",
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);
  assertCorporatePublishEnvironment(process.env);
  const { S3Client: S3ClientCtor } = await import("@aws-sdk/client-s3");
  const client = new S3ClientCtor({
    endpoint: requireCredential(process.env, "S3_ENDPOINT"),
    region: "us-east-1",
    credentials: {
      accessKeyId: requireCredential(process.env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: requireCredential(process.env, "S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
  const fetchImpl: CorporateFetch = async (url, init) =>
    fetch(url, init) as Promise<FilebaseFetchResponse>;
  const result = await uploadCorporateRegistration({
    client,
    fetchImpl,
    env: process.env,
    root: options.root,
  });
  console.log(
    JSON.stringify({
      event: "corporate_registration_publish_complete",
      ...result,
    }),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({
        event: "corporate_registration_publish_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
