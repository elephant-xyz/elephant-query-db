import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  COUNTY_KEYED_SOURCES,
  COVERAGE_SOURCES,
  GLOBAL_COVERAGE_SOURCES,
  computeCoverage,
  countySlugFromJurisdictionKey,
  readCoverageRowsForCounty,
  refreshGlobalSourceCoverage,
  upsertCoverageRow,
  type CoverageComputation,
  type CoverageQueryClient,
  type CoverageSource,
} from "./oracle-dataset-coverage-upsert.js";

/**
 * One-time (idempotent, rerunnable) backfill for `oracle_dataset_coverage`.
 *
 * Discovers every county already loaded in Neon from the appraisal `source_system`
 * values, then recomputes and upserts per-source `ingested_count` (+ first/last load
 * timestamps) for every source that actually has data:
 *  - appraisal (per county, when the county has properties),
 *  - permits (per county, when the county's permit source prefix matches any rows),
 *  - sunbiz / bbb (one scan each; attributed to the county parsed from each row's
 *    `source_artifact_uri` and grouped by it, so only counties that truly have harvested
 *    business rows get a row — matches the per-cycle loader upsert).
 *
 * County-keyed sources only ever write a row when the computed `ingested_count` is > 0,
 * so empty sources never create noise rows. Global sources additionally prune stale rows:
 * any pre-existing sunbiz/bbb row for a county that no longer parses out of the artifact
 * URIs (e.g. the earlier fanned-out `orange`/`santa-clara` rows) is deleted. Re-running is
 * safe: counts and `last_loaded_at` are recomputed, and `first_loaded_at` keeps its earliest
 * value.
 */

export type BackfillOptions = {
  readonly envFile: string;
  /** Explicit county slugs to process; when null, counties are discovered from Neon. */
  readonly counties: readonly string[] | null;
};

/**
 * Parse CLI options for the backfill.
 *
 * @param argv - Raw command-line arguments after the script name.
 * @returns Normalized backfill options.
 */
export function parseOptions(argv: readonly string[]): BackfillOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const countiesRaw = values.get("county") ?? values.get("counties");
  const counties =
    countiesRaw === undefined || countiesRaw === "true"
      ? null
      : countiesRaw
          .split(",")
          .map((slug) => slug.trim())
          .filter((slug) => slug.length > 0);

  return {
    envFile: values.get("env-file") ?? ".env.local",
    counties: counties !== null && counties.length > 0 ? counties : null,
  };
}

/**
 * Load `KEY=VALUE` pairs from a dotenv-style file into `process.env` without
 * overriding values already present in the environment.
 *
 * @param envFile - Path to a dotenv-style file.
 */
function loadEnvFile(envFile: string): void {
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch (caught) {
    if (
      caught instanceof Error &&
      "code" in caught &&
      (caught as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw caught;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex);
    let value = trimmed.slice(equalsIndex + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Discover the hyphen county slugs already loaded in Neon from the distinct
 * appraisal `source_system` values on `properties`.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @returns Sorted, de-duplicated county slugs derived from `<county>_appraiser` sources.
 */
export async function discoverAppraisalCounties(
  client: CoverageQueryClient,
): Promise<readonly string[]> {
  const result = await client.query<{ source_system: string | null }>(
    `SELECT DISTINCT source_system FROM properties WHERE source_system IS NOT NULL`,
  );
  const slugs = new Set<string>();
  for (const row of result.rows) {
    const sourceSystem = row.source_system;
    if (typeof sourceSystem !== "string") continue;
    if (!sourceSystem.toLowerCase().endsWith("_appraiser")) continue;
    const slug = countySlugFromJurisdictionKey(sourceSystem);
    if (slug.length > 0) slugs.add(slug);
  }
  return [...slugs].sort();
}

/**
 * Backfill coverage for the given counties. County-keyed sources (appraisal, permits)
 * are refreshed per county; global sources (sunbiz, bbb) are refreshed in one scan each,
 * attributing rows to the county parsed from `source_artifact_uri` and pruning stale rows
 * for counties that no longer qualify. Runs sequentially to keep DB load predictable.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param counties - County slugs to process for the county-keyed sources.
 * @returns Every non-empty coverage computation that was upserted.
 */
export async function backfillCoverage(
  client: CoverageQueryClient,
  counties: readonly string[],
): Promise<readonly CoverageComputation[]> {
  const written: CoverageComputation[] = [];

  for (const county of counties) {
    for (const source of COUNTY_KEYED_SOURCES) {
      const computation = await refreshCoverageIfPopulated(client, county, source);
      if (computation !== null) {
        written.push(computation);
        console.log(
          JSON.stringify({
            event: "oracle_dataset_coverage_backfilled",
            county,
            source,
            ingestedCount: computation.ingestedCount,
            firstLoadedAt: computation.firstLoadedAt,
            lastLoadedAt: computation.lastLoadedAt,
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            event: "oracle_dataset_coverage_skipped_empty",
            county,
            source,
          }),
        );
      }
    }
  }

  for (const source of GLOBAL_COVERAGE_SOURCES) {
    const computations = await refreshGlobalSourceCoverage(client, source);
    for (const computation of computations) {
      written.push(computation);
      console.log(
        JSON.stringify({
          event: "oracle_dataset_coverage_backfilled",
          county: computation.county,
          source,
          ingestedCount: computation.ingestedCount,
          firstLoadedAt: computation.firstLoadedAt,
          lastLoadedAt: computation.lastLoadedAt,
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "oracle_dataset_coverage_global_source_refreshed",
        source,
        counties: computations.map((computation) => computation.county),
      }),
    );
  }

  return written;
}

/**
 * Compute coverage for a county-keyed (county, source) and upsert only when the source
 * has data.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param county - Hyphen county slug.
 * @param source - County-keyed dataset source to refresh.
 * @returns The written computation, or null when the source is empty for the county.
 */
async function refreshCoverageIfPopulated(
  client: CoverageQueryClient,
  county: string,
  source: CoverageSource,
): Promise<CoverageComputation | null> {
  // Compute first, then only upsert when the source has data so empty sources
  // (e.g. a county with no permits yet) never create noise rows.
  const computation = await computeCoverage(client, county, source);
  if (computation.ingestedCount <= 0) return null;
  await upsertCoverageRow(client, computation);
  return computation;
}

/**
 * Entry point: connect to Neon, resolve counties, backfill, and print the resulting rows.
 *
 * @returns Promise that resolves once the backfill has completed and been reported.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(
      `DATABASE_URL is required; expected it in ${options.envFile} or the environment`,
    );
  }

  const pool = new Pool({
    application_name: "elephant-oracle-dataset-coverage-backfill",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 3,
  });
  pool.on("error", (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "database_pool_error", error: message }));
  });

  try {
    const counties =
      options.counties ?? (await discoverAppraisalCounties(pool));
    console.log(
      JSON.stringify({
        event: "oracle_dataset_coverage_backfill_started",
        counties,
        sources: COVERAGE_SOURCES,
      }),
    );

    if (counties.length === 0) {
      console.log(
        JSON.stringify({ event: "oracle_dataset_coverage_backfill_no_counties" }),
      );
      return;
    }

    const written = await backfillCoverage(pool, counties);

    const reportCounties = [
      ...new Set<string>([
        ...counties,
        ...written.map((computation) => computation.county),
      ]),
    ].sort();

    for (const county of reportCounties) {
      const rows = await readCoverageRowsForCounty(pool, county);
      console.log(
        JSON.stringify({
          event: "oracle_dataset_coverage_backfill_county_rows",
          county,
          rows,
        }),
      );
    }

    console.log(
      JSON.stringify({
        event: "oracle_dataset_coverage_backfill_finished",
        countiesProcessed: counties.length,
        rowsWritten: written.length,
      }),
    );
  } finally {
    await pool.end();
  }
}

/**
 * Detect whether this module was invoked directly (so importing it for tests never
 * opens a database connection).
 *
 * @returns True when run as the process entry point.
 */
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ event: "oracle_dataset_coverage_backfill_failed", error: message }),
    );
    process.exit(1);
  });
}
