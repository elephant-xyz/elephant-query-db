import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { OracleDatasetCoverageSnapshot } from "../src/coverage/oracleDatasetCoverage.js";

/**
 * Non-appraisal coverage tracks emitted as honestly incomplete (`expected_count: null`).
 *
 * `corporate` is the published-snapshot spelling of the Neon `sunbiz` track — a
 * pre-existing mismatch. Places uses one spelling, `overture_places`, in both.
 */
export const PUBLIC_COVERAGE_ENRICHMENT_TRACKS = [
  "permits",
  "corporate",
  "bbb",
  "overture_places",
] as const;

export type PublicCoverageOptions = {
  readonly county: string;
  readonly appraisalCount: number;
  readonly outputPath: string;
};

/**
 * Parse the explicit public-coverage snapshot command line.
 *
 * @param argv - Arguments after the script name.
 * @returns County, exact appraisal count, and local output path.
 */
export function parsePublicCoverageOptions(
  argv: readonly string[],
): PublicCoverageOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const county = values.get("county") ?? "rock-island";
  const appraisalCount = Number.parseInt(
    values.get("appraisal-count") ?? "",
    10,
  );
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(county)) {
    throw new Error("county must be a lowercase hyphenated slug");
  }
  if (!Number.isInteger(appraisalCount) || appraisalCount < 1) {
    throw new Error("--appraisal-count must be a positive integer");
  }
  return {
    county,
    appraisalCount,
    outputPath:
      values.get("output") ??
      join(".dataset-coverage", county, "dataset-coverage.json"),
  };
}

/**
 * Build an honest appraisal-only coverage snapshot.
 *
 * Non-appraisal datasets are explicitly present at zero with unknown expected
 * counts, which means "not ingested" rather than "complete at zero". Copy Santa
 * Clara (`expected_count: null`), not the older 100%-by-construction rows.
 *
 * @param options - County and exact reconciled appraisal count.
 * @param exportedAt - Deterministic snapshot timestamp.
 * @returns MCP-compatible coverage JSON.
 */
export function buildPublicCoverageSnapshot(
  options: PublicCoverageOptions,
  exportedAt: string,
): OracleDatasetCoverageSnapshot {
  const emptyTrack = (source: string) => ({
    county: options.county,
    source,
    ingested_count: 0,
    expected_count: null,
    first_loaded_at: null,
    last_loaded_at: null,
    cid: null,
    ipns_label: null,
  });
  return {
    county: options.county,
    exportedAt,
    datasets: [
      {
        county: options.county,
        source: "appraisal",
        ingested_count: options.appraisalCount,
        expected_count: options.appraisalCount,
        first_loaded_at: null,
        last_loaded_at: null,
        cid: null,
        ipns_label: null,
      },
      ...PUBLIC_COVERAGE_ENRICHMENT_TRACKS.map((source) => emptyTrack(source)),
    ],
  };
}

/**
 * Write the local coverage snapshot without publishing it.
 *
 * @param options - County/count/output configuration.
 * @returns Snapshot body and byte count.
 */
export async function writePublicCoverageSnapshot(
  options: PublicCoverageOptions,
): Promise<{
  readonly snapshot: OracleDatasetCoverageSnapshot;
  readonly bytes: number;
}> {
  const snapshot = buildPublicCoverageSnapshot(
    options,
    new Date().toISOString(),
  );
  const body = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, body, { mode: 0o600 });
  console.log(
    JSON.stringify({
      event: "public_coverage_snapshot_written",
      outputPath: options.outputPath,
      bytes: body.byteLength,
      datasetCount: snapshot.datasets.length,
    }),
  );
  return { snapshot, bytes: body.byteLength };
}

/**
 * Execute the coverage writer when invoked directly.
 *
 * @returns A promise that resolves after the local file is durable.
 */
async function main(): Promise<void> {
  await writePublicCoverageSnapshot(
    parsePublicCoverageOptions(process.argv.slice(2)),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      JSON.stringify({
        event: "public_coverage_snapshot_failed",
        error: message,
      }),
    );
    process.exit(1);
  });
}
