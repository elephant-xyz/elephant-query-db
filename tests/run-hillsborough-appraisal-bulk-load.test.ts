import { describe, expect, it } from "vitest";

import { parseOptions } from "../scripts/run-hillsborough-appraisal-bulk-load.js";

describe("run-hillsborough-appraisal-bulk-load", () => {
  it("parses CLI options with default parameters", () => {
    expect(
      parseOptions([
        "--env-file",
        ".env.local",
        "--batch-parcels",
        "2000",
        "--county-name",
        "Hillsborough",
      ]),
    ).toEqual({
      envFile: ".env.local",
      parcelsDir: "../oracle-node-hillsborough/downloads/hillsborough/full-run",
      countyName: "Hillsborough",
      stateCode: "FL",
      sourceSystem: "hillsborough_appraiser",
      batchParcels: 2000,
      limit: null,
      offset: 0,
      dryRun: false,
      checkpointFile:
        "../oracle-node-hillsborough/downloads/hillsborough/appraisal-bulk-checkpoint.json",
    });
  });

  it("throws on invalid batch-parcels", () => {
    expect(() => parseOptions(["--batch-parcels", "0"])).toThrow(
      "--batch-parcels must be a positive number",
    );
  });
});
