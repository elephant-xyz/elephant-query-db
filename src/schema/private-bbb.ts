import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { properties } from "./appraisal.js";
import { companies } from "./core.js";
import { propertyImprovements } from "./permits.js";
import {
  createdAtColumn,
  jsonObjectColumn,
  nullableJsonObjectColumn,
  updatedAtColumn,
} from "./shared.js";

const emptyTextArray = sql`ARRAY[]::text[]`;

/**
 * Private BBB harvest coverage. These rows are internal reconciliation state;
 * they are not Lexicon or Atlas publication records.
 */
export const bbbHarvestRuns = pgTable(
  "bbb_harvest_runs",
  {
    bbbHarvestRunId: uuid("bbb_harvest_run_id").primaryKey().defaultRandom(),
    countyKey: text("county_key").notNull(),
    runId: text("run_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    source: text("source").notNull(),
    bundleSha256: text("bundle_sha256").notNull(),
    reconciliationManifestSha256: text(
      "reconciliation_manifest_sha256",
    ).notNull(),
    profilesSha256: text("profiles_sha256"),
    sourceAccessStatus: text("source_access_status").notNull(),
    sourceAccessComplete: boolean("source_access_complete").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    categoryCount: integer("category_count").notNull().default(0),
    rawProfileCount: integer("raw_profile_count").notNull().default(0),
    uniqueProfileCount: integer("unique_profile_count").notNull().default(0),
    duplicateProfileCount: integer("duplicate_profile_count")
      .notNull()
      .default(0),
    permanentFailureCount: integer("permanent_failure_count")
      .notNull()
      .default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    sourceArtifactUri: text("source_artifact_uri"),
    sourceProvenance: jsonObjectColumn("source_provenance"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_harvest_runs_county_run_idx").on(
      table.countyKey,
      table.runId,
    ),
    uniqueIndex("bbb_harvest_runs_current_county_idx")
      .on(table.countyKey)
      .where(sql`${table.isCurrent} = true`),
    index("bbb_harvest_runs_status_idx").on(
      table.countyKey,
      table.sourceAccessStatus,
      table.finishedAt,
    ),
    check(
      "bbb_harvest_runs_nonnegative_counts_check",
      sql`${table.categoryCount} >= 0
        AND ${table.rawProfileCount} >= 0
        AND ${table.uniqueProfileCount} >= 0
        AND ${table.duplicateProfileCount} >= 0
        AND ${table.permanentFailureCount} >= 0`,
    ),
    check(
      "bbb_harvest_runs_access_status_check",
      sql`${table.sourceAccessStatus} IN ('accessible', 'blocked', 'incomplete')`,
    ),
  ],
);

export const bbbHarvestCategories = pgTable(
  "bbb_harvest_categories",
  {
    bbbHarvestCategoryId: uuid("bbb_harvest_category_id")
      .primaryKey()
      .defaultRandom(),
    bbbHarvestRunId: uuid("bbb_harvest_run_id")
      .notNull()
      .references(() => bbbHarvestRuns.bbbHarvestRunId, {
        onDelete: "restrict",
      }),
    categoryKey: text("category_key").notNull(),
    categoryUrl: text("category_url").notNull(),
    jobId: text("job_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    requestSha256: text("request_sha256").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    manifestArtifactUri: text("manifest_artifact_uri"),
    sourceAccessStatus: text("source_access_status").notNull(),
    completeWithinBounds: boolean("complete_within_bounds").notNull(),
    advertisedResults: integer("advertised_results"),
    categoryPagesVisited: integer("category_pages_visited")
      .notNull()
      .default(0),
    profilesSelected: integer("profiles_selected").notNull().default(0),
    profilesHarvested: integer("profiles_harvested").notNull().default(0),
    profilesFailedPermanent: integer("profiles_failed_permanent")
      .notNull()
      .default(0),
    sourceAccessEvidence: nullableJsonObjectColumn("source_access_evidence"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_harvest_categories_run_category_idx").on(
      table.bbbHarvestRunId,
      table.categoryKey,
    ),
    index("bbb_harvest_categories_status_idx").on(
      table.sourceAccessStatus,
      table.completeWithinBounds,
    ),
    check(
      "bbb_harvest_categories_nonnegative_counts_check",
      sql`${table.categoryPagesVisited} >= 0
        AND ${table.profilesSelected} >= 0
        AND ${table.profilesHarvested} >= 0
        AND ${table.profilesFailedPermanent} >= 0`,
    ),
    check(
      "bbb_harvest_categories_access_status_check",
      sql`${table.sourceAccessStatus} IN (
        'accessible',
        'blocked',
        'not_attempted_after_source_block',
        'incomplete'
      )`,
    ),
  ],
);

/**
 * Mutable current pointer for a content-addressed profile part. Old profile
 * snapshots and memberships remain immutable when this pointer advances.
 */
export const bbbArtifactWatermarks = pgTable(
  "bbb_artifact_watermarks",
  {
    bbbArtifactWatermarkId: uuid("bbb_artifact_watermark_id")
      .primaryKey()
      .defaultRandom(),
    bbbHarvestCategoryId: uuid("bbb_harvest_category_id")
      .notNull()
      .references(() => bbbHarvestCategories.bbbHarvestCategoryId, {
        onDelete: "restrict",
      }),
    relativePath: text("relative_path").notNull(),
    artifactUri: text("artifact_uri"),
    artifactSha256: text("artifact_sha256").notNull(),
    previousArtifactSha256: text("previous_artifact_sha256"),
    artifactBytes: integer("artifact_bytes").notNull(),
    recordCount: integer("record_count").notNull(),
    mergedCount: integer("merged_count").notNull(),
    tombstoneCount: integer("tombstone_count").notNull().default(0),
    isCurrent: boolean("is_current").notNull().default(true),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retirementReason: text("retirement_reason"),
    lastMergedAt: timestamp("last_merged_at", { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_artifact_watermarks_category_path_idx").on(
      table.bbbHarvestCategoryId,
      table.relativePath,
    ),
    index("bbb_artifact_watermarks_hash_idx").on(table.artifactSha256),
    index("bbb_artifact_watermarks_current_idx").on(
      table.bbbHarvestCategoryId,
      table.isCurrent,
    ),
    check(
      "bbb_artifact_watermarks_nonnegative_counts_check",
      sql`${table.artifactBytes} >= 0
        AND ${table.recordCount} >= 0
        AND ${table.mergedCount} >= 0
        AND ${table.tombstoneCount} >= 0`,
    ),
    check(
      "bbb_artifact_watermarks_retirement_check",
      sql`(${table.isCurrent} = true
          AND ${table.retiredAt} IS NULL
          AND ${table.retirementReason} IS NULL)
        OR
        (${table.isCurrent} = false
          AND ${table.retiredAt} IS NOT NULL
          AND ${table.retirementReason} = 'removed_from_corrected_manifest')`,
    ),
  ],
);

/**
 * Immutable, sanitized BBB profile snapshot. `snapshot_sha256` hashes the
 * complete source record, but raw page evidence and HTML are never stored.
 */
export const bbbProfileSnapshots = pgTable(
  "bbb_profile_snapshots",
  {
    bbbProfileSnapshotId: uuid("bbb_profile_snapshot_id")
      .primaryKey()
      .defaultRandom(),
    provider: text("provider").notNull().default("BBB"),
    providerProfileKey: text("provider_profile_key").notNull(),
    providerBusinessKey: text("provider_business_key").notNull(),
    providerProfileId: text("provider_profile_id"),
    providerBusinessId: text("provider_business_id"),
    providerBbbId: text("provider_bbb_id"),
    profileUrl: text("profile_url").notNull(),
    name: text("name"),
    legalName: text("legal_name"),
    normalizedNames: text("normalized_names")
      .array()
      .notNull()
      .default(emptyTextArray),
    normalizedPhones: text("normalized_phones")
      .array()
      .notNull()
      .default(emptyTextArray),
    licenseIdentifiers: text("license_identifiers")
      .array()
      .notNull()
      .default(emptyTextArray),
    isAccredited: boolean("is_accredited"),
    bbbRating: text("bbb_rating"),
    reviewCount: integer("review_count"),
    complaintCount: integer("complaint_count"),
    sourceRetrievedAt: timestamp("source_retrieved_at", { withTimezone: true }),
    snapshotAsOf: timestamp("snapshot_as_of", { withTimezone: true }).notNull(),
    extractionSchemaVersion: text("extraction_schema_version").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    extractedPayload: jsonObjectColumn("extracted_payload"),
    firstArtifactUri: text("first_artifact_uri"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_profile_snapshots_identity_hash_idx").on(
      table.provider,
      table.providerProfileKey,
      table.snapshotSha256,
    ),
    index("bbb_profile_snapshots_business_idx").on(
      table.provider,
      table.providerBusinessKey,
    ),
    index("bbb_profile_snapshots_profile_url_idx").on(table.profileUrl),
    index("bbb_profile_snapshots_names_gin").using(
      "gin",
      table.normalizedNames,
    ),
    index("bbb_profile_snapshots_phones_gin").using(
      "gin",
      table.normalizedPhones,
    ),
    index("bbb_profile_snapshots_licenses_gin").using(
      "gin",
      table.licenseIdentifiers,
    ),
    check(
      "bbb_profile_snapshots_count_check",
      sql`(${table.reviewCount} IS NULL OR ${table.reviewCount} >= 0)
        AND (${table.complaintCount} IS NULL OR ${table.complaintCount} >= 0)`,
    ),
  ],
);

/**
 * Content-revision membership. Corrected artifacts retire prior memberships
 * with an explicit tombstone reason; profile snapshots themselves are never
 * updated or deleted.
 */
export const bbbProfileCategoryMemberships = pgTable(
  "bbb_profile_category_memberships",
  {
    bbbProfileCategoryMembershipId: uuid("bbb_profile_category_membership_id")
      .primaryKey()
      .defaultRandom(),
    bbbHarvestCategoryId: uuid("bbb_harvest_category_id")
      .notNull()
      .references(() => bbbHarvestCategories.bbbHarvestCategoryId, {
        onDelete: "restrict",
      }),
    bbbArtifactWatermarkId: uuid("bbb_artifact_watermark_id")
      .notNull()
      .references(() => bbbArtifactWatermarks.bbbArtifactWatermarkId, {
        onDelete: "restrict",
      }),
    bbbProfileSnapshotId: uuid("bbb_profile_snapshot_id")
      .notNull()
      .references(() => bbbProfileSnapshots.bbbProfileSnapshotId, {
        onDelete: "restrict",
      }),
    profileSourceKey: text("profile_source_key").notNull(),
    artifactRelativePath: text("artifact_relative_path").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retirementReason: text("retirement_reason"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_profile_memberships_revision_profile_idx").on(
      table.bbbHarvestCategoryId,
      table.artifactRelativePath,
      table.artifactSha256,
      table.profileSourceKey,
    ),
    uniqueIndex("bbb_profile_memberships_current_profile_idx")
      .on(
        table.bbbHarvestCategoryId,
        table.artifactRelativePath,
        table.profileSourceKey,
      )
      .where(sql`${table.isCurrent} = true`),
    index("bbb_profile_memberships_snapshot_idx").on(
      table.bbbProfileSnapshotId,
    ),
    index("bbb_profile_memberships_current_idx").on(
      table.bbbHarvestCategoryId,
      table.isCurrent,
    ),
    check(
      "bbb_profile_memberships_retirement_check",
      sql`(${table.isCurrent} = true
          AND ${table.retiredAt} IS NULL
          AND ${table.retirementReason} IS NULL)
        OR
        (${table.isCurrent} = false
          AND ${table.retiredAt} IS NOT NULL
          AND ${table.retirementReason} IN (
            'missing_from_corrected_artifact',
            'superseded_by_corrected_snapshot',
            'superseded_by_corrected_artifact'
          ))`,
    ),
  ],
);

export const bbbReconciliationRuns = pgTable(
  "bbb_reconciliation_runs",
  {
    bbbReconciliationRunId: uuid("bbb_reconciliation_run_id")
      .primaryKey()
      .defaultRandom(),
    bbbHarvestRunId: uuid("bbb_harvest_run_id")
      .notNull()
      .references(() => bbbHarvestRuns.bbbHarvestRunId, {
        onDelete: "restrict",
      }),
    reconciliationKey: text("reconciliation_key").notNull(),
    policyVersion: text("policy_version").notNull(),
    officialEvidenceSha256: text("official_evidence_sha256").notNull(),
    officialEvidenceArtifactUri: text("official_evidence_artifact_uri"),
    status: text("status").notNull(),
    sourceCoverageComplete: boolean("source_coverage_complete").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    officialIdentityCount: integer("official_identity_count")
      .notNull()
      .default(0),
    officialCompanyCount: integer("official_company_count")
      .notNull()
      .default(0),
    acceptedMatchCount: integer("accepted_match_count").notNull().default(0),
    reviewCandidateCount: integer("review_candidate_count")
      .notNull()
      .default(0),
    ambiguousCandidateCount: integer("ambiguous_candidate_count")
      .notNull()
      .default(0),
    unmatchedCount: integer("unmatched_count").notNull().default(0),
    acceptedPropertyLinkCount: integer("accepted_property_link_count")
      .notNull()
      .default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_reconciliation_runs_key_idx").on(
      table.bbbHarvestRunId,
      table.reconciliationKey,
    ),
    uniqueIndex("bbb_reconciliation_runs_current_idx")
      .on(table.bbbHarvestRunId)
      .where(sql`${table.isCurrent} = true`),
    index("bbb_reconciliation_runs_status_idx").on(
      table.status,
      table.finishedAt,
    ),
    check(
      "bbb_reconciliation_runs_status_check",
      sql`${table.status} IN ('completed', 'incomplete_source')`,
    ),
    check(
      "bbb_reconciliation_runs_nonnegative_counts_check",
      sql`${table.officialIdentityCount} >= 0
        AND ${table.officialCompanyCount} >= 0
        AND ${table.acceptedMatchCount} >= 0
        AND ${table.reviewCandidateCount} >= 0
        AND ${table.ambiguousCandidateCount} >= 0
        AND ${table.unmatchedCount} >= 0
        AND ${table.acceptedPropertyLinkCount} >= 0`,
    ),
  ],
);

/**
 * Match outcomes are reputation reconciliation only. They never update
 * `companies`, `permit_contacts.company_id`, or
 * `property_improvements.contractor_company_id`.
 */
export const bbbReconciliationMatches = pgTable(
  "bbb_reconciliation_matches",
  {
    bbbReconciliationMatchId: uuid("bbb_reconciliation_match_id")
      .primaryKey()
      .defaultRandom(),
    bbbReconciliationRunId: uuid("bbb_reconciliation_run_id")
      .notNull()
      .references(() => bbbReconciliationRuns.bbbReconciliationRunId, {
        onDelete: "restrict",
      }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.companyId, { onDelete: "restrict" }),
    representativeProfileSnapshotId: uuid(
      "representative_profile_snapshot_id",
    ).references(() => bbbProfileSnapshots.bbbProfileSnapshotId, {
      onDelete: "restrict",
    }),
    officialIdentityKey: text("official_identity_key").notNull(),
    providerBusinessKey: text("provider_business_key"),
    candidateKey: text("candidate_key").notNull(),
    outcome: text("outcome").notNull(),
    matchMethod: text("match_method"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    officialName: text("official_name"),
    officialNormalizedName: text("official_normalized_name"),
    officialLicenseIdentifiers: text("official_license_identifiers")
      .array()
      .notNull()
      .default(emptyTextArray),
    officialPhoneIdentifiers: text("official_phone_identifiers")
      .array()
      .notNull()
      .default(emptyTextArray),
    evidenceSha256: text("evidence_sha256").notNull(),
    evidencePayload: jsonObjectColumn("evidence_payload"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_reconciliation_matches_candidate_idx").on(
      table.bbbReconciliationRunId,
      table.officialIdentityKey,
      table.candidateKey,
    ),
    index("bbb_reconciliation_matches_company_outcome_idx").on(
      table.companyId,
      table.outcome,
    ),
    index("bbb_reconciliation_matches_profile_idx").on(
      table.representativeProfileSnapshotId,
    ),
    index("bbb_reconciliation_matches_business_idx").on(
      table.providerBusinessKey,
    ),
    check(
      "bbb_reconciliation_matches_outcome_check",
      sql`${table.outcome} IN ('accepted', 'review', 'ambiguous', 'unmatched')`,
    ),
    check(
      "bbb_reconciliation_matches_accepted_tier_check",
      sql`${table.outcome} <> 'accepted'
        OR (
          ${table.representativeProfileSnapshotId} IS NOT NULL
          AND ${table.providerBusinessKey} IS NOT NULL
          AND ${table.matchMethod} IN (
            'exact_state_license',
            'exact_standardized_phone',
            'unique_exact_normalized_business_name'
          )
        )`,
    ),
    check(
      "bbb_reconciliation_matches_fuzzy_review_only_check",
      sql`${table.matchMethod} <> 'jaro_winkler_cleaned_business_name'
        OR ${table.outcome} IN ('review', 'ambiguous')`,
    ),
    check(
      "bbb_reconciliation_matches_unmatched_check",
      sql`${table.outcome} <> 'unmatched'
        OR (
          ${table.representativeProfileSnapshotId} IS NULL
          AND ${table.providerBusinessKey} IS NULL
          AND ${table.matchMethod} IS NULL
        )`,
    ),
    check(
      "bbb_reconciliation_matches_confidence_check",
      sql`${table.confidence} IS NULL
        OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  ],
);

/**
 * Accepted property evidence is always anchored to an existing official
 * company-linked permit and its existing property. No direct BBB address to
 * property relationship is representable here.
 */
export const bbbPropertyLinkEvidence = pgTable(
  "bbb_property_link_evidence",
  {
    bbbPropertyLinkEvidenceId: uuid("bbb_property_link_evidence_id")
      .primaryKey()
      .defaultRandom(),
    bbbReconciliationMatchId: uuid("bbb_reconciliation_match_id")
      .notNull()
      .references(() => bbbReconciliationMatches.bbbReconciliationMatchId, {
        onDelete: "restrict",
      }),
    propertyImprovementId: uuid("property_improvement_id")
      .notNull()
      .references(() => propertyImprovements.propertyImprovementId, {
        onDelete: "restrict",
      }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.propertyId, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.companyId, { onDelete: "restrict" }),
    permitSourceSystem: text("permit_source_system").notNull(),
    permitSourceRecordKey: text("permit_source_record_key").notNull(),
    officialEvidenceKey: text("official_evidence_key").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    snapshotAsOf: timestamp("snapshot_as_of", { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("bbb_property_link_evidence_match_permit_idx").on(
      table.bbbReconciliationMatchId,
      table.propertyImprovementId,
      table.propertyId,
    ),
    index("bbb_property_link_evidence_property_idx").on(table.propertyId),
    index("bbb_property_link_evidence_permit_idx").on(
      table.propertyImprovementId,
    ),
    index("bbb_property_link_evidence_company_idx").on(table.companyId),
    index("bbb_property_link_evidence_source_key_idx").on(
      table.permitSourceSystem,
      table.permitSourceRecordKey,
    ),
  ],
);
