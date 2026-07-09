import {
  ORACLE_DATASET_COVERAGE_TABLE,
  type OracleDatasetCoverageRow,
} from "../src/coverage/oracleDatasetCoverage.js";

import { appraisalSourceForCounty } from "./run-property-consolidation-export.js";
import { permitSourcePrefixForCounty } from "./run-permit-table-export.js";

/**
 * Write side of `oracle_dataset_coverage`.
 *
 * This module is shared by the one-time backfill (`backfill-oracle-dataset-coverage.ts`)
 * and the per-cycle upsert wired into the bulk loader (`run-bulk-data-load.ts`), so the
 * count/derivation logic lives in exactly one place. It NEVER changes publish behavior —
 * the snapshot/publish path (`write-oracle-dataset-coverage-snapshot.ts`) only reads the
 * rows this module writes.
 *
 * County derivation intentionally mirrors the query-table / permit-table publish:
 *  - appraisal counts use `appraisalSourceForCounty` (exact `<county>_appraiser` source),
 *    and the count is the DISTINCT-folio count so it lines up with the query-table
 *    `propertyCount`.
 *  - permit counts use `permitSourcePrefixForCounty` (anchored `^<prefix>_` match), so a
 *    county's permits across multiple source systems (e.g. `lee_accela`, `lee_appraiser`)
 *    are all counted, exactly like the permit-table export.
 *  - sunbiz / bbb share a single fixed `source_system` (`sunbiz`, `bbb`), but the harvest
 *    county is embedded in `source_artifact_uri` (e.g. `.../sunbiz-miami-dade-corporate...`,
 *    `.../bbb/category-data/lee-county-permit-seeded/...`). Coverage is therefore attributed
 *    per county by parsing that county slug from the artifact URI and grouping by it, so a
 *    county only gets a sunbiz/bbb row when it actually has harvested rows (no fan-out of the
 *    statewide total, no zero rows). County derivation from the URI uses
 *    {@link countySlugFromArtifactUri} (TS) / {@link globalSourceCountyExpr} (SQL), which are
 *    kept in lockstep.
 */

/** The dataset sources this module knows how to count from Neon. */
export type CoverageSource = "appraisal" | "permits" | "sunbiz" | "bbb";

/** All countable sources, in a stable order. */
export const COVERAGE_SOURCES: readonly CoverageSource[] = [
  "appraisal",
  "permits",
  "sunbiz",
  "bbb",
] as const;

/**
 * Sources whose per-county attribution is derived from `<county>_appraiser` /
 * permit source-system prefixes (i.e. keyed directly on `source_system`).
 */
export const COUNTY_KEYED_SOURCES: readonly CoverageSource[] = [
  "appraisal",
  "permits",
] as const;

/**
 * Sources ingested under one fixed statewide `source_system`, whose per-county
 * attribution must be parsed out of `source_artifact_uri` instead.
 */
export type GlobalCoverageSource = "sunbiz" | "bbb";

/** Global (artifact-URI-derived) sources, in a stable order. */
export const GLOBAL_COVERAGE_SOURCES: readonly GlobalCoverageSource[] = [
  "sunbiz",
  "bbb",
] as const;

/**
 * Type guard: is this a global source whose county comes from `source_artifact_uri`?
 *
 * @param source - Any coverage source.
 * @returns True for `sunbiz`/`bbb`.
 */
export function isGlobalCoverageSource(
  source: CoverageSource,
): source is GlobalCoverageSource {
  return source === "sunbiz" || source === "bbb";
}

/** Physical table + county-derivation config for each global source. */
type GlobalSourceConfig = {
  /** Table holding the harvested rows. */
  readonly table: string;
  /**
   * SQL expression (over a row of `table`) that yields the lowercase county slug
   * parsed from `source_artifact_uri`, or NULL when it cannot be parsed. Must stay
   * in lockstep with {@link countySlugFromArtifactUri}.
   */
  readonly countyExpr: string;
};

/**
 * SQL fragment deriving the county slug from a sunbiz artifact URI, e.g.
 * `.../sunbiz-miami-dade-corporate-quarterly-2026q2/...` -> `miami-dade`.
 */
const SUNBIZ_COUNTY_SQL_EXPR =
  "lower(substring(source_artifact_uri from 'sunbiz-(.+?)-corporate'))";

/**
 * SQL fragment deriving the county slug from a bbb artifact URI, e.g.
 * `.../bbb/category-data/lee-county-permit-seeded/...` -> `lee`,
 * `.../bbb/category-data/miami-dade-county/...` -> `miami-dade`.
 */
const BBB_COUNTY_SQL_EXPR =
  "lower(regexp_replace(substring(source_artifact_uri from 'category-data/([^/]+)'), '-county.*$', ''))";

/** Per-global-source physical table + county-derivation SQL. */
const GLOBAL_SOURCE_CONFIG: Record<GlobalCoverageSource, GlobalSourceConfig> = {
  sunbiz: {
    table: "business_registrations",
    countyExpr: SUNBIZ_COUNTY_SQL_EXPR,
  },
  bbb: {
    table: "business_reputation_profiles",
    countyExpr: BBB_COUNTY_SQL_EXPR,
  },
};

/**
 * Expose the SQL county-derivation expression for a global source (documentation /
 * reuse). Mirrors {@link countySlugFromArtifactUri}.
 *
 * @param source - Global source (`sunbiz` or `bbb`).
 * @returns SQL expression over the source table yielding the lowercase county slug.
 */
export function globalSourceCountyExpr(source: GlobalCoverageSource): string {
  return GLOBAL_SOURCE_CONFIG[source].countyExpr;
}

/**
 * Parse the harvest county slug from a global source's `source_artifact_uri`. This is
 * the TypeScript twin of {@link globalSourceCountyExpr} and MUST stay in lockstep with it.
 *
 * Supported shapes:
 *  - sunbiz: `.../sunbiz-<county>-corporate-quarterly-...` (e.g. `miami-dade`, `palm-beach`, `lee`).
 *  - bbb:    `.../bbb/category-data/<county>-county[-permit-seeded]/...` (e.g. `lee`, `miami-dade`).
 *
 * @param source - Global source (`sunbiz` or `bbb`).
 * @param artifactUri - The `source_artifact_uri` value for a harvested row.
 * @returns Lowercase hyphen county slug, or `null` when it cannot be parsed.
 */
export function countySlugFromArtifactUri(
  source: GlobalCoverageSource,
  artifactUri: string,
): string | null {
  if (typeof artifactUri !== "string" || artifactUri.length === 0) return null;
  if (source === "sunbiz") {
    const match = /sunbiz-(.+?)-corporate/i.exec(artifactUri);
    const slug = match?.[1]?.toLowerCase().trim();
    return slug && slug.length > 0 ? slug : null;
  }
  const match = /category-data\/([^/]+)/i.exec(artifactUri);
  const segment = match?.[1]?.toLowerCase().trim();
  if (!segment) return null;
  const slug = segment.replace(/-county.*$/, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Minimal Postgres query surface used by this module. A `pg` `Pool` or `Client`
 * satisfies it structurally, and unit tests can pass a lightweight mock.
 */
export type CoverageQueryClient = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Row[] }>;
};

/** A parameterized SQL statement: query text plus its positional bind values. */
export type CoverageSqlStatement = {
  readonly text: string;
  readonly values: readonly unknown[];
};

/** Raw single-column count row returned by the count queries (bigint arrives as text). */
type CountRow = { readonly ingested_count: string | number | null };

/** Raw MIN/MAX load-timestamp row (timestamps cast to text in SQL). */
type LoadTimestampRow = {
  readonly first_loaded_at: string | null;
  readonly last_loaded_at: string | null;
};

/** Derived load-time bounds for a (county, source) dataset. */
export type CoverageLoadTimestamps = {
  readonly firstLoadedAt: string | null;
  readonly lastLoadedAt: string | null;
};

/** Fully computed coverage figures for one (county, source) pair. */
export type CoverageComputation = {
  readonly county: string;
  readonly source: CoverageSource;
  readonly ingestedCount: number;
  readonly firstLoadedAt: string | null;
  readonly lastLoadedAt: string | null;
};

/**
 * Invert `appraisalSourceForCounty`: turn a loader jurisdiction key / appraisal
 * source system back into the hyphen county slug used by the publish path and the
 * coverage table (e.g. `palm_beach_appraiser` -> `palm-beach`, `lee_appraiser` -> `lee`).
 *
 * @param jurisdictionKey - Loader jurisdiction key / appraisal `source_system`.
 * @returns Hyphen county slug.
 */
export function countySlugFromJurisdictionKey(jurisdictionKey: string): string {
  const trimmed = jurisdictionKey.trim().toLowerCase();
  const withoutSuffix = trimmed.endsWith("_appraiser")
    ? trimmed.slice(0, -"_appraiser".length)
    : trimmed;
  return withoutSuffix.replace(/_+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build the count SQL for a (county, source). The count for each source is defined
 * to match the corresponding publish artifact:
 *  - appraisal -> query-table row count (DISTINCT folio),
 *  - permits   -> permit-table row count (anchored source prefix),
 *  - sunbiz    -> `business_registrations` rows whose artifact-URI county == `county`,
 *  - bbb       -> `business_reputation_profiles` rows whose artifact-URI county == `county`.
 *
 * @param county - Hyphen county slug.
 * @param source - Dataset source to count.
 * @returns Parameterized count statement yielding a single `ingested_count` column.
 */
export function buildCoverageCountSql(
  county: string,
  source: CoverageSource,
): CoverageSqlStatement {
  switch (source) {
    case "appraisal":
      return {
        text: `
          SELECT count(*)::text AS ingested_count
          FROM (
            SELECT DISTINCT COALESCE(
              NULLIF(p.request_identifier, ''),
              NULLIF(par.request_identifier, ''),
              p.parcel_identifier
            ) AS folio
            FROM properties p
            LEFT JOIN parcels par ON par.parcel_id = p.parcel_id
            WHERE p.source_system = $1
          ) folios
        `,
        values: [appraisalSourceForCounty(county)],
      };
    case "permits":
      return {
        text: `
          SELECT count(*)::text AS ingested_count
          FROM property_improvements
          WHERE source_system ~ ('^' || $1 || '_')
        `,
        values: [permitSourcePrefixForCounty(county)],
      };
    case "sunbiz":
    case "bbb": {
      const config = GLOBAL_SOURCE_CONFIG[source];
      return {
        text: `
          SELECT count(*)::text AS ingested_count
          FROM ${config.table}
          WHERE ${config.countyExpr} = $1
        `,
        values: [county],
      };
    }
  }
}

/**
 * Build the MIN/MAX `loaded_at` SQL for a (county, source), used to derive
 * `first_loaded_at` / `last_loaded_at`. Scope matches {@link buildCoverageCountSql}.
 *
 * @param county - Hyphen county slug.
 * @param source - Dataset source to bound.
 * @returns Parameterized statement yielding `first_loaded_at` and `last_loaded_at` text.
 */
export function buildCoverageTimestampSql(
  county: string,
  source: CoverageSource,
): CoverageSqlStatement {
  switch (source) {
    case "appraisal":
      return {
        text: `
          SELECT min(loaded_at)::text AS first_loaded_at,
                 max(loaded_at)::text AS last_loaded_at
          FROM properties
          WHERE source_system = $1
        `,
        values: [appraisalSourceForCounty(county)],
      };
    case "permits":
      return {
        text: `
          SELECT min(loaded_at)::text AS first_loaded_at,
                 max(loaded_at)::text AS last_loaded_at
          FROM property_improvements
          WHERE source_system ~ ('^' || $1 || '_')
        `,
        values: [permitSourcePrefixForCounty(county)],
      };
    case "sunbiz":
    case "bbb": {
      const config = GLOBAL_SOURCE_CONFIG[source];
      return {
        text: `
          SELECT min(loaded_at)::text AS first_loaded_at,
                 max(loaded_at)::text AS last_loaded_at
          FROM ${config.table}
          WHERE ${config.countyExpr} = $1
        `,
        values: [county],
      };
    }
  }
}

/**
 * The idempotent upsert. Recomputed `ingested_count` and `last_loaded_at` always win;
 * `first_loaded_at` keeps the earliest known value; `expected_count`, `cid`, and
 * `ipns_label` are intentionally preserved (owned by other steps).
 */
export const COVERAGE_UPSERT_SQL = `
  INSERT INTO ${ORACLE_DATASET_COVERAGE_TABLE}
    (county, source, ingested_count, first_loaded_at, last_loaded_at)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (county, source) DO UPDATE SET
    ingested_count = EXCLUDED.ingested_count,
    first_loaded_at = COALESCE(${ORACLE_DATASET_COVERAGE_TABLE}.first_loaded_at, EXCLUDED.first_loaded_at),
    last_loaded_at = COALESCE(EXCLUDED.last_loaded_at, ${ORACLE_DATASET_COVERAGE_TABLE}.last_loaded_at)
`;

/**
 * Build the positional bind values for {@link COVERAGE_UPSERT_SQL} from a computation.
 *
 * @param computation - Fully computed coverage figures.
 * @returns Bind values `[county, source, ingestedCount, firstLoadedAt, lastLoadedAt]`.
 */
export function buildCoverageUpsertValues(
  computation: CoverageComputation,
): readonly unknown[] {
  return [
    computation.county,
    computation.source,
    computation.ingestedCount,
    computation.firstLoadedAt,
    computation.lastLoadedAt,
  ];
}

/**
 * Coerce a bigint/text/number count scalar into a finite non-negative integer.
 *
 * @param value - Raw `ingested_count` scalar from Postgres.
 * @returns Parsed integer, or 0 when absent/unparseable.
 */
function parseCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

/**
 * Count ingested rows for a (county, source) from Neon.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param county - Hyphen county slug.
 * @param source - Dataset source to count.
 * @returns Non-negative ingested row count.
 */
export async function computeIngestedCount(
  client: CoverageQueryClient,
  county: string,
  source: CoverageSource,
): Promise<number> {
  const statement = buildCoverageCountSql(county, source);
  const result = await client.query<CountRow>(statement.text, statement.values);
  return parseCount(result.rows[0]?.ingested_count);
}

/**
 * Derive first/last load timestamps for a (county, source) from Neon.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param county - Hyphen county slug.
 * @param source - Dataset source to bound.
 * @returns First/last `loaded_at` (ISO text) or nulls when the dataset is empty.
 */
export async function computeLoadTimestamps(
  client: CoverageQueryClient,
  county: string,
  source: CoverageSource,
): Promise<CoverageLoadTimestamps> {
  const statement = buildCoverageTimestampSql(county, source);
  const result = await client.query<LoadTimestampRow>(statement.text, statement.values);
  const row = result.rows[0];
  return {
    firstLoadedAt: row?.first_loaded_at ?? null,
    lastLoadedAt: row?.last_loaded_at ?? null,
  };
}

/**
 * Compute the full coverage figures (count + timestamps) for a (county, source).
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param county - Hyphen county slug.
 * @param source - Dataset source to compute.
 * @returns Fully computed coverage figures ready to upsert.
 */
export async function computeCoverage(
  client: CoverageQueryClient,
  county: string,
  source: CoverageSource,
): Promise<CoverageComputation> {
  const [ingestedCount, timestamps] = await Promise.all([
    computeIngestedCount(client, county, source),
    computeLoadTimestamps(client, county, source),
  ]);
  return {
    county,
    source,
    ingestedCount,
    firstLoadedAt: timestamps.firstLoadedAt,
    lastLoadedAt: timestamps.lastLoadedAt,
  };
}

/**
 * Upsert a single coverage computation into `oracle_dataset_coverage`.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param computation - Fully computed coverage figures.
 * @returns Promise that resolves once the row has been written.
 */
export async function upsertCoverageRow(
  client: CoverageQueryClient,
  computation: CoverageComputation,
): Promise<void> {
  await client.query(COVERAGE_UPSERT_SQL, buildCoverageUpsertValues(computation));
}

/**
 * Compute and upsert coverage for a (county, source) in one call — the shared entry
 * used by both the backfill and the per-cycle loader hook.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param county - Hyphen county slug.
 * @param source - Dataset source to refresh.
 * @returns The coverage figures that were written.
 */
export async function refreshCoverage(
  client: CoverageQueryClient,
  county: string,
  source: CoverageSource,
): Promise<CoverageComputation> {
  const computation = await computeCoverage(client, county, source);
  await upsertCoverageRow(client, computation);
  return computation;
}

/** Raw grouped row returned by {@link buildGlobalSourceCoverageByCountySql}. */
type GlobalCoverageGroupRow = {
  readonly county: string | null;
  readonly ingested_count: string | number | null;
  readonly first_loaded_at: string | null;
  readonly last_loaded_at: string | null;
};

/**
 * Build the single-scan GROUP BY that partitions a global source (`sunbiz`/`bbb`) into
 * per-county counts and load-time bounds, keyed on the county parsed from
 * `source_artifact_uri`. Rows whose county cannot be parsed are excluded, and only
 * counties that actually have rows appear (no zero rows, no statewide fan-out).
 *
 * @param source - Global source (`sunbiz` or `bbb`).
 * @returns Parameterless statement yielding `county`, `ingested_count`,
 *   `first_loaded_at`, `last_loaded_at` per county.
 */
export function buildGlobalSourceCoverageByCountySql(
  source: GlobalCoverageSource,
): CoverageSqlStatement {
  const config = GLOBAL_SOURCE_CONFIG[source];
  return {
    text: `
      SELECT ${config.countyExpr} AS county,
             count(*)::text AS ingested_count,
             min(loaded_at)::text AS first_loaded_at,
             max(loaded_at)::text AS last_loaded_at
      FROM ${config.table}
      WHERE ${config.countyExpr} IS NOT NULL
        AND ${config.countyExpr} <> ''
      GROUP BY ${config.countyExpr}
      ORDER BY 1
    `,
    values: [],
  };
}

/**
 * Compute per-county coverage for a global source in a single scan. Returns one
 * computation per county that actually has harvested rows (count > 0).
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param source - Global source (`sunbiz` or `bbb`).
 * @returns Per-county coverage computations, ordered by county.
 */
export async function computeGlobalSourceCoverageByCounty(
  client: CoverageQueryClient,
  source: GlobalCoverageSource,
): Promise<readonly CoverageComputation[]> {
  const statement = buildGlobalSourceCoverageByCountySql(source);
  const result = await client.query<GlobalCoverageGroupRow>(
    statement.text,
    statement.values,
  );
  const computations: CoverageComputation[] = [];
  for (const row of result.rows) {
    const county = typeof row.county === "string" ? row.county.trim() : "";
    if (county.length === 0) continue;
    const ingestedCount = parseCount(row.ingested_count);
    if (ingestedCount <= 0) continue;
    computations.push({
      county,
      source,
      ingestedCount,
      firstLoadedAt: row.first_loaded_at ?? null,
      lastLoadedAt: row.last_loaded_at ?? null,
    });
  }
  return computations;
}

/**
 * Delete `oracle_dataset_coverage` rows for a source whose county is NOT in the given
 * keep-set. Used to purge stale rows (e.g. the previous fanned-out sunbiz/bbb rows for
 * counties that no longer qualify). An empty keep-set deletes every row for the source.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param source - Source whose rows should be pruned.
 * @param keepCounties - County slugs to retain for this source.
 * @returns Promise that resolves once stale rows have been removed.
 */
export async function deleteCoverageRowsForSourceExcept(
  client: CoverageQueryClient,
  source: CoverageSource,
  keepCounties: readonly string[],
): Promise<void> {
  await client.query(
    `DELETE FROM ${ORACLE_DATASET_COVERAGE_TABLE}
     WHERE source = $1 AND county <> ALL($2::text[])`,
    [source, [...keepCounties]],
  );
}

/**
 * Refresh coverage for all counties of a global source: compute per-county counts in
 * one scan, upsert each, and prune stale rows for counties that no longer qualify.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param source - Global source (`sunbiz` or `bbb`).
 * @returns The per-county coverage computations that were written.
 */
export async function refreshGlobalSourceCoverage(
  client: CoverageQueryClient,
  source: GlobalCoverageSource,
): Promise<readonly CoverageComputation[]> {
  const computations = await computeGlobalSourceCoverageByCounty(client, source);
  await deleteCoverageRowsForSourceExcept(
    client,
    source,
    computations.map((computation) => computation.county),
  );
  for (const computation of computations) {
    await upsertCoverageRow(client, computation);
  }
  return computations;
}

/**
 * Read back the persisted coverage rows for a county (used by the backfill to report
 * results). Returns the same column shape as the publish snapshot reader.
 *
 * @param client - Query client (pg Pool/Client or mock).
 * @param county - Hyphen county slug.
 * @returns Coverage rows for the county ordered by source.
 */
export async function readCoverageRowsForCounty(
  client: CoverageQueryClient,
  county: string,
): Promise<readonly OracleDatasetCoverageRow[]> {
  const result = await client.query<OracleDatasetCoverageRow>(
    `SELECT county, source, ingested_count, expected_count,
            first_loaded_at::text AS first_loaded_at,
            last_loaded_at::text AS last_loaded_at,
            cid, ipns_label
     FROM ${ORACLE_DATASET_COVERAGE_TABLE}
     WHERE county = $1
     ORDER BY source`,
    [county],
  );
  return result.rows;
}
