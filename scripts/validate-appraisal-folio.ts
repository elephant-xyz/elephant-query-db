/**
 * Validate the appraisal re-load BY FOLIO (request_identifier) — the only correct key.
 *
 * The original corruption came from deduping parcels on the digits-only normalized
 * `parcel_identifier`, which collapsed genuinely-distinct letter-STRAP folios. Validation
 * therefore counts DISTINCT `request_identifier` (the folio, 1:1 with the raw STRAP) and
 * NEVER the normalized `parcel_identifier`.
 *
 * Asserts:
 *   1a. EXACT (preferred): distinct folios == EXPECTED_PARCELS — the count of DISTINCT folios
 *       present in the S3 source (NOT raw artifact count; S3 has dup <uuid> folders per folio).
 *       This is the spec-level "complete vs source" check, not a threshold.
 *   1b. FLOOR (fallback when EXPECTED_PARCELS unset): distinct folios >= EXPECTED_MIN_PARCELS.
 *   2. total parcel rows == distinct folios (no collapse, no duplicate folios).
 *   3. zero orphaned appraisal properties (parcel_id IS NULL) — the collapse symptom.
 *   4. letter-STRAP parcels present (post-fix the raw STRAP is stored; a near-zero count would
 *      mean the digits-only normalization regressed).
 * Exits non-zero on any failure so the Fargate task / Step Functions run fails loudly.
 */
import { Client } from "pg";

const SOURCE_SYSTEM = "lee_appraiser";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const expectedMin = Number(process.env.EXPECTED_MIN_PARCELS ?? "510000");
  const expectedExactRaw = process.env.EXPECTED_PARCELS;
  const expectedExact = expectedExactRaw !== undefined && expectedExactRaw.trim() !== ""
    ? Number(expectedExactRaw)
    : null;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT
        (SELECT count(*) FROM parcels) AS total_parcels,
        (SELECT count(DISTINCT request_identifier) FROM parcels) AS distinct_folios,
        (SELECT count(*) FROM parcels WHERE parcel_identifier ~ '[A-Za-z]') AS letter_straps,
        (SELECT count(*) FROM properties WHERE source_system = $1 AND parcel_id IS NULL) AS orphaned_properties
    `, [SOURCE_SYSTEM]);

    const r = rows[0];
    const totalParcels = Number(r.total_parcels);
    const distinctFolios = Number(r.distinct_folios);
    const letterStraps = Number(r.letter_straps);
    const orphanedProperties = Number(r.orphaned_properties);

    const failures: string[] = [];
    if (expectedExact !== null) {
      // Spec-level exact reconciliation vs source.
      if (distinctFolios !== expectedExact) {
        failures.push(`distinct_folios ${distinctFolios} != source_distinct_folios ${expectedExact} (incomplete vs source)`);
      }
    } else if (distinctFolios < expectedMin) {
      failures.push(`distinct_folios ${distinctFolios} < expected_min ${expectedMin}`);
    }
    if (totalParcels !== distinctFolios) {
      failures.push(`total_parcels ${totalParcels} != distinct_folios ${distinctFolios} (duplicate/collapsed folios)`);
    }
    if (orphanedProperties > 0) {
      failures.push(`orphaned_properties ${orphanedProperties} > 0 (collapse symptom)`);
    }
    if (letterStraps === 0 && distinctFolios > 0) {
      failures.push(`letter_straps 0 (raw STRAP not stored — digits-only normalization regressed?)`);
    }

    console.log(JSON.stringify({
      event: "validate_appraisal_folio",
      totalParcels,
      distinctFolios,
      letterStraps,
      orphanedProperties,
      expectedExact,
      expectedMin: expectedExact === null ? expectedMin : undefined,
      passed: failures.length === 0,
      failures,
    }));

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "validate_failed", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
