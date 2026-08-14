import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseS3Uri } from "../src/loader/index.js";
import {
  defaultPlacesBucket,
  defaultPlacesIpnsLabel,
  restorePlacesIpnsPointer,
  uploadPlacesTable,
  type PlacesPublishEnv,
} from "./upload-places-table-to-filebase.js";

type PublishInput = {
  readonly mode: "publish";
  readonly county: string;
  readonly artifactS3Uri: string;
};

type RollbackInput = {
  readonly mode: "rollback";
  readonly county: string;
  readonly previousCid: string;
};

/**
 * Download the validated internal artifact, publish it to the dedicated
 * Filebase bucket/IPNS label, and persist the result for the verify stage.
 *
 * @param input Validated workflow publish input.
 * @returns Filebase/IPNS publish result.
 */
export async function runPlacesRefreshPublish(
  input: PublishInput | RollbackInput,
) {
  if (input.mode === "rollback") {
    const env: PlacesPublishEnv = {
      ...process.env,
      S3_BUCKET:
        process.env.S3_BUCKET ?? defaultPlacesBucket(input.county),
      FILEBASE_IPNS_LABEL:
        process.env.FILEBASE_IPNS_LABEL ??
        defaultPlacesIpnsLabel(input.county),
    };
    await restorePlacesIpnsPointer({
      fetchImpl: fetch,
      env,
      county: input.county,
      previousCid: input.previousCid,
    });
    return {
      rolledBack: true,
      county: input.county,
      restoredCid: input.previousCid,
    };
  }
  const artifactRoot = "/tmp/overture-places-publish";
  const awsS3 = new S3Client({});
  await downloadS3Prefix({
    client: awsS3,
    s3Uri: input.artifactS3Uri,
    localRoot: artifactRoot,
  });
  const env: PlacesPublishEnv = {
    ...process.env,
    S3_BUCKET:
      process.env.S3_BUCKET ?? defaultPlacesBucket(input.county),
    FILEBASE_IPNS_LABEL:
      process.env.FILEBASE_IPNS_LABEL ??
      defaultPlacesIpnsLabel(input.county),
  };
  const { S3Client: FilebaseS3Client } = await import("@aws-sdk/client-s3");
  const filebaseClient = new FilebaseS3Client({
    region: "us-east-1",
    endpoint: requireEnv("S3_ENDPOINT"),
    credentials: {
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
  return uploadPlacesTable({
    client: filebaseClient,
    fetchImpl: fetch,
    env,
    county: input.county,
    artifactDir: artifactRoot,
  });
}

/**
 * @param params Internal S3 prefix download.
 * @param params.client AWS S3 client.
 * @param params.s3Uri Source prefix.
 * @param params.localRoot Local destination.
 */
async function downloadS3Prefix(params: {
  readonly client: S3Client;
  readonly s3Uri: string;
  readonly localRoot: string;
}): Promise<void> {
  const { bucket, key } = parseS3Uri(params.s3Uri);
  const prefix = key.replace(/\/+$/, "");
  let continuationToken: string | undefined;
  let objectCount = 0;
  do {
    const response = await params.client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key === undefined || object.Key.endsWith("/")) continue;
      const relative = object.Key.slice(prefix.length + 1);
      if (
        relative.startsWith("../") ||
        relative.includes("/../") ||
        relative.length === 0
      ) {
        throw new Error(`Unsafe publication object key: ${object.Key}`);
      }
      const destination = join(params.localRoot, relative);
      await mkdir(dirname(destination), { recursive: true });
      const downloaded = await params.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
      if (downloaded.Body === undefined) {
        throw new Error(`Publication object has no body: ${object.Key}`);
      }
      await writeFile(
        destination,
        Buffer.from(await downloaded.Body.transformToByteArray()),
      );
      objectCount += 1;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  if (objectCount !== 3) {
    throw new Error(
      `Expected exactly 3 validated publication objects, found ${objectCount}`,
    );
  }
}

/**
 * @param name Environment variable.
 * @returns Required non-empty value.
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * @param raw Untrusted JSON input.
 * @returns Validated publish input.
 */
function parsePublishInput(raw: string): PublishInput | RollbackInput {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKFLOW_INPUT must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const county = readRequiredString(candidate["county"], "county");
  if (candidate["mode"] === "rollback") {
    return {
      mode: "rollback",
      county,
      previousCid: readRequiredString(
        candidate["previousCid"],
        "previousCid",
      ),
    };
  }
  return {
    mode: "publish",
    county,
    artifactS3Uri: readRequiredString(
      candidate["artifactS3Uri"],
      "artifactS3Uri",
    ),
  };
}

/**
 * @param value Untrusted value.
 * @param field Field label.
 * @returns Validated string.
 */
function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

async function main(): Promise<void> {
  const input = parsePublishInput(requireEnv("WORKFLOW_INPUT"));
  const taskToken = requireEnv("TASK_TOKEN");
  try {
    const result = await runPlacesRefreshPublish(input);
    await new SFNClient({}).send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify(result),
      }),
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await new SFNClient({})
      .send(
        new SendTaskFailureCommand({
          taskToken,
          error:
            caught instanceof Error
              ? caught.name.slice(0, 256)
              : "PlacesPublishError",
          cause: message.slice(0, 32_768),
        }),
      )
      .catch(() => undefined);
    throw caught;
  }
}

main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  process.stderr.write(
    `${JSON.stringify({ event: "places_refresh_publish_failed", error: message })}\n`,
  );
  process.exitCode = 1;
});
