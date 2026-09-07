import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildArtifactS3ClientConfig, isCliEntrypoint } from "../scripts/run-bulk-data-load.js";

describe("isCliEntrypoint", () => {
  it("matches a relative argv path against an encoded file URL", () => {
    const absolute = "/Volumes/mrnda 2tb/elephant/elephant-query-db-overture-places/scripts/run-bulk-data-load.ts";
    expect(isCliEntrypoint(pathToFileURL(absolute).href, absolute)).toBe(true);
  });

  it("rejects a missing argv path so imports do not start the loader", () => {
    expect(isCliEntrypoint("file:///tmp/run-bulk-data-load.ts", undefined)).toBe(false);
  });
});

describe("buildArtifactS3ClientConfig", () => {
  it("keeps the default AWS client chain when no local endpoint is configured", () => {
    expect(buildArtifactS3ClientConfig(undefined)).toEqual({});
    expect(buildArtifactS3ClientConfig("  ")).toEqual({});
  });

  it("uses path-style local S3rver configuration when explicitly requested", () => {
    expect(buildArtifactS3ClientConfig(" http://127.0.0.1:4569 ")).toEqual({
      endpoint: "http://127.0.0.1:4569",
      forcePathStyle: true,
      region: "us-east-1",
      credentials: {
        accessKeyId: "S3RVER",
        secretAccessKey: "S3RVER",
      },
    });
  });
});
