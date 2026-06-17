import { createHash } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import { put } from "@vercel/blob";
import { Pool, type PoolClient } from "pg";

import {
  buildPermitDocumentBlobPathname,
  inferPermitDocumentExtension,
  isJsonObject,
  isStorablePermitDocumentUrl,
  normalizeParcelIdentifier,
} from "../src/loader/index.js";

type PermitDocumentUploadOptions = {
  readonly envFile: string;
  readonly parcelManifest: string;
  readonly statePath: string;
  readonly concurrency: number;
  readonly limit: number | null;
  readonly continueOnError: boolean;
};

type PermitLinkRow = {
  readonly permit_link_id: string;
  readonly source_record_key: string;
  readonly permit_number: string | null;
  readonly parcel_identifier: string | null;
  readonly url: string;
};

type PermitDocumentStateRecord = {
  readonly event: "permit_document_uploaded" | "permit_document_failed";
  readonly completedAt: string;
  readonly permitLinkId: string;
  readonly sourceRecordKey: string;
  readonly permitNumber: string | null;
  readonly parcelIdentifier: string | null;
  readonly url: string;
  readonly storageUri: string | null;
  readonly contentSha256: string | null;
  readonly error: string | null;
};

const DEFAULT_STATE_PATH = ".loader-runs/curated-commercial-appraisal/permit-document-upload-state.jsonl";
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Download selected permit source-document links, upload them to Vercel Blob,
 * and write the Blob URL back to `permit_links.storage_uri`.
 *
 * This runner is intentionally post-load: after the final scoped permit rows
 * are in Neon, it queries only links whose parent permits belong to the selected
 * parcel manifest, uploads document-like URLs, and updates their storage
 * metadata in place.
 *
 * @returns Promise that resolves once selected pending links have been attempted.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(`DATABASE_URL is required; expected it in ${options.envFile}`);
  }
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken === undefined || blobToken.trim().length === 0) {
    throw new Error(`BLOB_READ_WRITE_TOKEN is required; expected it in ${options.envFile}`);
  }

  const selectedParcels = await readSelectedParcels(options.parcelManifest);
  const completedLinks = await readCompletedPermitLinkIds(options.statePath);
  const pool = new Pool({
    application_name: "permit-document-blob-uploader",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: Math.max(2, options.concurrency),
  });

  try {
    const rows = (await readPermitLinks(pool, selectedParcels))
      .filter((row) => completedLinks.has(row.permit_link_id) === false)
      .slice(0, options.limit ?? undefined);
    let nextIndex = 0;
    let shouldStop = false;
    const failures: string[] = [];

    console.log(JSON.stringify({
      event: "permit_document_upload_started",
      parcelManifest: options.parcelManifest,
      selectedParcelCount: selectedParcels.length,
      pendingLinkCount: rows.length,
      alreadyCompletedLinks: completedLinks.size,
      concurrency: options.concurrency,
    }));

    const workers = Array.from({ length: options.concurrency }, async (_unused, workerIndex) => {
      while (shouldStop === false) {
        const recordIndex = nextIndex;
        nextIndex += 1;
        const row = rows[recordIndex];
        if (row === undefined) return;
        const client = await pool.connect();
        try {
          const stateRecord = await uploadPermitDocument({ blobToken, client, row });
          await appendStateRecord(options.statePath, stateRecord);
          console.log(JSON.stringify({
            event: "permit_document_uploaded",
            workerIndex,
            permitLinkId: row.permit_link_id,
            permitNumber: row.permit_number,
            storageUri: stateRecord.storageUri,
            completedCount: recordIndex + 1,
            pendingLinkCount: rows.length,
          }));
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          failures.push(message);
          await appendStateRecord(options.statePath, {
            event: "permit_document_failed",
            completedAt: new Date().toISOString(),
            permitLinkId: row.permit_link_id,
            sourceRecordKey: row.source_record_key,
            permitNumber: row.permit_number,
            parcelIdentifier: row.parcel_identifier,
            url: row.url,
            storageUri: null,
            contentSha256: null,
            error: message,
          });
          console.error(JSON.stringify({
            event: "permit_document_upload_failed_record",
            workerIndex,
            permitLinkId: row.permit_link_id,
            permitNumber: row.permit_number,
            error: message,
          }));
          if (options.continueOnError === false) shouldStop = true;
        } finally {
          client.release();
        }
      }
    });

    await Promise.all(workers);
    if (failures.length > 0) {
      throw new Error(`${failures.length} permit document upload(s) failed; see ${options.statePath}`);
    }
  } finally {
    await pool.end();
  }
}

async function readPermitLinks(
  pool: Pool,
  selectedParcels: readonly string[],
): Promise<readonly PermitLinkRow[]> {
  const result = await pool.query<PermitLinkRow>(
    `
      select
        pl.permit_link_id::text,
        pl.source_record_key,
        pi.permit_number,
        pi.parcel_identifier,
        pl.url
      from permit_links pl
      join property_improvements pi
        on pi.property_improvement_id = pl.property_improvement_id
      where pi.source_system = 'lee_accela'
        and regexp_replace(coalesce(pi.parcel_identifier, ''), '\\D', '', 'g') = any($1::text[])
        and pl.storage_uri is null
        and pl.url ilike 'http%'
      order by pi.parcel_identifier nulls last, pi.permit_number nulls last, pl.permit_link_id
    `,
    [selectedParcels],
  );
  return result.rows.filter((row) => isStorablePermitDocumentUrl(row.url));
}

async function uploadPermitDocument(params: {
  readonly blobToken: string;
  readonly client: PoolClient;
  readonly row: PermitLinkRow;
}): Promise<PermitDocumentStateRecord> {
  const response = await fetchWithTimeout(params.row.url);
  if (response.ok === false) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type");
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const pathname = buildPermitDocumentBlobPathname({
    extension: inferPermitDocumentExtension({ contentType, url: params.row.url }),
    permitNumber: params.row.permit_number,
    sourceRecordKey: params.row.source_record_key,
    url: params.row.url,
  });
  const blob = await put(
    pathname,
    bytes,
    contentType === null
      ? {
          access: "public",
          allowOverwrite: true,
          cacheControlMaxAge: 31_536_000,
          token: params.blobToken,
        }
      : {
          access: "public",
          allowOverwrite: true,
          cacheControlMaxAge: 31_536_000,
          contentType,
          token: params.blobToken,
        },
  );
  const uploadedAt = new Date().toISOString();
  await params.client.query(
    `
      update permit_links
      set storage_uri = $1,
          content_sha256 = $2,
          uploaded_at = $3::timestamptz
      where permit_link_id = $4::uuid
    `,
    [blob.url, contentSha256, uploadedAt, params.row.permit_link_id],
  );
  return {
    event: "permit_document_uploaded",
    completedAt: uploadedAt,
    permitLinkId: params.row.permit_link_id,
    sourceRecordKey: params.row.source_record_key,
    permitNumber: params.row.permit_number,
    parcelIdentifier: params.row.parcel_identifier,
    url: params.row.url,
    storageUri: blob.url,
    contentSha256,
    error: null,
  };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        "user-agent": "elephant-query-db-permit-document-loader/0.1",
      },
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readSelectedParcels(path: string): Promise<readonly string[]> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  const parcelValues = new Set<string>();
  if (isJsonObject(parsed) && Array.isArray(parsed.candidates)) {
    for (const candidate of parsed.candidates) {
      if (isJsonObject(candidate)) addParcelValue(parcelValues, candidate.parcelIdentifier);
    }
  } else if (Array.isArray(parsed)) {
    for (const candidate of parsed) {
      if (typeof candidate === "string") addParcelValue(parcelValues, candidate);
      if (isJsonObject(candidate)) addParcelValue(parcelValues, candidate.parcelIdentifier);
    }
  } else {
    throw new Error(`Unsupported parcel manifest shape: ${path}`);
  }
  return [...parcelValues].sort();
}

function addParcelValue(values: Set<string>, value: unknown): void {
  const normalized = normalizeParcelIdentifier(value);
  if (normalized !== null) values.add(normalized);
}

async function readCompletedPermitLinkIds(path: string): Promise<ReadonlySet<string>> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return new Set();
    throw caught;
  }
  const completed = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (isJsonObject(parsed) && parsed.event === "permit_document_uploaded" && typeof parsed.permitLinkId === "string") {
      completed.add(parsed.permitLinkId);
    }
  }
  return completed;
}

async function appendStateRecord(path: string, record: PermitDocumentStateRecord): Promise<void> {
  await appendFile(path, JSON.stringify(record).concat("\n"), "utf8");
}

function parseOptions(args: readonly string[]): PermitDocumentUploadOptions {
  const values = readCliValues(args);
  const parcelManifest = values.get("parcel-manifest");
  if (parcelManifest === undefined) {
    throw new Error("--parcel-manifest is required");
  }
  return {
    envFile: values.get("env-file") ?? ".env.local",
    parcelManifest,
    statePath: values.get("state") ?? DEFAULT_STATE_PATH,
    concurrency: parsePositiveInteger(values.get("concurrency"), 4, "concurrency"),
    limit: parseOptionalPositiveInteger(values.get("limit"), "limit"),
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

function loadEnvFile(path: string): void {
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex);
    let value = trimmed.slice(equalsIndex + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
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

await main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  console.error(JSON.stringify({ event: "permit_document_upload_failed", error: message }));
  process.exitCode = 1;
});
