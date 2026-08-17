import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createRequire } from "node:module";

import { canonicalJsonSha256, isJsonObject } from "./public-geometry.js";

type ManifestEntry = {
  readonly propertyId: string;
  readonly sha256: string;
  readonly cid: string;
};

type PropertyManifest = {
  readonly propertyCount: number;
  readonly entries: readonly ManifestEntry[];
};

type IndexFile = {
  readonly propertyCount: number;
  readonly shards: ReadonlyArray<{
    readonly shardIndex: number;
    readonly shardCid: string;
  }>;
};

export type ArtifactDigest = {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly cid: string;
};

export type PublicationApprovalEnvelope = {
  readonly schemaVersion: "1";
  readonly county: string;
  readonly propertyCount: number;
  readonly propertyFilesMerkleSha256: string;
  readonly artifacts: readonly ArtifactDigest[];
};

const require = createRequire(import.meta.url);
const ipfsHash = require("ipfs-only-hash") as {
  of: (content: Buffer) => Promise<string>;
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function digestArtifact(
  root: string,
  relativePath: string,
): Promise<ArtifactDigest> {
  const body = await readFile(join(root, relativePath));
  return {
    path: relativePath,
    sizeBytes: body.byteLength,
    sha256: sha256(body),
    cid: await ipfsHash.of(body),
  };
}

/**
 * Hash every publication artifact into one immutable approval envelope.
 *
 * @param root - Publication artifact root.
 * @param county - County slug used by the query-table path.
 * @returns Envelope and its canonical SHA-256 content watermark.
 */
export async function buildPublicationApprovalEnvelope(
  root: string,
  county: string,
): Promise<{
  readonly envelope: PublicationApprovalEnvelope;
  readonly watermark: string;
}> {
  const manifestBody = await readFile(join(root, "property/manifest.json"));
  const manifest = JSON.parse(manifestBody.toString("utf8")) as PropertyManifest;
  const indexBody = await readFile(join(root, "property/index.json"));
  const index = JSON.parse(indexBody.toString("utf8")) as IndexFile;
  if (
    manifest.propertyCount !== manifest.entries.length ||
    index.propertyCount !== manifest.propertyCount
  ) {
    throw new Error("Property manifest/index count mismatch");
  }

  const propertyAggregate = createHash("sha256");
  for (const entry of [...manifest.entries].sort((left, right) =>
    left.propertyId.localeCompare(right.propertyId),
  )) {
    const relativePath = `property/properties/${entry.propertyId}.json`;
    const body = await readFile(join(root, relativePath));
    const actualSha256 = sha256(body);
    const actualCid = await ipfsHash.of(body);
    if (actualSha256 !== entry.sha256 || actualCid !== entry.cid) {
      throw new Error(`Property manifest content mismatch: ${entry.propertyId}`);
    }
    propertyAggregate.update(
      `${relativePath}|${actualSha256}|${actualCid}|${body.byteLength}\n`,
    );
  }

  const artifactPaths = [
    "validation-report.json",
    "property/manifest.json",
    "property/index.json",
    ...index.shards.map(
      (shard) =>
        `property/shards/shard-${String(shard.shardIndex).padStart(4, "0")}.json`,
    ),
    `query/${county}/query-table.parquet`,
    "coverage/dataset-coverage.json",
  ];
  const artifacts: ArtifactDigest[] = [];
  for (const relativePath of artifactPaths) {
    artifacts.push(await digestArtifact(root, relativePath));
  }
  index.shards.forEach((shard, shardOffset) => {
    const artifact = artifacts[shardOffset + 3];
    if (artifact?.cid !== shard.shardCid) {
      throw new Error(`Index shard CID mismatch: ${shard.shardIndex}`);
    }
  });

  const envelope: PublicationApprovalEnvelope = {
    schemaVersion: "1",
    county,
    propertyCount: manifest.propertyCount,
    propertyFilesMerkleSha256: propertyAggregate.digest("hex"),
    artifacts,
  };
  return { envelope, watermark: canonicalJsonSha256(envelope) };
}

/**
 * Re-hash the complete artifact tree and compare it with the stored envelope.
 *
 * @param root - Publication artifact root.
 * @param expectedWatermark - Human-approved content watermark.
 * @returns Verified envelope.
 */
export async function verifyPublicationApprovalEnvelope(
  root: string,
  expectedWatermark: string,
): Promise<PublicationApprovalEnvelope> {
  const envelopePath = join(root, "approval-envelope.json");
  const parsed = JSON.parse(await readFile(envelopePath, "utf8")) as unknown;
  if (!isJsonObject(parsed) || canonicalJsonSha256(parsed) !== expectedWatermark) {
    throw new Error("Approval envelope does not match the requested watermark");
  }
  const stored = parsed as PublicationApprovalEnvelope;
  const rebuilt = await buildPublicationApprovalEnvelope(root, stored.county);
  if (canonicalJsonSha256(rebuilt.envelope) !== expectedWatermark) {
    throw new Error("Publication artifact mutation detected after validation");
  }
  return stored;
}

type CliOptions = {
  readonly root: string;
  readonly county: string;
  readonly expectedWatermark: string | null;
  readonly write: boolean;
};

function parseOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const write = argv.includes("--write");
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") === true && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const root = values.get("root");
  const county = values.get("county");
  if (root === undefined || county === undefined) {
    throw new Error("--root and --county are required");
  }
  return {
    root,
    county,
    expectedWatermark: values.get("expected-watermark") ?? null,
    write,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.write) {
    const result = await buildPublicationApprovalEnvelope(
      options.root,
      options.county,
    );
    await writeFile(
      join(options.root, "approval-envelope.json"),
      `${JSON.stringify(result.envelope, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ event: "approval_envelope_written", watermark: result.watermark }));
    return;
  }
  if (options.expectedWatermark === null) {
    throw new Error("--expected-watermark is required when verifying");
  }
  const envelope = await verifyPublicationApprovalEnvelope(
    options.root,
    options.expectedWatermark,
  );
  const envelopeStat = await stat(join(options.root, "approval-envelope.json"));
  console.log(
    JSON.stringify({
      event: "approval_envelope_verified",
      watermark: options.expectedWatermark,
      propertyCount: envelope.propertyCount,
      envelopeSizeBytes: envelopeStat.size,
    }),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "approval_envelope_failed", error: message }));
    process.exit(1);
  });
}
