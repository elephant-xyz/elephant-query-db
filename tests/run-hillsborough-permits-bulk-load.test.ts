import { describe, expect, it } from "vitest";

import { parseOptions } from "../scripts/run-hillsborough-permits-bulk-load.js";

describe("run-hillsborough-permits-bulk-load", () => {
  it("parses CLI options with Hillsborough defaults", () => {
    expect(
      parseOptions([
        "--env-file",
        ".env.local",
        "--input",
        "permits.jsonl",
        "--batch-size",
        "25000",
      ]),
    ).toEqual({
      envFile: ".env.local",
      inputPath: "permits.jsonl",
      permitSourceSystem: "hillsborough_permits",
      batchSize: 25000,
      limit: null,
      dryRun: false,
    });
  });

  it("throws on invalid batch size", () => {
    expect(() => parseOptions(["--batch-size", "-5"])).toThrow(
      "--batch-size must be a positive number",
    );
  });
});
