/**
 * Hardcoded "honestly incomplete" coverage tracks for the publication dry-run.
 *
 * Copy Santa Clara (`expected_count: null`), not the older 100%-by-construction
 * rows. `corporate` is the published-snapshot spelling of Neon `sunbiz` — a
 * pre-existing mismatch. Places uses one spelling, `overture_places`, in Neon
 * and in the published snapshot.
 *
 * The full publication dry-run script is not on `main` yet. When it lands, this
 * list must be the loop it iterates. Keep in sync with
 * `PUBLIC_COVERAGE_ENRICHMENT_TRACKS` in `write-public-coverage-snapshot.ts`.
 */

import { PUBLIC_COVERAGE_ENRICHMENT_TRACKS } from "./write-public-coverage-snapshot.js";

export const PUBLICATION_HONESTLY_INCOMPLETE_TRACKS = PUBLIC_COVERAGE_ENRICHMENT_TRACKS;

export type CoverageTrackRow = {
  readonly ingested_count?: unknown;
  readonly expected_count?: unknown;
};

/**
 * Assert that each non-appraisal coverage track is present at zero with a null
 * expected count ("not ingested" rather than "complete at zero").
 *
 * @param coverageRows - Snapshot rows keyed by source spelling.
 * @returns Void when every track is honestly incomplete.
 */
export function assertHonestlyIncompleteCoverageTracks(
  coverageRows: ReadonlyMap<string, CoverageTrackRow>,
): void {
  for (const track of PUBLICATION_HONESTLY_INCOMPLETE_TRACKS) {
    const row = coverageRows.get(track);
    if (row?.ingested_count !== 0 || row.expected_count !== null) {
      throw new Error(`Coverage track ${track} is not honestly incomplete`);
    }
  }
}
