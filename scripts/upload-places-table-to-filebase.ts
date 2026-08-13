import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
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
 * Overture places PUBLISH mechanics.
 *
 * Uploads the full artifact root (`NOTICE.txt`, `<county>/index.json`,
 * `<county>/places-table.parquet`) into a DEDICATED Filebase bucket, generates
 * a UnixFS directory CID for that bucket, and points a dedicated IPNS label
 * (`oracle-open-data-<county>-places`) at that directory CID.
 *
 * Hard-refuses property / query-table / permit / geo buckets and IPNS labels.
 */

export type PlacesPublishEnv = Record<string, string | undefined>;

export type PlacesUploadObject = {
  readonly key: string;
  readonly contentType: string;
  readonly relativePath: string;
};

export type PlacesUploadPlan = {
  readonly objects: readonly PlacesUploadObject[];
};

export type PlacesGatewayUrls = {
  readonly filebaseRoot: string;
  readonly filebaseParquet: string;
  readonly filebaseIndex: string;
  readonly filebaseNotice: string;
  readonly dwebRoot: string;
};

export type PlacesPublishResult = {
  readonly bucket: string;
  readonly cid: string;
  readonly ipnsLabel: string;
  readonly ipnsName: string;
  readonly keys: readonly string[];
  readonly gatewayUrls: PlacesGatewayUrls;
};

type PlacesUploadClient = Pick<S3Client, "send" | "middlewareStack">;

type FilebaseFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json: () => Promise<unknown>;
};

type PlacesFetch = (
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

const PARQUET_CONTENT_TYPE = "application/vnd.apache.parquet";
const JSON_CONTENT_TYPE = "application/json";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

const REQUIRED_CREDENTIALS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "FILEBASE_API_TOKEN",
] as const;

const FILEBASE_IPNS_API = "https://api.filebase.io/v1/names";

const FORBIDDEN_BUCKET_EXACT = new Set([
  "elephant-oracle-open-data",
  "elephant-oracle-open-data-orange",
  "elephant-oracle-open-data-miami-dade",
  "elephant-oracle-open-data-chester",
  "elephant-oracle-open-data-lee",
]);

function normalizeCounty(county: string): string {
  return county.trim().toLowerCase();
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function propertyIpnsLabel(county: string): string {
  return `oracle-open-data-${normalizeCounty(county)}`;
}

export function geoIndexIpnsLabel(county: string): string {
  return `oracle-geo-index-${normalizeCounty(county)}`;
}

export function queryTableIpnsLabel(county: string): string {
  return `oracle-query-table-${normalizeCounty(county)}`;
}

export function permitTableIpnsLabel(county: string): string {
  return `oracle-permit-table-${normalizeCounty(county)}`;
}

export function defaultPlacesIpnsLabel(county: string): string {
  return `oracle-open-data-${normalizeCounty(county)}-places`;
}

export function defaultPlacesBucket(county: string): string {
  return `elephant-oracle-open-data-${normalizeCounty(county)}-places`;
}

export function planPlacesUpload(opts: { county: string }): PlacesUploadPlan {
  const county = normalizeCounty(opts.county);
  return {
    objects: [
      { key: "NOTICE.txt", contentType: TEXT_CONTENT_TYPE, relativePath: "NOTICE.txt" },
      {
        key: `${county}/index.json`,
        contentType: JSON_CONTENT_TYPE,
        relativePath: join(county, "index.json"),
      },
      {
        key: `${county}/places-table.parquet`,
        contentType: PARQUET_CONTENT_TYPE,
        relativePath: join(county, "places-table.parquet"),
      },
    ],
  };
}

export function buildPlacesGatewayUrls(networkKey: string, county: string): PlacesGatewayUrls {
  const key = networkKey.trim();
  const slug = normalizeCounty(county);
  const filebaseRoot = `https://ipfs.filebase.io/ipns/${key}`;
  return {
    filebaseRoot: `${filebaseRoot}/`,
    filebaseParquet: `${filebaseRoot}/${slug}/places-table.parquet`,
    filebaseIndex: `${filebaseRoot}/${slug}/index.json`,
    filebaseNotice: `${filebaseRoot}/NOTICE.txt`,
    dwebRoot: `https://${key}.ipns.dweb.link/`,
  };
}

export function assertDedicatedPlacesBucket(bucket: string, county: string): void {
  const expected = defaultPlacesBucket(county);
  if (FORBIDDEN_BUCKET_EXACT.has(bucket)) {
    throw new Error(
      `Refusing to publish places into bucket "${bucket}". Places needs its own Filebase bucket (${expected}).`,
    );
  }
  if (bucket !== expected) {
    throw new Error(
      `Refusing places bucket "${bucket}". Expected dedicated bucket "${expected}".`,
    );
  }
}

export function resolvePlacesIpnsLabel(env: PlacesPublishEnv, county: string): string {
  const expected = defaultPlacesIpnsLabel(county);
  const label = trimToUndefined(env["FILEBASE_IPNS_LABEL"]) ?? expected;
  const forbidden = [
    propertyIpnsLabel(county),
    geoIndexIpnsLabel(county),
    queryTableIpnsLabel(county),
    permitTableIpnsLabel(county),
  ];
  if (forbidden.includes(label)) {
    throw new Error(
      `Refusing to publish places under label "${label}". Use ${expected} so other artifact families are not clobbered.`,
    );
  }
  if (label !== expected) {
    throw new Error(`Refusing places IPNS label "${label}". Expected exactly "${expected}".`);
  }
  return label;
}

function requireCredential(env: PlacesPublishEnv, name: string): string {
  const value = trimToUndefined(env[name]);
  if (value === undefined) {
    throw new Error(
      `Required Filebase/S3 credential ${name} is not set. Export it from the vault or Secrets Manager before publishing places.`,
    );
  }
  return value;
}

export function assertFilebaseCredentials(env: PlacesPublishEnv): void {
  for (const name of REQUIRED_CREDENTIALS) {
    requireCredential(env, name);
  }
}

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

async function putObjectCapturingCid(
  client: PlacesUploadClient,
  params: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  },
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
  const middlewareName = `capturePlacesObjectCidHeader:${params.key}`;
  client.middlewareStack.add(captureMiddleware, {
    step: "deserialize",
    name: middlewareName,
    priority: "low",
  });
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
  } finally {
    client.middlewareStack.remove(middlewareName);
  }
  return capturedHeaders?.["x-amz-meta-cid"];
}

async function generateBucketDirectoryCid(
  client: PlacesUploadClient,
  bucket: string,
): Promise<string> {
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
    name: "capturePlacesBucketCidHeader",
    priority: "low",
  });
  try {
    await client.send(
      new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: {
          TagSet: [{ Key: "generateBucketCid", Value: "true" }],
        },
      }),
    );
  } finally {
    client.middlewareStack.remove("capturePlacesBucketCidHeader");
  }
  const cid = trimToUndefined(capturedHeaders?.["x-amz-meta-cid"]);
  if (cid === undefined) {
    throw new Error(
      `Filebase generateBucketCid returned no x-amz-meta-cid for bucket ${bucket}.`,
    );
  }
  return cid;
}

function ipnsHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
}

async function listIpnsNames(fetchImpl: PlacesFetch, apiToken: string): Promise<FilebaseIpnsName[]> {
  const response = await fetchImpl(FILEBASE_IPNS_API, { method: "GET", headers: ipnsHeaders(apiToken) });
  if (!response.ok) {
    throw new Error(`Filebase IPNS list failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as FilebaseIpnsName[];
}

async function createIpnsName(
  fetchImpl: PlacesFetch,
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
  fetchImpl: PlacesFetch,
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

async function upsertPlacesIpnsPointer(
  fetchImpl: PlacesFetch,
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

export async function ensureDedicatedPlacesBucket(opts: {
  client: PlacesUploadClient;
  bucket: string;
  county: string;
}): Promise<"created" | "existing"> {
  assertDedicatedPlacesBucket(opts.bucket, opts.county);
  try {
    await opts.client.send(new HeadBucketCommand({ Bucket: opts.bucket }));
  } catch {
    await opts.client.send(new CreateBucketCommand({ Bucket: opts.bucket }));
    return "created";
  }
  const listing = await opts.client.send(new ListObjectsV2Command({ Bucket: opts.bucket, MaxKeys: 20 }));
  const keys = (listing.Contents ?? [])
    .map((object) => object.Key)
    .filter((key): key is string => typeof key === "string");
  const allowed = new Set(planPlacesUpload({ county: opts.county }).objects.map((object) => object.key));
  const unexpected = keys.filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Dedicated places bucket ${opts.bucket} already has unexpected keys: ${unexpected.join(", ")}`,
    );
  }
  return "existing";
}

export async function uploadPlacesTable(opts: {
  client: PlacesUploadClient;
  fetchImpl: PlacesFetch;
  env: PlacesPublishEnv;
  county: string;
  artifactDir: string;
}): Promise<PlacesPublishResult> {
  assertFilebaseCredentials(opts.env);
  const bucket = requireCredential(opts.env, "S3_BUCKET");
  assertDedicatedPlacesBucket(bucket, opts.county);
  const ipnsLabel = resolvePlacesIpnsLabel(opts.env, opts.county);
  const apiToken = requireCredential(opts.env, "FILEBASE_API_TOKEN");
  const plan = planPlacesUpload({ county: opts.county });

  for (const object of plan.objects) {
    const body = await readFile(join(opts.artifactDir, object.relativePath));
    await putObjectCapturingCid(opts.client, {
      bucket,
      key: object.key,
      body,
      contentType: object.contentType,
    });
  }

  const cid = await generateBucketDirectoryCid(opts.client, bucket);
  const ipnsName = await upsertPlacesIpnsPointer(opts.fetchImpl, apiToken, ipnsLabel, cid);
  return {
    bucket,
    cid,
    ipnsLabel,
    ipnsName,
    keys: plan.objects.map((object) => object.key),
    gatewayUrls: buildPlacesGatewayUrls(ipnsName, opts.county),
  };
}

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
    ) {
      return;
    }
    throw caught;
  }
}

type PlacesPublishCliOptions = {
  readonly county: string;
  readonly artifactDir: string;
  readonly envFile: string;
  readonly dryRun: boolean;
};

function parseCliOptions(argv: readonly string[]): PlacesPublishCliOptions {
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
  return {
    county,
    artifactDir:
      values.get("artifact-dir") ??
      join("downloads/overture-places", county, "2026-07-22.0", "publish"),
    envFile: values.get("env-file") ?? ".env.local",
    dryRun: values.get("dry-run") === "true",
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  loadEnvFile(options.envFile);
  const env: PlacesPublishEnv = { ...process.env };
  env.S3_BUCKET = env.S3_BUCKET ?? defaultPlacesBucket(options.county);
  env.FILEBASE_IPNS_LABEL = env.FILEBASE_IPNS_LABEL ?? defaultPlacesIpnsLabel(options.county);
  assertFilebaseCredentials(env);
  const bucket = requireCredential(env, "S3_BUCKET");
  assertDedicatedPlacesBucket(bucket, options.county);
  const ipnsLabel = resolvePlacesIpnsLabel(env, options.county);
  const plan = planPlacesUpload({ county: options.county });
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify({
        event: "places_publish_dry_run",
        bucket,
        ipnsLabel,
        keys: plan.objects.map((object) => object.key),
      })}\n`,
    );
    return;
  }
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "us-east-1",
    endpoint: requireCredential(env, "S3_ENDPOINT"),
    credentials: {
      accessKeyId: requireCredential(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: requireCredential(env, "S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
  const bucketState = await ensureDedicatedPlacesBucket({
    client,
    bucket,
    county: options.county,
  });
  process.stdout.write(
    `${JSON.stringify({ event: "places_bucket_ready", bucket, state: bucketState })}\n`,
  );
  const result = await uploadPlacesTable({
    client,
    fetchImpl: fetch,
    env,
    county: options.county,
    artifactDir: options.artifactDir,
  });
  process.stdout.write(`${JSON.stringify({ event: "places_publish_finished", ...result })}\n`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main(process.argv.slice(2)).catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`${JSON.stringify({ event: "places_publish_failed", error: message })}\n`);
    process.exitCode = 1;
  });
}
