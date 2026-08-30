import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isCliEntrypoint } from "../scripts/run-bulk-data-load.js";

describe("isCliEntrypoint", () => {
  it("matches a relative argv path against an encoded file URL", () => {
    const absolute = "/Volumes/mrnda 2tb/elephant/elephant-query-db-overture-places/scripts/run-bulk-data-load.ts";
    expect(isCliEntrypoint(pathToFileURL(absolute).href, absolute)).toBe(true);
  });

  it("rejects a missing argv path so imports do not start the loader", () => {
    expect(isCliEntrypoint("file:///tmp/run-bulk-data-load.ts", undefined)).toBe(false);
  });
});
