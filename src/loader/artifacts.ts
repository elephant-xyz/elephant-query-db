import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export type ParsedS3Uri = {
  readonly bucket: string;
  readonly key: string;
};

export type TextArtifactReader = {
  readonly readText: (artifactUri: string) => Promise<string>;
  readonly listUris?: (prefixUri: string) => Promise<readonly string[]>;
};

export type S3ArtifactReaderOptions = {
  readonly client?: S3Client;
  readonly clientConfig?: S3ClientConfig;
};

export type JsonArtifactFormat = "auto" | "json" | "jsonl";

export type JsonArtifactRecord = {
  readonly artifactUri: string;
  readonly lineNumber: number | null;
  readonly record: unknown;
};

type BodyWithTransformToString = {
  readonly transformToString: () => Promise<string>;
};

/**
 * Parse an S3 URI into the bucket and key fields expected by the AWS SDK.
 *
 * @param artifactUri - Full S3 URI such as `s3://bucket/path/to/object.jsonl`.
 * @returns Parsed bucket and key values suitable for `GetObjectCommand`.
 * @throws When the URI is not an S3 URI or does not include a bucket name.
 */
export function parseS3Uri(artifactUri: string): ParsedS3Uri {
  const parsed = new URL(artifactUri);
  if (parsed.protocol !== "s3:") {
    throw new Error(`Expected s3:// artifact URI, received ${artifactUri}`);
  }
  if (parsed.hostname.length === 0) {
    throw new Error(`S3 artifact URI is missing a bucket: ${artifactUri}`);
  }
  return {
    bucket: parsed.hostname,
    key: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

/**
 * Build a canonical S3 URI from bucket and key components.
 *
 * @param parsedUri - Bucket and key pair to render.
 * @returns Canonical `s3://bucket/key` URI string.
 */
export function formatS3Uri(parsedUri: ParsedS3Uri): string {
  return `s3://${parsedUri.bucket}/${parsedUri.key}`;
}

/**
 * Create an AWS-backed text reader for loader artifacts.
 *
 * @param options - Optional preconfigured `S3Client` or constructor config.
 * @returns Text artifact reader that can fetch one S3 object or list object URIs under a prefix.
 */
export function createS3ArtifactReader(options: S3ArtifactReaderOptions = {}): TextArtifactReader {
  const client = options.client ?? new S3Client(options.clientConfig ?? {});
  return {
    async readText(artifactUri) {
      const { bucket, key } = parseS3Uri(artifactUri);
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (response.Body === undefined) {
        throw new Error(`S3 object had no body: ${artifactUri}`);
      }
      return bodyToString(response.Body, artifactUri);
    },
    async listUris(prefixUri) {
      const { bucket, key } = parseS3Uri(prefixUri);
      const uris: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
            Prefix: key,
          }),
        );
        for (const object of response.Contents ?? []) {
          if (object.Key !== undefined && object.Key.endsWith("/") === false) {
            uris.push(formatS3Uri({ bucket, key: object.Key }));
          }
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken !== undefined);
      return uris;
    },
  };
}

/**
 * Create a local filesystem text reader for smoke tests and local backfills.
 *
 * @returns Text artifact reader that accepts absolute paths or `file://` URIs.
 */
export function createLocalFileArtifactReader(): TextArtifactReader {
  return {
    async readText(artifactUri) {
      const path = artifactUri.startsWith("file://")
        ? fileURLToPath(artifactUri)
        : artifactUri;
      return readFile(path, "utf8");
    },
  };
}

/**
 * Read and parse a JSON or JSONL artifact through a configured text reader.
 *
 * @param reader - Artifact text reader, usually local file or S3 backed.
 * @param artifactUri - Artifact URI to read.
 * @param format - Explicit JSON format, or `auto` to try whole JSON before JSONL.
 * @returns Parsed artifact records with source URI and line numbers for JSONL inputs.
 */
export async function readJsonArtifactRecords(
  reader: TextArtifactReader,
  artifactUri: string,
  format: JsonArtifactFormat = "auto",
): Promise<readonly JsonArtifactRecord[]> {
  const text = await reader.readText(artifactUri);
  return parseJsonArtifactRecords({ artifactUri, text, format });
}

/**
 * Parse JSON text into loader records, preserving line numbers for JSONL files.
 *
 * @param params - Artifact URI, raw text, and optional format hint.
 * @returns Parsed records. JSON arrays produce one record per entry; JSON objects produce one record.
 */
export function parseJsonArtifactRecords(params: {
  readonly artifactUri: string;
  readonly text: string;
  readonly format?: JsonArtifactFormat;
}): readonly JsonArtifactRecord[] {
  const format = params.format ?? "auto";
  if (format === "jsonl") return parseJsonLines(params.artifactUri, params.text);
  if (format === "json") return parsedJsonToRecords(params.artifactUri, JSON.parse(params.text));

  try {
    return parsedJsonToRecords(params.artifactUri, JSON.parse(params.text));
  } catch (caught) {
    if (caught instanceof SyntaxError) {
      return parseJsonLines(params.artifactUri, params.text);
    }
    throw caught;
  }
}

function parsedJsonToRecords(artifactUri: string, parsed: unknown): readonly JsonArtifactRecord[] {
  if (Array.isArray(parsed)) {
    return parsed.map((record) => ({ artifactUri, lineNumber: null, record }));
  }
  return [{ artifactUri, lineNumber: null, record: parsed }];
}

function parseJsonLines(artifactUri: string, text: string): readonly JsonArtifactRecord[] {
  const records: JsonArtifactRecord[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    records.push({
      artifactUri,
      lineNumber: index + 1,
      record: JSON.parse(trimmed),
    });
  });
  return records;
}

function bodyToString(body: unknown, artifactUri: string): Promise<string> {
  if (hasTransformToString(body)) return body.transformToString();
  if (typeof body === "string") return Promise.resolve(body);
  if (body instanceof Uint8Array) return Promise.resolve(new TextDecoder().decode(body));
  throw new Error(`Unsupported S3 body type for ${artifactUri}`);
}

function hasTransformToString(value: unknown): value is BodyWithTransformToString {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly transformToString?: unknown };
  return typeof candidate.transformToString === "function";
}
