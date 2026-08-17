import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPublicationApprovalEnvelope,
  verifyPublicationApprovalEnvelope,
} from "../scripts/publication-artifact-envelope.js";
import { computeIpfsCid } from "../scripts/run-property-consolidation-export.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

async function buildFixture(): Promise<{
  readonly root: string;
  readonly watermark: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "publication-envelope-"));
  cleanupPaths.push(root);
  await Promise.all([
    mkdir(join(root, "property/properties"), { recursive: true }),
    mkdir(join(root, "property/shards"), { recursive: true }),
    mkdir(join(root, "query/rock-island"), { recursive: true }),
    mkdir(join(root, "coverage"), { recursive: true }),
  ]);
  const propertyBody = Buffer.from('{"parcelId":"parcel-1"}\n');
  const propertyCid = await computeIpfsCid(propertyBody);
  if (propertyCid === null) throw new Error("CID fixture failed");
  await writeFile(join(root, "property/properties/parcel-1.json"), propertyBody);
  const shardBody = Buffer.from(
    `${JSON.stringify({
      schemaVersion: "1",
      shardIndex: 0,
      fromParcel: "folio-1",
      toParcel: "folio-1",
      count: 1,
      entries: [
        {
          propertyId: "parcel-1",
          parcelIdentifier: "folio-1",
          cid: propertyCid,
          fileSizeBytes: propertyBody.byteLength,
        },
      ],
    }, null, 2)}\n`,
  );
  const shardCid = await computeIpfsCid(shardBody);
  if (shardCid === null) throw new Error("Shard CID fixture failed");
  await writeFile(join(root, "property/shards/shard-0000.json"), shardBody);
  await writeFile(
    join(root, "property/manifest.json"),
    `${JSON.stringify({
      propertyCount: 1,
      entries: [
        {
          propertyId: "parcel-1",
          sha256: createHash("sha256").update(propertyBody).digest("hex"),
          cid: propertyCid,
        },
      ],
    })}\n`,
  );
  await writeFile(
    join(root, "property/index.json"),
    `${JSON.stringify({
      propertyCount: 1,
      shards: [{ shardIndex: 0, shardCid }],
    })}\n`,
  );
  await Promise.all([
    writeFile(join(root, "validation-report.json"), '{"status":"verified"}\n'),
    writeFile(join(root, "query/rock-island/query-table.parquet"), "PAR1"),
    writeFile(join(root, "coverage/dataset-coverage.json"), '{"appraisal":"complete"}\n'),
  ]);
  const built = await buildPublicationApprovalEnvelope(root, "rock-island");
  await writeFile(
    join(root, "approval-envelope.json"),
    `${JSON.stringify(built.envelope, null, 2)}\n`,
  );
  return { root, watermark: built.watermark };
}

describe("immutable publication approval envelope", () => {
  it("detects artifact mutation after validation", async () => {
    const fixture = await buildFixture();
    await expect(
      verifyPublicationApprovalEnvelope(fixture.root, fixture.watermark),
    ).resolves.toMatchObject({ propertyCount: 1 });
    await writeFile(
      join(fixture.root, "coverage/dataset-coverage.json"),
      '{"appraisal":"changed"}\n',
    );
    await expect(
      verifyPublicationApprovalEnvelope(fixture.root, fixture.watermark),
    ).rejects.toThrow(/mutation detected/u);
  });
});
