import { describe, expect, it } from "vitest";

import { decideFixedKeyUpload } from "../scripts/upload-consolidation-to-filebase.js";

/**
 * Fixed-key files (index.json, manifest.json, shards/shard-*.json) keep stable
 * S3 keys across runs. A plain skip-by-key re-points IPNS at a STALE index when
 * a bucket still holds an older checkpoint (e.g. a sample export). The decision
 * below re-uploads a fixed-key file whenever its freshly-computed local CID
 * differs from the checkpoint's stored CID.
 */

const record = (cid: string) => ({
  key: "index.json",
  cid,
  uploadedAt: "2026-07-02T00:00:00.000Z",
});

describe("decideFixedKeyUpload", () => {
  it("uploads a fixed-key file that is not in the checkpoint yet", () => {
    expect(decideFixedKeyUpload(undefined, "bafyLocal", false)).toEqual({
      reupload: true,
      reason: "new",
    });
  });

  it("skips when the local CID matches the checkpoint CID", () => {
    expect(decideFixedKeyUpload(record("bafySame"), "bafySame", false)).toEqual({
      reupload: false,
    });
  });

  it("re-uploads when the local CID differs from the checkpoint CID (stale index guard)", () => {
    expect(decideFixedKeyUpload(record("bafyOldSample"), "bafyNewFull", false)).toEqual({
      reupload: true,
      reason: "content_changed",
    });
  });

  it("re-uploads defensively when the local CID could not be computed", () => {
    expect(decideFixedKeyUpload(record("bafyAny"), null, false)).toEqual({
      reupload: true,
      reason: "cid_unverifiable",
    });
  });

  it("re-uploads unconditionally under --force-index even when CIDs match", () => {
    expect(decideFixedKeyUpload(record("bafySame"), "bafySame", true)).toEqual({
      reupload: true,
      reason: "forced",
    });
  });

  it("treats a first upload as new even under --force-index", () => {
    expect(decideFixedKeyUpload(undefined, "bafySame", true)).toEqual({
      reupload: true,
      reason: "new",
    });
  });
});
