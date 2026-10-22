import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import {
  compactObject,
  hashString,
  isJsonObject,
  readBoolean,
  readInteger,
  readString,
  readTimestamp,
  stableJsonStringify,
} from "./normalizers.js";
import type { JsonObject } from "./types.js";

const BUNDLE_SCHEMA_VERSION = "elephant.bbb-private-persistence-bundle.v1";
const OFFICIAL_EVIDENCE_SCHEMA_VERSION =
  "elephant.bbb-official-permit-company-evidence.v1";
const OFFICIAL_EVIDENCE_SCHEMA_VERSION_V2 =
  "elephant.bbb-official-permit-company-evidence.v2";
const ADAPTER_RECEIPT_SCHEMA_VERSION =
  "elephant.bbb-private-bundle-adapter-receipt.v1";
const HARVEST_SCHEMA_VERSION = "elephant.bbb-category-harvest.v1";
const RECONCILIATION_SCHEMA_VERSION = "elephant.bbb-reconciliation.v1";
const MATCH_POLICY_VERSION = "bbb-private-exact-cascade-v1";
const BBB_PROVIDER = "BBB";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;
const LICENSE_IN_TEXT_PATTERN =
  /\blicen[cs]e(?:\s+number)?(?:\s+of)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,30})/giu;
const LEGAL_SUFFIXES = new Set([
  "CO",
  "COMPANY",
  "CORP",
  "CORPORATION",
  "INC",
  "INCORPORATED",
  "LLC",
  "LLP",
  "LP",
  "LTD",
  "LIMITED",
  "PA",
  "PC",
  "PLLC",
]);
const LOOSE_TRADE_WORDS = new Set([
  "AIR",
  "CONTRACTING",
  "CONTRACTOR",
  "CONTRACTORS",
  "ELECTRIC",
  "ELECTRICAL",
  "HEATING",
  "ROOFING",
  "SERVICE",
  "SERVICES",
]);

const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\0"),
    "path must be relative and remain inside the bundle",
  );
const sha256Schema = z.string().regex(SHA256_PATTERN);
const countyKeySchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const timestampSchema = z.string().datetime({ offset: true });

const privateBbbBundleSchema = z
  .object({
    schemaVersion: z.literal(BUNDLE_SCHEMA_VERSION),
    countyKey: countyKeySchema,
    runId: z
      .string()
      .min(8)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9-]*$/u),
    reconciliationManifest: relativePathSchema,
    categories: z
      .array(
        z
          .object({
            categoryKey: countyKeySchema,
            harvestDirectory: relativePathSchema,
          })
          .strict(),
      )
      .min(1),
    officialPermitCompanyEvidence: relativePathSchema,
    oracleAdapterReceipt: z
      .object({
        relativePath: relativePathSchema,
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const keys = bundle.categories.map((category) => category.categoryKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "category keys must be unique",
      });
    }
  });

const contractorEvidenceSchema = z
  .object({
    name: z.string().min(1).max(500).nullable().optional(),
    legalName: z.string().min(1).max(500).nullable().optional(),
    alternateNames: z.array(z.string().min(1).max(500)).default([]),
    phones: z.array(z.string().min(1).max(100)).default([]),
    licenseIdentifiers: z.array(z.string().min(1).max(100)).default([]),
  })
  .strict();

const officialEvidenceSchemaV1 = z
  .object({
    schemaVersion: z.literal(OFFICIAL_EVIDENCE_SCHEMA_VERSION),
    evidenceKey: z.string().min(1).max(300).regex(SAFE_KEY_PATTERN),
    permit: z
      .object({
        sourceSystem: z.string().min(1).max(100).regex(SAFE_KEY_PATTERN),
        sourceRecordKey: z.string().min(1).max(500),
      })
      .strict(),
    company: z
      .object({
        sourceSystem: z.string().min(1).max(100).regex(SAFE_KEY_PATTERN),
        sourceRecordKey: z.string().min(1).max(500),
      })
      .strict(),
    contractor: contractorEvidenceSchema,
    asOf: timestampSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const hasName =
      evidence.contractor.name !== undefined &&
      evidence.contractor.name !== null;
    const hasLegalName =
      evidence.contractor.legalName !== undefined &&
      evidence.contractor.legalName !== null;
    if (
      !hasName &&
      !hasLegalName &&
      evidence.contractor.alternateNames.length === 0 &&
      evidence.contractor.phones.length === 0 &&
      evidence.contractor.licenseIdentifiers.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["contractor"],
        message: "official contractor evidence needs an identity signal",
      });
    }
  });

const officialEvidenceSchemaV2 = z
  .object({
    schemaVersion: z.literal(OFFICIAL_EVIDENCE_SCHEMA_VERSION_V2),
    evidenceKey: z.string().min(1).max(300).regex(SAFE_KEY_PATTERN),
    permit: z
      .object({
        propertyImprovementId: z.string().uuid(),
        propertyId: z.string().uuid(),
      })
      .strict(),
    company: z
      .object({
        requestIdentifier: z.string().min(1).max(500),
      })
      .strict(),
    contractor: contractorEvidenceSchema,
    expectedMatch: z
      .object({
        providerBusinessKey: z.string().min(1).max(500),
        providerProfileKeys: z.array(z.string().min(1).max(500)).min(1),
        method: z.enum([
          "exact_state_license",
          "exact_standardized_phone",
          "unique_exact_normalized_business_name",
        ]),
        confidence: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    asOf: timestampSchema,
    sourceEvidenceSha256: sha256Schema,
  })
  .strict();

const officialEvidenceSchema = z.discriminatedUnion("schemaVersion", [
  officialEvidenceSchemaV1,
  officialEvidenceSchemaV2,
]);

const partReceiptSchema = z
  .object({
    relativePath: relativePathSchema,
    recordCount: z.number().int().positive(),
    bytes: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

const categorySummarySchema = z
  .object({
    schemaVersion: z.literal(HARVEST_SCHEMA_VERSION),
    jobId: z.string().min(1),
    county: countyKeySchema,
    source: z.string().min(1).optional(),
    categoryKey: countyKeySchema,
    categoryUrl: z.string().url(),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    advertisedResults: z.number().int().nonnegative().nullable().optional(),
    categoryPagesVisited: z.number().int().nonnegative(),
    profileUrlsDiscovered: z.number().int().nonnegative(),
    profilesSelected: z.number().int().nonnegative(),
    profilesHarvested: z.number().int().nonnegative(),
    profilesFailedPermanent: z.number().int().nonnegative(),
    requestSha256: sha256Schema,
    completeWithinBounds: z.boolean(),
    sourceAccessStatus: z
      .enum([
        "accessible",
        "blocked",
        "not_attempted_after_source_block",
        "incomplete",
      ])
      .optional(),
    sourceAccessEvidence: z.unknown().optional(),
    profileParts: z.array(partReceiptSchema),
    failurePart: partReceiptSchema.nullable().optional(),
  })
  .passthrough();

const reconciliationManifestSchema = z
  .object({
    schemaVersion: z.literal(RECONCILIATION_SCHEMA_VERSION),
    county: countyKeySchema,
    reconciledAt: timestampSchema,
    categoryCount: z.number().int().nonnegative(),
    categories: z.array(
      z
        .object({
          categoryKey: countyKeySchema,
          profilesSelected: z.number().int().nonnegative(),
          profilesHarvested: z.number().int().nonnegative(),
          profilesFailedPermanent: z.number().int().nonnegative(),
          requestSha256: sha256Schema.nullable().optional(),
          sourceAccessStatus: z.string().optional(),
        })
        .passthrough(),
    ),
    rawProfileCount: z.number().int().nonnegative(),
    uniqueProfileCount: z.number().int().nonnegative(),
    duplicateProfileCount: z.number().int().nonnegative(),
    sourceAccessStatus: z.enum(["accessible", "blocked", "incomplete"]),
    sourceAccessComplete: z.boolean(),
    profilesBytes: z.number().int().nonnegative(),
    profilesSha256: sha256Schema,
    permanentFailureCount: z.number().int().nonnegative(),
  })
  .passthrough();

const adapterReceiptSchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_RECEIPT_SCHEMA_VERSION),
    countyKey: countyKeySchema,
    runId: z.string().min(8).max(160),
    sourceManifestSha256: sha256Schema,
    reconciliationManifestSha256: sha256Schema,
    profilesSha256: sha256Schema,
    permitCoverageSha256: sha256Schema,
    permitCompanyEvidenceSha256: sha256Schema,
    acceptedLinksSha256: sha256Schema,
    officialEvidenceSha256: sha256Schema,
    permitWatermarkDigest: sha256Schema,
    sourceAccessComplete: z.literal(true),
    profileCount: z.number().int().positive(),
    officialIdentityCount: z.number().int().positive(),
    officialCompanyCount: z.number().int().positive(),
    categories: z.array(
      z
        .object({
          categoryKey: countyKeySchema,
          summarySha256: sha256Schema,
          profileCount: z.number().int().positive(),
        })
        .strict(),
    ),
    acceptedPropertyLinkCount: z.number().int().positive(),
    reviewCandidateCount: z.literal(0),
    fuzzyAcceptedCount: z.literal(0),
    matchMethodCounts: z
      .object({
        exact_state_license: z.number().int().nonnegative(),
        exact_standardized_phone: z.number().int().nonnegative(),
        unique_exact_normalized_business_name: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

type PrivateBbbBundle = z.infer<typeof privateBbbBundleSchema>;
type OfficialEvidence = z.infer<typeof officialEvidenceSchema>;
type AdapterReceipt = z.infer<typeof adapterReceiptSchema>;
type CategorySummary = z.infer<typeof categorySummarySchema>;
type PartReceipt = z.infer<typeof partReceiptSchema>;

type PreparedProfileSnapshot = {
  readonly providerProfileKey: string;
  readonly providerBusinessKey: string;
  readonly providerProfileId: string | null;
  readonly providerBusinessId: string | null;
  readonly providerBbbId: string | null;
  readonly profileUrl: string;
  readonly name: string | null;
  readonly legalName: string | null;
  readonly normalizedNames: readonly string[];
  readonly normalizedPhones: readonly string[];
  readonly licenseIdentifiers: readonly string[];
  readonly isAccredited: boolean | null;
  readonly bbbRating: string | null;
  readonly reviewCount: number | null;
  readonly complaintCount: number | null;
  readonly sourceRetrievedAt: string | null;
  readonly snapshotAsOf: string;
  readonly extractionSchemaVersion: string;
  readonly snapshotSha256: string;
  readonly extractedPayload: JsonObject;
};

type PreparedPartProfile = {
  readonly rawLine: string;
  readonly snapshot: PreparedProfileSnapshot;
};

type PreparedPart = {
  readonly receipt: PartReceipt;
  readonly artifactUri: string;
  readonly profiles: readonly PreparedPartProfile[];
};

type PreparedCategory = {
  readonly summary: CategorySummary;
  readonly summarySha256: string;
  readonly summaryArtifactUri: string;
  readonly sourceAccessStatus:
    | "accessible"
    | "blocked"
    | "not_attempted_after_source_block"
    | "incomplete";
  readonly sourceAccessEvidence: JsonObject | null;
  readonly parts: readonly PreparedPart[];
};

type PreparedBundle = {
  readonly bundle: PrivateBbbBundle;
  readonly bundlePath: string;
  readonly bundleSha256: string;
  readonly reconciliationManifestSha256: string;
  readonly reconciliation: z.infer<typeof reconciliationManifestSchema>;
  readonly categories: readonly PreparedCategory[];
  readonly officialEvidence: readonly OfficialEvidence[];
  readonly officialEvidenceSha256: string;
  readonly adapterReceipt: AdapterReceipt | null;
  readonly sourceAccessStatus: "accessible" | "blocked" | "incomplete";
  readonly sourceAccessComplete: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly snapshots: readonly PreparedProfileSnapshot[];
};

type ResolvedEvidence = {
  readonly evidence: OfficialEvidence;
  readonly evidenceSha256: string;
  readonly companyId: string;
  readonly companyName: string | null;
  readonly propertyImprovementId: string;
  readonly propertyId: string;
  readonly permitSourceSystem: string;
  readonly permitSourceRecordKey: string;
  readonly companySourceSystem: string;
  readonly companySourceRecordKey: string;
};

type OfficialCompanyIdentity = {
  readonly companyId: string;
  readonly officialIdentityKey: string;
  readonly evidence: readonly ResolvedEvidence[];
  readonly names: readonly string[];
  readonly normalizedNames: readonly string[];
  readonly looseNames: readonly string[];
  readonly phones: readonly string[];
  readonly licenses: readonly string[];
};

type BbbBusinessIdentity = {
  readonly providerBusinessKey: string;
  readonly snapshots: readonly PreparedProfileSnapshot[];
  readonly normalizedNames: readonly string[];
  readonly looseNames: readonly string[];
  readonly phones: readonly string[];
  readonly licenses: readonly string[];
};

type MatchPlan = {
  readonly company: OfficialCompanyIdentity;
  readonly business: BbbBusinessIdentity | null;
  readonly candidateKey: string;
  readonly outcome: "accepted" | "review" | "ambiguous" | "unmatched";
  readonly matchMethod:
    | "exact_state_license"
    | "exact_standardized_phone"
    | "unique_exact_normalized_business_name"
    | "jaro_winkler_cleaned_business_name"
    | null;
  readonly confidence: number | null;
  readonly evidencePayload: JsonObject;
};

type StoredSnapshot = {
  readonly prepared: PreparedProfileSnapshot;
  readonly id: string;
};

type LoadCounters = {
  changedRows: number;
  unchangedArtifacts: number;
  insertedSnapshots: number;
  insertedMemberships: number;
  retiredMemberships: number;
};

export type PrivateBbbLoadResult = {
  readonly countyKey: string;
  readonly runId: string;
  readonly bundleSha256: string;
  readonly officialEvidenceSha256: string;
  readonly sourceAccessStatus: "accessible" | "blocked" | "incomplete";
  readonly sourceAccessComplete: boolean;
  readonly profileCount: number;
  readonly changedRows: number;
  readonly unchangedArtifacts: number;
  readonly insertedSnapshots: number;
  readonly insertedMemberships: number;
  readonly retiredMemberships: number;
  readonly acceptedMatchCount: number;
  readonly reviewCandidateCount: number;
  readonly ambiguousCandidateCount: number;
  readonly unmatchedCount: number;
  readonly acceptedPropertyLinkCount: number;
  readonly replayed: boolean;
};

export type PrivateBbbPlanResult = {
  readonly mode: "plan";
  readonly countyKey: string;
  readonly runId: string;
  readonly bundleSha256: string;
  readonly officialEvidenceSha256: string;
  readonly sourceAccessStatus: "accessible" | "blocked" | "incomplete";
  readonly sourceAccessComplete: boolean;
  readonly profileCount: number;
  readonly acceptedMatchCount: number;
  readonly reviewCandidateCount: number;
  readonly ambiguousCandidateCount: number;
  readonly unmatchedCount: number;
  readonly acceptedPropertyLinkCount: number;
  readonly ready: true;
};

interface IdRow extends QueryResultRow {
  readonly id: string;
}

interface ExistingLoadRow extends QueryResultRow {
  readonly bbb_harvest_run_id: string;
  readonly source_access_status: "accessible" | "blocked" | "incomplete";
  readonly source_access_complete: boolean;
  readonly unique_profile_count: number;
  readonly accepted_match_count: number;
  readonly review_candidate_count: number;
  readonly ambiguous_candidate_count: number;
  readonly unmatched_count: number;
  readonly accepted_property_link_count: number;
}

interface ExistingWatermarkRow extends QueryResultRow {
  readonly id: string;
  readonly artifact_sha256: string;
  readonly is_current: boolean;
}

interface ExistingMembershipRow extends QueryResultRow {
  readonly id: string;
  readonly profile_source_key: string;
  readonly snapshot_sha256: string;
}

interface ResolvedEvidenceRow extends QueryResultRow {
  readonly company_id: string;
  readonly company_name: string | null;
  readonly company_source_system: string;
  readonly company_source_record_key: string;
  readonly property_improvement_id: string;
  readonly property_id: string | null;
  readonly permit_source_system: string;
  readonly permit_source_record_key: string;
  readonly officially_linked: boolean;
}

interface ReconciliationRunRow extends QueryResultRow {
  readonly id: string;
  readonly is_current: boolean;
}

/**
 * Resolve all private evidence and predict the exact-tier outcome inside a
 * read-only transaction. This performs no schema or row mutation.
 */
export async function planPrivateBbbBundle(params: {
  readonly pool: Pool;
  readonly bundlePath: string;
}): Promise<PrivateBbbPlanResult> {
  const prepared = await preparePrivateBbbBundle(params.bundlePath);
  const client = await params.pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const resolvedEvidence = await resolveOfficialEvidence(
      client,
      prepared.officialEvidence,
    );
    const companies = buildOfficialCompanyIdentities(resolvedEvidence);
    const businesses = buildBbbBusinessIdentities(prepared.snapshots);
    const matchPlans = prepared.sourceAccessComplete
      ? buildPrivateBbbMatchPlan(companies, businesses)
      : buildIncompleteSourceMatchPlan(companies);
    assertAdapterMatchExpectations(prepared, matchPlans);
    await client.query("COMMIT");
    return {
      mode: "plan",
      countyKey: prepared.bundle.countyKey,
      runId: prepared.bundle.runId,
      bundleSha256: prepared.bundleSha256,
      officialEvidenceSha256: prepared.officialEvidenceSha256,
      sourceAccessStatus: prepared.sourceAccessStatus,
      sourceAccessComplete: prepared.sourceAccessComplete,
      profileCount: prepared.reconciliation.uniqueProfileCount,
      ...countMatchPlans(matchPlans),
      acceptedPropertyLinkCount: countAcceptedPropertyLinks(matchPlans),
      ready: true,
    };
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught;
  } finally {
    client.release();
  }
}

/**
 * Verify that the exact bundle and official-evidence digests are current.
 * The check runs in a read-only transaction and never attempts a load.
 */
export async function verifyPrivateBbbBundle(params: {
  readonly pool: Pool;
  readonly bundlePath: string;
}): Promise<PrivateBbbLoadResult> {
  const prepared = await preparePrivateBbbBundle(params.bundlePath);
  const client = await params.pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const existing = await findReplay(client, prepared);
    if (existing === null) {
      throw new Error(
        "The exact BBB bundle and official-evidence digest are not current",
      );
    }
    await client.query("COMMIT");
    return replayResult(prepared, existing);
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught;
  } finally {
    client.release();
  }
}

/**
 * Load one explicitly scoped BBB bundle into the private persistence tables.
 * The transaction takes a county-scoped advisory lock, validates every source
 * hash before writing, and never mutates legal identity or permit resolver
 * columns.
 */
export async function loadPrivateBbbBundle(params: {
  readonly pool: Pool;
  readonly bundlePath: string;
  readonly now?: string;
}): Promise<PrivateBbbLoadResult> {
  const prepared = await preparePrivateBbbBundle(params.bundlePath);
  const now = params.now ?? new Date().toISOString();
  if (readTimestamp(now) === null)
    throw new Error("now must be an ISO timestamp");

  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `bbb-private:${prepared.bundle.countyKey}`,
    ]);

    const existing = await findReplay(client, prepared);
    if (existing !== null) {
      await client.query("COMMIT");
      return replayResult(prepared, existing);
    }
    await assertExistingRunScope(client, prepared);

    const counters: LoadCounters = {
      changedRows: 0,
      unchangedArtifacts: 0,
      insertedSnapshots: 0,
      insertedMemberships: 0,
      retiredMemberships: 0,
    };
    const harvestRunId = await upsertHarvestRun(
      client,
      prepared,
      now,
      counters,
    );
    const storedSnapshots = new Map<string, StoredSnapshot>();

    for (const category of prepared.categories) {
      const categoryId = await upsertHarvestCategory(
        client,
        harvestRunId,
        prepared,
        category,
        counters,
      );
      await mergeCategoryParts({
        client,
        prepared,
        category,
        categoryId,
        now,
        storedSnapshots,
        counters,
      });
    }

    const resolvedEvidence = await resolveOfficialEvidence(
      client,
      prepared.officialEvidence,
    );
    const companies = buildOfficialCompanyIdentities(resolvedEvidence);
    const businesses = buildBbbBusinessIdentities(prepared.snapshots);
    const matchPlans = prepared.sourceAccessComplete
      ? buildPrivateBbbMatchPlan(companies, businesses)
      : buildIncompleteSourceMatchPlan(companies);
    assertAdapterMatchExpectations(prepared, matchPlans);
    const reconciliationKey = hashString(
      [
        prepared.bundleSha256,
        prepared.officialEvidenceSha256,
        MATCH_POLICY_VERSION,
      ].join(":"),
    );
    const acceptedPropertyLinkCount = countAcceptedPropertyLinks(matchPlans);
    const reconciliationRun = await activateReconciliationRun({
      client,
      harvestRunId,
      reconciliationKey,
      prepared,
      companies,
      matchPlans,
      acceptedPropertyLinkCount,
      now,
      counters,
    });

    if (!reconciliationRun.reused) {
      await persistMatchPlan({
        client,
        reconciliationRunId: reconciliationRun.id,
        matchPlans,
        storedSnapshots,
        now,
        counters,
      });
    }

    await client.query("COMMIT");
    const matchCounts = countMatchPlans(matchPlans);
    return {
      countyKey: prepared.bundle.countyKey,
      runId: prepared.bundle.runId,
      bundleSha256: prepared.bundleSha256,
      officialEvidenceSha256: prepared.officialEvidenceSha256,
      sourceAccessStatus: prepared.sourceAccessStatus,
      sourceAccessComplete: prepared.sourceAccessComplete,
      profileCount: prepared.reconciliation.uniqueProfileCount,
      changedRows: counters.changedRows,
      unchangedArtifacts: counters.unchangedArtifacts,
      insertedSnapshots: counters.insertedSnapshots,
      insertedMemberships: counters.insertedMemberships,
      retiredMemberships: counters.retiredMemberships,
      ...matchCounts,
      acceptedPropertyLinkCount,
      replayed: false,
    };
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught;
  } finally {
    client.release();
  }
}

async function assertExistingRunScope(
  client: PoolClient,
  prepared: PreparedBundle,
): Promise<void> {
  const existing = await client.query<
    { readonly category_key: string } & QueryResultRow
  >(
    `SELECT category."category_key"
     FROM "bbb_harvest_runs" harvest
     JOIN "bbb_harvest_categories" category
       ON category."bbb_harvest_run_id" = harvest."bbb_harvest_run_id"
     WHERE harvest."county_key" = $1 AND harvest."run_id" = $2
     ORDER BY category."category_key"`,
    [prepared.bundle.countyKey, prepared.bundle.runId],
  );
  if (existing.rows.length === 0) return;
  const existingKeys = existing.rows.map((row) => row.category_key);
  const incomingKeys = prepared.categories
    .map((category) => category.summary.categoryKey)
    .sort();
  if (stableJsonStringify(existingKeys) !== stableJsonStringify(incomingKeys)) {
    throw new Error(
      "BBB category scope cannot change within a runId; use a new runId",
    );
  }
}

/**
 * Normalize a business name for strict automatic matching. Legal suffixes are
 * removed, but trade words such as ROOFING and SERVICES remain significant.
 */
export function normalizePrivateBbbBusinessName(
  value: unknown,
  options: { readonly loose?: boolean } = {},
): string | null {
  const text = readString(value);
  if (text === null) return null;
  const words = text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/&/gu, " AND ")
    .replace(/[^A-Z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1) ?? ""))
    words.pop();
  const normalized =
    options.loose === true
      ? words.filter((word) => !LOOSE_TRADE_WORDS.has(word))
      : words;
  return normalized.length === 0 ? null : normalized.join(" ");
}

export function normalizePrivateBbbPhone(value: unknown): string | null {
  const text = readString(value);
  if (text === null) return null;
  const digits = text.replace(/\D/gu, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

export function normalizePrivateBbbLicense(value: unknown): string | null {
  const text = readString(value);
  if (text === null) return null;
  const normalized = text.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return normalized.length >= 4 && /\d/u.test(normalized) ? normalized : null;
}

export function jaroWinklerSimilarity(
  leftValue: string,
  rightValue: string,
): number {
  if (leftValue === rightValue) return 1;
  if (leftValue.length === 0 || rightValue.length === 0) return 0;
  const matchDistance = Math.max(
    Math.floor(Math.max(leftValue.length, rightValue.length) / 2) - 1,
    0,
  );
  const leftMatches = Array<boolean>(leftValue.length).fill(false);
  const rightMatches = Array<boolean>(rightValue.length).fill(false);
  let matches = 0;
  for (let leftIndex = 0; leftIndex < leftValue.length; leftIndex += 1) {
    const start = Math.max(0, leftIndex - matchDistance);
    const end = Math.min(leftIndex + matchDistance + 1, rightValue.length);
    for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
      if (
        rightMatches[rightIndex] === true ||
        leftValue[leftIndex] !== rightValue[rightIndex]
      ) {
        continue;
      }
      leftMatches[leftIndex] = true;
      rightMatches[rightIndex] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  const matchedLeft = [...leftValue].filter((_, index) => leftMatches[index]);
  const matchedRight = [...rightValue].filter(
    (_, index) => rightMatches[index],
  );
  let transpositions = 0;
  for (let index = 0; index < matchedLeft.length; index += 1) {
    if (matchedLeft[index] !== matchedRight[index]) transpositions += 1;
  }
  const jaro =
    (matches / leftValue.length +
      matches / rightValue.length +
      (matches - transpositions / 2) / matches) /
    3;
  let prefixLength = 0;
  while (
    prefixLength < 4 &&
    prefixLength < leftValue.length &&
    prefixLength < rightValue.length &&
    leftValue[prefixLength] === rightValue[prefixLength]
  ) {
    prefixLength += 1;
  }
  return jaro + prefixLength * 0.1 * (1 - jaro);
}

async function preparePrivateBbbBundle(
  bundlePath: string,
): Promise<PreparedBundle> {
  const absoluteBundlePath = path.resolve(bundlePath);
  const bundleRoot = path.dirname(absoluteBundlePath);
  const bundleBody = await readFile(absoluteBundlePath, "utf8");
  const bundle = privateBbbBundleSchema.parse(
    parseJson(bundleBody, absoluteBundlePath),
  );
  const reconciliationPath = resolveInside(
    bundleRoot,
    bundle.reconciliationManifest,
  );
  const reconciliationBody = await readFile(reconciliationPath, "utf8");
  const reconciliation = reconciliationManifestSchema.parse(
    parseJson(reconciliationBody, reconciliationPath),
  );
  if (reconciliation.county !== bundle.countyKey) {
    throw new Error("BBB reconciliation county does not match bundle county");
  }

  const categories: PreparedCategory[] = [];
  const rawProfiles: PreparedPartProfile[] = [];
  const reconciledProfilesByKey = new Map<string, PreparedPartProfile>();
  let permanentFailureCount = 0;
  for (const categoryConfig of bundle.categories) {
    const harvestDirectory = resolveInside(
      bundleRoot,
      categoryConfig.harvestDirectory,
    );
    const summaryPath = path.join(harvestDirectory, "manifest", "summary.json");
    const summaryBody = await readFile(summaryPath, "utf8");
    const summary = categorySummarySchema.parse(
      parseJson(summaryBody, summaryPath),
    );
    if (
      summary.county !== bundle.countyKey ||
      summary.categoryKey !== categoryConfig.categoryKey
    ) {
      throw new Error(
        `BBB category summary scope mismatch: ${categoryConfig.categoryKey}`,
      );
    }
    validateBbbCategoryUrl(summary.categoryUrl);
    const sourceAccessStatus = summary.sourceAccessStatus ?? "accessible";
    const sourceAccessEvidence = sanitizeSourceAccessEvidence(
      summary.sourceAccessEvidence,
    );
    const parts: PreparedPart[] = [];
    let categoryProfileCount = 0;
    for (const receipt of summary.profileParts) {
      const verified = await readVerifiedProfilePart(
        harvestDirectory,
        receipt,
        summary.finishedAt,
      );
      parts.push({
        receipt,
        artifactUri: privateArtifactUri(
          bundle,
          categoryConfig.categoryKey,
          receipt.relativePath,
        ),
        profiles: verified,
      });
      categoryProfileCount += verified.length;
      for (const profile of verified) {
        rawProfiles.push(profile);
        if (!reconciledProfilesByKey.has(profile.snapshot.providerProfileKey)) {
          reconciledProfilesByKey.set(
            profile.snapshot.providerProfileKey,
            profile,
          );
        }
      }
    }
    if (categoryProfileCount !== summary.profilesHarvested) {
      throw new Error(
        `BBB profile count mismatch for ${summary.categoryKey}: ${categoryProfileCount} != ${summary.profilesHarvested}`,
      );
    }
    await verifyFailurePart(harvestDirectory, summary.failurePart, summary);
    permanentFailureCount += summary.profilesFailedPermanent;
    validateCategoryCompletion(
      summary,
      sourceAccessStatus,
      sourceAccessEvidence,
    );
    categories.push({
      summary,
      summarySha256: sha256(summaryBody),
      summaryArtifactUri: privateArtifactUri(
        bundle,
        categoryConfig.categoryKey,
        "manifest/summary.json",
      ),
      sourceAccessStatus,
      sourceAccessEvidence,
      parts,
    });
  }

  validateReconciliationCounts({
    bundle,
    reconciliation,
    categories,
    rawProfiles,
    reconciledProfilesByKey,
    permanentFailureCount,
  });
  const reconciledBody =
    [...reconciledProfilesByKey.values()]
      .map((profile) => profile.rawLine)
      .join("\n") + (reconciledProfilesByKey.size > 0 ? "\n" : "");
  if (
    Buffer.byteLength(reconciledBody) !== reconciliation.profilesBytes ||
    sha256(reconciledBody) !== reconciliation.profilesSha256
  ) {
    throw new Error(
      "BBB reconciled profile digest does not match category parts",
    );
  }

  const officialEvidencePath = resolveInside(
    bundleRoot,
    bundle.officialPermitCompanyEvidence,
  );
  const officialEvidenceBody = await readFile(officialEvidencePath, "utf8");
  const officialEvidence = parseOfficialEvidence(officialEvidenceBody);
  const officialEvidenceSha256 = sha256(officialEvidenceBody);
  let adapterReceipt: AdapterReceipt | null = null;
  if (bundle.oracleAdapterReceipt !== undefined) {
    const receiptPath = resolveInside(
      bundleRoot,
      bundle.oracleAdapterReceipt.relativePath,
    );
    const receiptBody = await readFile(receiptPath, "utf8");
    if (sha256(receiptBody) !== bundle.oracleAdapterReceipt.sha256) {
      throw new Error("BBB Oracle adapter receipt digest mismatch");
    }
    adapterReceipt = adapterReceiptSchema.parse(
      parseJson(receiptBody, receiptPath),
    );
    const receiptCategories = [...adapterReceipt.categories].sort(
      (left, right) => left.categoryKey.localeCompare(right.categoryKey),
    );
    const actualCategories = categories
      .map((category) => ({
        categoryKey: category.summary.categoryKey,
        summarySha256: category.summarySha256,
        profileCount: category.summary.profilesHarvested,
      }))
      .sort((left, right) => left.categoryKey.localeCompare(right.categoryKey));
    if (
      adapterReceipt.countyKey !== bundle.countyKey ||
      adapterReceipt.runId !== bundle.runId ||
      adapterReceipt.reconciliationManifestSha256 !==
        sha256(reconciliationBody) ||
      adapterReceipt.profilesSha256 !== reconciliation.profilesSha256 ||
      adapterReceipt.profileCount !== reconciliation.uniqueProfileCount ||
      adapterReceipt.officialIdentityCount !== officialEvidence.length ||
      adapterReceipt.officialEvidenceSha256 !== officialEvidenceSha256 ||
      stableJsonStringify(receiptCategories) !==
        stableJsonStringify(actualCategories)
    ) {
      throw new Error("BBB Oracle adapter receipt does not match the bundle");
    }
  }
  if (
    officialEvidence.some(
      (evidence) =>
        evidence.schemaVersion === OFFICIAL_EVIDENCE_SCHEMA_VERSION_V2,
    ) &&
    adapterReceipt === null
  ) {
    throw new Error(
      "BBB v2 official evidence requires an Oracle adapter receipt",
    );
  }
  const sourceAccessStatus = deriveSourceAccessStatus(categories);
  const sourceAccessComplete =
    sourceAccessStatus === "accessible" &&
    categories.every(
      (category) =>
        category.sourceAccessStatus === "accessible" &&
        category.summary.completeWithinBounds,
    );
  if (
    reconciliation.sourceAccessStatus !== sourceAccessStatus ||
    reconciliation.sourceAccessComplete !== sourceAccessComplete
  ) {
    throw new Error(
      "BBB reconciliation source-access state does not match summaries",
    );
  }
  const partDigests = categories.flatMap((category) =>
    category.parts.map(
      (part) =>
        `${category.summary.categoryKey}:${part.receipt.relativePath}:${part.receipt.sha256}`,
    ),
  );
  const reconciliationManifestSha256 = sha256(reconciliationBody);
  const bundleSha256 = hashString(
    stableJsonStringify({
      bundle: JSON.parse(bundleBody) as unknown,
      reconciliationManifestSha256,
      partDigests,
    }),
  );
  const snapshotsByIdentity = new Map<string, PreparedProfileSnapshot>();
  for (const profile of rawProfiles) {
    const key = snapshotIdentity(profile.snapshot);
    snapshotsByIdentity.set(key, profile.snapshot);
  }
  return {
    bundle,
    bundlePath: absoluteBundlePath,
    bundleSha256,
    reconciliationManifestSha256,
    reconciliation,
    categories,
    officialEvidence,
    officialEvidenceSha256,
    adapterReceipt,
    sourceAccessStatus,
    sourceAccessComplete,
    startedAt: minimumTimestamp(
      categories.map((category) => category.summary.startedAt),
    ),
    finishedAt: maximumTimestamp(
      categories.map((category) => category.summary.finishedAt),
    ),
    snapshots: [...snapshotsByIdentity.values()],
  };
}

async function readVerifiedProfilePart(
  harvestDirectory: string,
  receipt: PartReceipt,
  categoryFinishedAt: string,
): Promise<readonly PreparedPartProfile[]> {
  if (!receipt.relativePath.startsWith("profiles/")) {
    throw new Error(
      `BBB profile part is outside profiles/: ${receipt.relativePath}`,
    );
  }
  const partPath = resolveInside(harvestDirectory, receipt.relativePath);
  const body = await readFile(partPath, "utf8");
  verifyReceiptBody(receipt, body, "profile");
  const lines = nonemptyLines(body);
  const profiles: PreparedPartProfile[] = [];
  const profileHashesByKey = new Map<string, string>();
  for (const line of lines) {
    const record = parseJson(line, partPath);
    if (!isJsonObject(record)) {
      throw new Error(
        `BBB profile part contains a non-object: ${receipt.relativePath}`,
      );
    }
    const snapshot = prepareProfileSnapshot(record, line, categoryFinishedAt);
    const existingHash = profileHashesByKey.get(snapshot.providerProfileKey);
    if (
      existingHash !== undefined &&
      existingHash !== snapshot.snapshotSha256
    ) {
      throw new Error(
        `BBB profile part has conflicting duplicate identity: ${snapshot.providerProfileKey}`,
      );
    }
    if (existingHash === undefined) {
      profileHashesByKey.set(
        snapshot.providerProfileKey,
        snapshot.snapshotSha256,
      );
      profiles.push({ rawLine: line, snapshot });
    }
  }
  return profiles;
}

function prepareProfileSnapshot(
  record: JsonObject,
  rawLine: string,
  categoryFinishedAt: string,
): PreparedProfileSnapshot {
  const profileUrl = canonicalBbbProfileUrl(
    readFirstString(record, ["profileUrl", "profile_url", "url"]),
  );
  const providerProfileId = readFirstString(record, [
    "providerProfileId",
    "provider_profile_id",
    "id",
  ]);
  const providerBusinessId = readFirstString(record, [
    "providerBusinessId",
    "provider_business_id",
  ]);
  const providerBbbId = readFirstString(record, [
    "providerBbbId",
    "provider_bbb_id",
  ]);
  const providerProfileKey = providerProfileId ?? profileUrl;
  const providerBusinessKey =
    providerBbbId !== null && providerBusinessId !== null
      ? `${providerBbbId}:${providerBusinessId}`
      : (providerBusinessId ?? businessUrlKey(profileUrl));
  const name = readFirstString(record, [
    "name",
    "businessName",
    "business_name",
  ]);
  const legalName = readFirstString(record, ["legalName", "legal_name"]);
  const alternateNames = readNameEntries(
    record.alternateNames ?? record.alternate_names,
  );
  const normalizedNames = uniqueSorted(
    [name, legalName, ...alternateNames]
      .map((value) => normalizePrivateBbbBusinessName(value))
      .filter((value): value is string => value !== null),
  );
  const normalizedPhones = uniqueSorted(
    [
      readFirstString(record, ["phone", "phoneNumber", "phone_number"]),
      ...readStringEntries(record.phones),
    ]
      .map((value) => normalizePrivateBbbPhone(value))
      .filter((value): value is string => value !== null),
  );
  const licenseIdentifiers = extractProfileLicenses(record);
  const sourceRetrievedAt = readFirstTimestamp(record, [
    "sourceRetrievedAt",
    "source_retrieved_at",
    "retrievedAt",
  ]);
  const snapshotAsOf = sourceRetrievedAt ?? categoryFinishedAt;
  const summary = readObject(
    record.reviewsComplaintsSummary ?? record.reviews_complaints_summary,
  );
  const reviewCount =
    readInteger(summary.reviewsTotal) ??
    readInteger(summary.reviewCount) ??
    readInteger(record.reviewCount);
  const complaintCount =
    readInteger(summary.complaintsTotal) ??
    readInteger(summary.complaintCount) ??
    readInteger(record.complaintCount);
  const isAccredited =
    readBoolean(record.accredited) ?? readBoolean(record.isAccredited);
  const bbbRating = readFirstString(record, ["bbbRating", "bbb_rating"]);
  const extractionSchemaVersion =
    readFirstString(record, ["schemaVersion", "schema_version"]) ??
    HARVEST_SCHEMA_VERSION;
  const extractedPayload = compactObject({
    recordKind: readFirstString(record, ["recordKind", "record_kind"]),
    schemaVersion: extractionSchemaVersion,
    source: readString(record.source),
    providerProfileId,
    providerBusinessId,
    providerBbbId,
    profileUrl,
    name,
    legalName,
    normalizedNames,
    normalizedPhones,
    licenseIdentifiers,
    isAccredited,
    bbbRating,
    reviewCount,
    complaintCount,
    sourceRetrievedAt,
  });
  assertNoRawHtml(extractedPayload);
  return {
    providerProfileKey,
    providerBusinessKey,
    providerProfileId,
    providerBusinessId,
    providerBbbId,
    profileUrl,
    name,
    legalName,
    normalizedNames,
    normalizedPhones,
    licenseIdentifiers,
    isAccredited,
    bbbRating,
    reviewCount,
    complaintCount,
    sourceRetrievedAt,
    snapshotAsOf,
    extractionSchemaVersion,
    snapshotSha256: sha256(rawLine),
    extractedPayload,
  };
}

async function verifyFailurePart(
  harvestDirectory: string,
  receipt: PartReceipt | null | undefined,
  summary: CategorySummary,
): Promise<void> {
  if (summary.profilesFailedPermanent === 0) {
    if (receipt !== null && receipt !== undefined) {
      throw new Error(`Unexpected BBB failure part: ${summary.categoryKey}`);
    }
    return;
  }
  if (receipt === null || receipt === undefined) {
    throw new Error(`Missing BBB failure part: ${summary.categoryKey}`);
  }
  if (!receipt.relativePath.startsWith("failures/")) {
    throw new Error(
      `BBB failure part is outside failures/: ${receipt.relativePath}`,
    );
  }
  const body = await readFile(
    resolveInside(harvestDirectory, receipt.relativePath),
    "utf8",
  );
  verifyReceiptBody(receipt, body, "failure");
  if (receipt.recordCount !== summary.profilesFailedPermanent) {
    throw new Error(
      `BBB permanent-failure count mismatch: ${summary.categoryKey}`,
    );
  }
}

function verifyReceiptBody(
  receipt: PartReceipt,
  body: string,
  label: string,
): void {
  if (
    Buffer.byteLength(body) !== receipt.bytes ||
    sha256(body) !== receipt.sha256 ||
    nonemptyLines(body).length !== receipt.recordCount
  ) {
    throw new Error(
      `BBB ${label} part integrity failure: ${receipt.relativePath}`,
    );
  }
}

function validateCategoryCompletion(
  summary: CategorySummary,
  sourceAccessStatus: PreparedCategory["sourceAccessStatus"],
  sourceAccessEvidence: JsonObject | null,
): void {
  if (sourceAccessStatus === "accessible") {
    if (
      !summary.completeWithinBounds ||
      summary.profilesSelected !==
        summary.profilesHarvested + summary.profilesFailedPermanent
    ) {
      throw new Error(`Incomplete BBB category: ${summary.categoryKey}`);
    }
    return;
  }
  if (
    sourceAccessStatus === "blocked" ||
    sourceAccessStatus === "not_attempted_after_source_block"
  ) {
    if (
      summary.completeWithinBounds ||
      summary.profilesHarvested !== 0 ||
      summary.profileParts.length !== 0 ||
      sourceAccessEvidence === null ||
      sourceAccessEvidence.httpStatus !== 403 ||
      sourceAccessEvidence.classification !== "blocked"
    ) {
      throw new Error(`Invalid blocked BBB category: ${summary.categoryKey}`);
    }
  }
}

function validateReconciliationCounts(params: {
  readonly bundle: PrivateBbbBundle;
  readonly reconciliation: z.infer<typeof reconciliationManifestSchema>;
  readonly categories: readonly PreparedCategory[];
  readonly rawProfiles: readonly PreparedPartProfile[];
  readonly reconciledProfilesByKey: ReadonlyMap<string, PreparedPartProfile>;
  readonly permanentFailureCount: number;
}): void {
  const expectedKeys = params.bundle.categories
    .map((category) => category.categoryKey)
    .sort();
  const manifestKeys = params.reconciliation.categories
    .map((category) => category.categoryKey)
    .sort();
  if (
    params.reconciliation.categoryCount !== params.categories.length ||
    stableJsonStringify(expectedKeys) !== stableJsonStringify(manifestKeys) ||
    params.reconciliation.rawProfileCount !== params.rawProfiles.length ||
    params.reconciliation.uniqueProfileCount !==
      params.reconciledProfilesByKey.size ||
    params.reconciliation.duplicateProfileCount !==
      params.rawProfiles.length - params.reconciledProfilesByKey.size ||
    params.reconciliation.permanentFailureCount !== params.permanentFailureCount
  ) {
    throw new Error("BBB reconciliation counts do not match category parts");
  }
  for (const category of params.categories) {
    const reconciledCategory = params.reconciliation.categories.find(
      (entry) => entry.categoryKey === category.summary.categoryKey,
    );
    if (
      reconciledCategory === undefined ||
      reconciledCategory.profilesSelected !==
        category.summary.profilesSelected ||
      reconciledCategory.profilesHarvested !==
        category.summary.profilesHarvested ||
      reconciledCategory.profilesFailedPermanent !==
        category.summary.profilesFailedPermanent ||
      (reconciledCategory.requestSha256 !== undefined &&
        reconciledCategory.requestSha256 !== null &&
        reconciledCategory.requestSha256 !== category.summary.requestSha256)
    ) {
      throw new Error(
        `BBB reconciliation category mismatch: ${category.summary.categoryKey}`,
      );
    }
  }
}

function parseOfficialEvidence(body: string): readonly OfficialEvidence[] {
  const evidenceByKey = new Map<
    string,
    { readonly value: OfficialEvidence; readonly hash: string }
  >();
  for (const line of nonemptyLines(body)) {
    const parsed = officialEvidenceSchema.parse(
      parseJson(line, "official evidence"),
    );
    const hash = hashString(stableJsonStringify(parsed));
    const existing = evidenceByKey.get(parsed.evidenceKey);
    if (existing !== undefined && existing.hash !== hash) {
      throw new Error(
        `Conflicting duplicate official evidence key: ${parsed.evidenceKey}`,
      );
    }
    if (existing === undefined)
      evidenceByKey.set(parsed.evidenceKey, { value: parsed, hash });
  }
  return [...evidenceByKey.values()].map((entry) => entry.value);
}

async function findReplay(
  client: PoolClient,
  prepared: PreparedBundle,
): Promise<ExistingLoadRow | null> {
  const result = await client.query<ExistingLoadRow>(
    `SELECT
       harvest."bbb_harvest_run_id",
       harvest."source_access_status",
       harvest."source_access_complete",
       harvest."unique_profile_count",
       reconciliation."accepted_match_count",
       reconciliation."review_candidate_count",
       reconciliation."ambiguous_candidate_count",
       reconciliation."unmatched_count",
       reconciliation."accepted_property_link_count"
     FROM "bbb_harvest_runs" harvest
     JOIN "bbb_reconciliation_runs" reconciliation
       ON reconciliation."bbb_harvest_run_id" = harvest."bbb_harvest_run_id"
      AND reconciliation."is_current" = true
     WHERE harvest."county_key" = $1
       AND harvest."run_id" = $2
       AND harvest."bundle_sha256" = $3
       AND harvest."is_current" = true
       AND reconciliation."official_evidence_sha256" = $4
       AND reconciliation."policy_version" = $5
     LIMIT 1`,
    [
      prepared.bundle.countyKey,
      prepared.bundle.runId,
      prepared.bundleSha256,
      prepared.officialEvidenceSha256,
      MATCH_POLICY_VERSION,
    ],
  );
  return result.rows[0] ?? null;
}

function replayResult(
  prepared: PreparedBundle,
  existing: ExistingLoadRow,
): PrivateBbbLoadResult {
  return {
    countyKey: prepared.bundle.countyKey,
    runId: prepared.bundle.runId,
    bundleSha256: prepared.bundleSha256,
    officialEvidenceSha256: prepared.officialEvidenceSha256,
    sourceAccessStatus: existing.source_access_status,
    sourceAccessComplete: existing.source_access_complete,
    profileCount: Number(existing.unique_profile_count),
    changedRows: 0,
    unchangedArtifacts: prepared.categories.reduce(
      (count, category) => count + category.parts.length,
      0,
    ),
    insertedSnapshots: 0,
    insertedMemberships: 0,
    retiredMemberships: 0,
    acceptedMatchCount: Number(existing.accepted_match_count),
    reviewCandidateCount: Number(existing.review_candidate_count),
    ambiguousCandidateCount: Number(existing.ambiguous_candidate_count),
    unmatchedCount: Number(existing.unmatched_count),
    acceptedPropertyLinkCount: Number(existing.accepted_property_link_count),
    replayed: true,
  };
}

async function upsertHarvestRun(
  client: PoolClient,
  prepared: PreparedBundle,
  now: string,
  counters: LoadCounters,
): Promise<string> {
  const retired = await client.query(
    `UPDATE "bbb_harvest_runs"
     SET "is_current" = false, "updated_at" = $3
     WHERE "county_key" = $1
       AND "run_id" <> $2
       AND "is_current" = true`,
    [prepared.bundle.countyKey, prepared.bundle.runId, now],
  );
  counters.changedRows += retired.rowCount ?? 0;
  const provenance = {
    privacy: "private",
    publicSchemaChanged: false,
    categoryReceipts: prepared.categories.map((category) => ({
      categoryKey: category.summary.categoryKey,
      summarySha256: category.summarySha256,
      profileParts: category.parts.map((part) => ({
        relativePath: part.receipt.relativePath,
        records: part.receipt.recordCount,
        bytes: part.receipt.bytes,
        sha256: part.receipt.sha256,
      })),
    })),
  };
  const result = await client.query<IdRow>(
    `INSERT INTO "bbb_harvest_runs" (
       "county_key", "run_id", "schema_version", "source", "bundle_sha256",
       "reconciliation_manifest_sha256", "profiles_sha256",
       "source_access_status", "source_access_complete", "is_current",
       "category_count", "raw_profile_count", "unique_profile_count",
       "duplicate_profile_count", "permanent_failure_count", "started_at",
       "finished_at", "reconciled_at", "source_artifact_uri",
       "source_provenance", "updated_at"
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19::jsonb, $20
     )
     ON CONFLICT ("county_key", "run_id") DO UPDATE SET
       "schema_version" = EXCLUDED."schema_version",
       "source" = EXCLUDED."source",
       "bundle_sha256" = EXCLUDED."bundle_sha256",
       "reconciliation_manifest_sha256" = EXCLUDED."reconciliation_manifest_sha256",
       "profiles_sha256" = EXCLUDED."profiles_sha256",
       "source_access_status" = EXCLUDED."source_access_status",
       "source_access_complete" = EXCLUDED."source_access_complete",
       "is_current" = true,
       "category_count" = EXCLUDED."category_count",
       "raw_profile_count" = EXCLUDED."raw_profile_count",
       "unique_profile_count" = EXCLUDED."unique_profile_count",
       "duplicate_profile_count" = EXCLUDED."duplicate_profile_count",
       "permanent_failure_count" = EXCLUDED."permanent_failure_count",
       "started_at" = EXCLUDED."started_at",
       "finished_at" = EXCLUDED."finished_at",
       "reconciled_at" = EXCLUDED."reconciled_at",
       "source_artifact_uri" = EXCLUDED."source_artifact_uri",
       "source_provenance" = EXCLUDED."source_provenance",
       "updated_at" = EXCLUDED."updated_at"
     WHERE "bbb_harvest_runs"."bundle_sha256" IS DISTINCT FROM EXCLUDED."bundle_sha256"
        OR "bbb_harvest_runs"."is_current" IS DISTINCT FROM true
     RETURNING "bbb_harvest_run_id" AS "id"`,
    [
      prepared.bundle.countyKey,
      prepared.bundle.runId,
      HARVEST_SCHEMA_VERSION,
      "bbb-public-browser",
      prepared.bundleSha256,
      prepared.reconciliationManifestSha256,
      prepared.reconciliation.profilesSha256,
      prepared.sourceAccessStatus,
      prepared.sourceAccessComplete,
      prepared.reconciliation.categoryCount,
      prepared.reconciliation.rawProfileCount,
      prepared.reconciliation.uniqueProfileCount,
      prepared.reconciliation.duplicateProfileCount,
      prepared.reconciliation.permanentFailureCount,
      prepared.startedAt,
      prepared.finishedAt,
      prepared.reconciliation.reconciledAt,
      privateArtifactUri(
        prepared.bundle,
        null,
        path.basename(prepared.bundlePath),
      ),
      JSON.stringify(provenance),
      now,
    ],
  );
  counters.changedRows += result.rowCount ?? 0;
  const id = result.rows[0]?.id;
  if (id !== undefined) return id;
  const existing = await client.query<IdRow>(
    `SELECT "bbb_harvest_run_id" AS "id"
     FROM "bbb_harvest_runs"
     WHERE "county_key" = $1 AND "run_id" = $2`,
    [prepared.bundle.countyKey, prepared.bundle.runId],
  );
  return requireId(existing.rows[0]?.id, "BBB harvest run");
}

async function upsertHarvestCategory(
  client: PoolClient,
  harvestRunId: string,
  prepared: PreparedBundle,
  category: PreparedCategory,
  counters: LoadCounters,
): Promise<string> {
  const summary = category.summary;
  const result = await client.query<IdRow>(
    `INSERT INTO "bbb_harvest_categories" (
       "bbb_harvest_run_id", "category_key", "category_url", "job_id",
       "schema_version", "request_sha256", "manifest_sha256",
       "manifest_artifact_uri", "source_access_status",
       "complete_within_bounds", "advertised_results",
       "category_pages_visited", "profiles_selected", "profiles_harvested",
       "profiles_failed_permanent", "source_access_evidence", "started_at",
       "finished_at"
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16::jsonb, $17, $18
     )
     ON CONFLICT ("bbb_harvest_run_id", "category_key") DO UPDATE SET
       "category_url" = EXCLUDED."category_url",
       "job_id" = EXCLUDED."job_id",
       "schema_version" = EXCLUDED."schema_version",
       "request_sha256" = EXCLUDED."request_sha256",
       "manifest_sha256" = EXCLUDED."manifest_sha256",
       "manifest_artifact_uri" = EXCLUDED."manifest_artifact_uri",
       "source_access_status" = EXCLUDED."source_access_status",
       "complete_within_bounds" = EXCLUDED."complete_within_bounds",
       "advertised_results" = EXCLUDED."advertised_results",
       "category_pages_visited" = EXCLUDED."category_pages_visited",
       "profiles_selected" = EXCLUDED."profiles_selected",
       "profiles_harvested" = EXCLUDED."profiles_harvested",
       "profiles_failed_permanent" = EXCLUDED."profiles_failed_permanent",
       "source_access_evidence" = EXCLUDED."source_access_evidence",
       "started_at" = EXCLUDED."started_at",
       "finished_at" = EXCLUDED."finished_at",
       "updated_at" = now()
     WHERE "bbb_harvest_categories"."manifest_sha256"
       IS DISTINCT FROM EXCLUDED."manifest_sha256"
     RETURNING "bbb_harvest_category_id" AS "id"`,
    [
      harvestRunId,
      summary.categoryKey,
      summary.categoryUrl,
      summary.jobId,
      summary.schemaVersion,
      summary.requestSha256,
      category.summarySha256,
      category.summaryArtifactUri,
      category.sourceAccessStatus,
      summary.completeWithinBounds,
      summary.advertisedResults ?? null,
      summary.categoryPagesVisited,
      summary.profilesSelected,
      summary.profilesHarvested,
      summary.profilesFailedPermanent,
      category.sourceAccessEvidence === null
        ? null
        : JSON.stringify(category.sourceAccessEvidence),
      summary.startedAt,
      summary.finishedAt,
    ],
  );
  counters.changedRows += result.rowCount ?? 0;
  const id = result.rows[0]?.id;
  if (id !== undefined) return id;
  const existing = await client.query<IdRow>(
    `SELECT "bbb_harvest_category_id" AS "id"
     FROM "bbb_harvest_categories"
     WHERE "bbb_harvest_run_id" = $1 AND "category_key" = $2`,
    [harvestRunId, summary.categoryKey],
  );
  if (existing.rows[0]?.id === undefined) {
    throw new Error(
      `Missing BBB category after upsert: ${prepared.bundle.countyKey}/${summary.categoryKey}`,
    );
  }
  return existing.rows[0].id;
}

async function mergeCategoryParts(params: {
  readonly client: PoolClient;
  readonly prepared: PreparedBundle;
  readonly category: PreparedCategory;
  readonly categoryId: string;
  readonly now: string;
  readonly storedSnapshots: Map<string, StoredSnapshot>;
  readonly counters: LoadCounters;
}): Promise<void> {
  const currentPaths = new Set(
    params.category.parts.map((part) => part.receipt.relativePath),
  );
  const existingWatermarks = await params.client.query<
    {
      readonly id: string;
      readonly relative_path: string;
    } & QueryResultRow
  >(
    `SELECT
       "bbb_artifact_watermark_id" AS "id",
       "relative_path"
     FROM "bbb_artifact_watermarks"
     WHERE "bbb_harvest_category_id" = $1 AND "is_current" = true`,
    [params.categoryId],
  );
  for (const watermark of existingWatermarks.rows) {
    if (currentPaths.has(watermark.relative_path)) continue;
    const retired = await retireCurrentMemberships(
      params.client,
      params.categoryId,
      watermark.relative_path,
      new Map(),
      params.now,
    );
    params.counters.retiredMemberships += retired;
    params.counters.changedRows += retired;
    const watermarkResult = await params.client.query(
      `UPDATE "bbb_artifact_watermarks"
       SET "is_current" = false,
           "retired_at" = $2,
           "retirement_reason" = 'removed_from_corrected_manifest',
           "tombstone_count" = "tombstone_count" + $3,
           "updated_at" = $2
       WHERE "bbb_artifact_watermark_id" = $1 AND "is_current" = true`,
      [watermark.id, params.now, retired],
    );
    params.counters.changedRows += watermarkResult.rowCount ?? 0;
  }

  for (const part of params.category.parts) {
    await mergePart({
      ...params,
      part,
    });
  }
}

async function mergePart(params: {
  readonly client: PoolClient;
  readonly prepared: PreparedBundle;
  readonly category: PreparedCategory;
  readonly categoryId: string;
  readonly part: PreparedPart;
  readonly now: string;
  readonly storedSnapshots: Map<string, StoredSnapshot>;
  readonly counters: LoadCounters;
}): Promise<void> {
  const existingResult = await params.client.query<ExistingWatermarkRow>(
    `SELECT
       "bbb_artifact_watermark_id" AS "id",
       "artifact_sha256",
       "is_current"
     FROM "bbb_artifact_watermarks"
     WHERE "bbb_harvest_category_id" = $1 AND "relative_path" = $2`,
    [params.categoryId, params.part.receipt.relativePath],
  );
  const existing = existingResult.rows[0] ?? null;
  if (
    existing !== null &&
    existing.artifact_sha256 === params.part.receipt.sha256 &&
    existing.is_current
  ) {
    params.counters.unchangedArtifacts += 1;
    await hydrateStoredSnapshots(
      params.client,
      params.part.profiles.map((profile) => profile.snapshot),
      params.storedSnapshots,
    );
    return;
  }

  const nextSnapshots = new Map(
    params.part.profiles.map((profile) => [
      profile.snapshot.providerProfileKey,
      profile.snapshot.snapshotSha256,
    ]),
  );
  let retired = 0;
  if (existing !== null) {
    retired = await retireCurrentMemberships(
      params.client,
      params.categoryId,
      params.part.receipt.relativePath,
      nextSnapshots,
      params.now,
    );
    params.counters.retiredMemberships += retired;
    params.counters.changedRows += retired;
  }

  const watermarkResult = await params.client.query<IdRow>(
    `INSERT INTO "bbb_artifact_watermarks" (
       "bbb_harvest_category_id", "relative_path", "artifact_uri",
       "artifact_sha256", "previous_artifact_sha256", "artifact_bytes",
       "record_count", "merged_count", "tombstone_count", "is_current",
       "retired_at", "retirement_reason", "last_merged_at", "updated_at"
     ) VALUES (
       $1, $2, $3, $4, NULL, $5, $6, $7, $8, true, NULL, NULL, $9, $9
     )
     ON CONFLICT ("bbb_harvest_category_id", "relative_path") DO UPDATE SET
       "artifact_uri" = EXCLUDED."artifact_uri",
       "previous_artifact_sha256" = "bbb_artifact_watermarks"."artifact_sha256",
       "artifact_sha256" = EXCLUDED."artifact_sha256",
       "artifact_bytes" = EXCLUDED."artifact_bytes",
       "record_count" = EXCLUDED."record_count",
       "merged_count" = EXCLUDED."merged_count",
       "tombstone_count" = EXCLUDED."tombstone_count",
       "is_current" = true,
       "retired_at" = NULL,
       "retirement_reason" = NULL,
       "last_merged_at" = EXCLUDED."last_merged_at",
       "updated_at" = EXCLUDED."updated_at"
     RETURNING "bbb_artifact_watermark_id" AS "id"`,
    [
      params.categoryId,
      params.part.receipt.relativePath,
      params.part.artifactUri,
      params.part.receipt.sha256,
      params.part.receipt.bytes,
      params.part.receipt.recordCount,
      params.part.profiles.length,
      retired,
      params.now,
    ],
  );
  params.counters.changedRows += watermarkResult.rowCount ?? 0;
  const watermarkId = requireId(
    watermarkResult.rows[0]?.id,
    "BBB artifact watermark",
  );

  for (const profile of params.part.profiles) {
    const stored = await persistSnapshot(
      params.client,
      profile.snapshot,
      params.part.artifactUri,
      params.counters,
    );
    params.storedSnapshots.set(snapshotIdentity(profile.snapshot), stored);
    const membership = await params.client.query(
      `INSERT INTO "bbb_profile_category_memberships" (
         "bbb_harvest_category_id", "bbb_artifact_watermark_id",
         "bbb_profile_snapshot_id", "profile_source_key",
         "artifact_relative_path", "artifact_sha256", "is_current"
       ) VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (
         "bbb_harvest_category_id",
         "artifact_relative_path",
         "artifact_sha256",
         "profile_source_key"
       ) DO UPDATE SET
         "bbb_artifact_watermark_id" =
           EXCLUDED."bbb_artifact_watermark_id",
         "bbb_profile_snapshot_id" = EXCLUDED."bbb_profile_snapshot_id",
         "is_current" = true,
         "retired_at" = NULL,
         "retirement_reason" = NULL
       WHERE "bbb_profile_category_memberships"."is_current" = false`,
      [
        params.categoryId,
        watermarkId,
        stored.id,
        profile.snapshot.providerProfileKey,
        params.part.receipt.relativePath,
        params.part.receipt.sha256,
      ],
    );
    const inserted = membership.rowCount ?? 0;
    params.counters.changedRows += inserted;
    params.counters.insertedMemberships += inserted;
  }
}

async function retireCurrentMemberships(
  client: PoolClient,
  categoryId: string,
  relativePath: string,
  nextSnapshots: ReadonlyMap<string, string>,
  now: string,
): Promise<number> {
  const current = await client.query<ExistingMembershipRow>(
    `SELECT
       membership."bbb_profile_category_membership_id" AS "id",
       membership."profile_source_key",
       snapshot."snapshot_sha256"
     FROM "bbb_profile_category_memberships" membership
     JOIN "bbb_profile_snapshots" snapshot
       ON snapshot."bbb_profile_snapshot_id" =
          membership."bbb_profile_snapshot_id"
     WHERE membership."bbb_harvest_category_id" = $1
       AND membership."artifact_relative_path" = $2
       AND membership."is_current" = true`,
    [categoryId, relativePath],
  );
  let retired = 0;
  for (const membership of current.rows) {
    const nextHash = nextSnapshots.get(membership.profile_source_key);
    const reason =
      nextHash === undefined
        ? "missing_from_corrected_artifact"
        : nextHash === membership.snapshot_sha256
          ? "superseded_by_corrected_artifact"
          : "superseded_by_corrected_snapshot";
    const result = await client.query(
      `UPDATE "bbb_profile_category_memberships"
       SET "is_current" = false, "retired_at" = $2, "retirement_reason" = $3
       WHERE "bbb_profile_category_membership_id" = $1 AND "is_current" = true`,
      [membership.id, now, reason],
    );
    retired += result.rowCount ?? 0;
  }
  return retired;
}

async function persistSnapshot(
  client: PoolClient,
  snapshot: PreparedProfileSnapshot,
  artifactUri: string,
  counters: LoadCounters,
): Promise<StoredSnapshot> {
  const inserted = await client.query<IdRow>(
    `INSERT INTO "bbb_profile_snapshots" (
       "provider", "provider_profile_key", "provider_business_key",
       "provider_profile_id", "provider_business_id", "provider_bbb_id",
       "profile_url", "name", "legal_name", "normalized_names",
       "normalized_phones", "license_identifiers", "is_accredited",
       "bbb_rating", "review_count", "complaint_count", "source_retrieved_at",
       "snapshot_as_of", "extraction_schema_version", "snapshot_sha256",
       "extracted_payload", "first_artifact_uri"
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[],
       $12::text[], $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22
     )
     ON CONFLICT ("provider", "provider_profile_key", "snapshot_sha256")
     DO NOTHING
     RETURNING "bbb_profile_snapshot_id" AS "id"`,
    [
      BBB_PROVIDER,
      snapshot.providerProfileKey,
      snapshot.providerBusinessKey,
      snapshot.providerProfileId,
      snapshot.providerBusinessId,
      snapshot.providerBbbId,
      snapshot.profileUrl,
      snapshot.name,
      snapshot.legalName,
      snapshot.normalizedNames,
      snapshot.normalizedPhones,
      snapshot.licenseIdentifiers,
      snapshot.isAccredited,
      snapshot.bbbRating,
      snapshot.reviewCount,
      snapshot.complaintCount,
      snapshot.sourceRetrievedAt,
      snapshot.snapshotAsOf,
      snapshot.extractionSchemaVersion,
      snapshot.snapshotSha256,
      JSON.stringify(snapshot.extractedPayload),
      artifactUri,
    ],
  );
  const insertedCount = inserted.rowCount ?? 0;
  counters.changedRows += insertedCount;
  counters.insertedSnapshots += insertedCount;
  let id = inserted.rows[0]?.id;
  if (id === undefined) {
    const existing = await client.query<IdRow>(
      `SELECT "bbb_profile_snapshot_id" AS "id"
       FROM "bbb_profile_snapshots"
       WHERE "provider" = $1
         AND "provider_profile_key" = $2
         AND "snapshot_sha256" = $3`,
      [BBB_PROVIDER, snapshot.providerProfileKey, snapshot.snapshotSha256],
    );
    id = existing.rows[0]?.id;
  }
  return { prepared: snapshot, id: requireId(id, "BBB profile snapshot") };
}

async function hydrateStoredSnapshots(
  client: PoolClient,
  snapshots: readonly PreparedProfileSnapshot[],
  storedSnapshots: Map<string, StoredSnapshot>,
): Promise<void> {
  for (const snapshot of snapshots) {
    const identity = snapshotIdentity(snapshot);
    if (storedSnapshots.has(identity)) continue;
    const existing = await client.query<IdRow>(
      `SELECT "bbb_profile_snapshot_id" AS "id"
       FROM "bbb_profile_snapshots"
       WHERE "provider" = $1
         AND "provider_profile_key" = $2
         AND "snapshot_sha256" = $3`,
      [BBB_PROVIDER, snapshot.providerProfileKey, snapshot.snapshotSha256],
    );
    storedSnapshots.set(identity, {
      prepared: snapshot,
      id: requireId(existing.rows[0]?.id, "BBB profile snapshot"),
    });
  }
}

async function resolveOfficialEvidence(
  client: PoolClient,
  evidenceRows: readonly OfficialEvidence[],
): Promise<readonly ResolvedEvidence[]> {
  const resolved: ResolvedEvidence[] = [];
  for (const evidence of evidenceRows) {
    const result =
      evidence.schemaVersion === OFFICIAL_EVIDENCE_SCHEMA_VERSION
        ? await client.query<ResolvedEvidenceRow>(
            `SELECT
               company."company_id",
               company."name" AS "company_name",
               company."source_system" AS "company_source_system",
               company."source_record_key" AS "company_source_record_key",
               improvement."property_improvement_id",
               improvement."property_id",
               improvement."source_system" AS "permit_source_system",
               improvement."source_record_key" AS "permit_source_record_key",
               (
                 improvement."contractor_company_id" = company."company_id"
                 OR EXISTS (
                   SELECT 1
                   FROM "permit_contacts" contact
                   WHERE contact."property_improvement_id" =
                         improvement."property_improvement_id"
                     AND contact."company_id" = company."company_id"
                 )
               ) AS "officially_linked"
             FROM "companies" company
             CROSS JOIN "property_improvements" improvement
             WHERE company."source_system" = $1
               AND company."source_record_key" = $2
               AND improvement."source_system" = $3
               AND improvement."source_record_key" = $4`,
            [
              evidence.company.sourceSystem,
              evidence.company.sourceRecordKey,
              evidence.permit.sourceSystem,
              evidence.permit.sourceRecordKey,
            ],
          )
        : await client.query<ResolvedEvidenceRow>(
            `SELECT
               company."company_id",
               company."name" AS "company_name",
               company."source_system" AS "company_source_system",
               company."source_record_key" AS "company_source_record_key",
               improvement."property_improvement_id",
               improvement."property_id",
               improvement."source_system" AS "permit_source_system",
               improvement."source_record_key" AS "permit_source_record_key",
               (
                 improvement."contractor_company_id" = company."company_id"
                 OR EXISTS (
                   SELECT 1
                   FROM "permit_contacts" contact
                   WHERE contact."property_improvement_id" =
                         improvement."property_improvement_id"
                     AND contact."company_id" = company."company_id"
                 )
               ) AS "officially_linked"
             FROM "companies" company
             CROSS JOIN "property_improvements" improvement
             WHERE company."request_identifier" = $1
               AND improvement."property_improvement_id" = $2
               AND improvement."property_id" = $3`,
            [
              evidence.company.requestIdentifier,
              evidence.permit.propertyImprovementId,
              evidence.permit.propertyId,
            ],
          );
    if (result.rows.length !== 1) {
      throw new Error(
        `Official BBB evidence must resolve exactly one existing company and permit: ${evidence.evidenceKey}`,
      );
    }
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `Official BBB evidence does not resolve an existing company and permit: ${evidence.evidenceKey}`,
      );
    }
    if (row.property_id === null) {
      throw new Error(
        `Official BBB evidence permit has no linked property: ${evidence.evidenceKey}`,
      );
    }
    if (!row.officially_linked) {
      throw new Error(
        `Official BBB evidence company is not linked to its permit: ${evidence.evidenceKey}`,
      );
    }
    resolved.push({
      evidence,
      evidenceSha256: hashString(stableJsonStringify(evidence)),
      companyId: row.company_id,
      companyName: row.company_name,
      propertyImprovementId: row.property_improvement_id,
      propertyId: row.property_id,
      permitSourceSystem: row.permit_source_system,
      permitSourceRecordKey: row.permit_source_record_key,
      companySourceSystem: row.company_source_system,
      companySourceRecordKey: row.company_source_record_key,
    });
  }
  return resolved;
}

function buildOfficialCompanyIdentities(
  evidenceRows: readonly ResolvedEvidence[],
): readonly OfficialCompanyIdentity[] {
  const byCompany = new Map<string, ResolvedEvidence[]>();
  for (const evidence of evidenceRows) {
    const values = byCompany.get(evidence.companyId) ?? [];
    values.push(evidence);
    byCompany.set(evidence.companyId, values);
  }
  return [...byCompany.entries()].map(([companyId, evidence]) => {
    const identityKeys = uniqueSorted(
      evidence.map(
        (entry) =>
          `${entry.companySourceSystem}:${entry.companySourceRecordKey}`,
      ),
    );
    const names = uniqueSorted(
      evidence
        .flatMap((entry) => [
          entry.companyName,
          entry.evidence.contractor.name ?? null,
          entry.evidence.contractor.legalName ?? null,
          ...entry.evidence.contractor.alternateNames,
        ])
        .filter((value): value is string => value !== null),
    );
    const normalizedNames = uniqueSorted(
      names
        .map((name) => normalizePrivateBbbBusinessName(name))
        .filter((value): value is string => value !== null),
    );
    const looseNames = uniqueSorted(
      names
        .map((name) => normalizePrivateBbbBusinessName(name, { loose: true }))
        .filter((value): value is string => value !== null),
    );
    const phones = uniqueSorted(
      evidence
        .flatMap((entry) => entry.evidence.contractor.phones)
        .map(normalizePrivateBbbPhone)
        .filter((value): value is string => value !== null),
    );
    const licenses = uniqueSorted(
      evidence
        .flatMap((entry) => entry.evidence.contractor.licenseIdentifiers)
        .map(normalizePrivateBbbLicense)
        .filter((value): value is string => value !== null),
    );
    return {
      companyId,
      officialIdentityKey: identityKeys.join("|"),
      evidence,
      names,
      normalizedNames,
      looseNames,
      phones,
      licenses,
    };
  });
}

function buildBbbBusinessIdentities(
  snapshots: readonly PreparedProfileSnapshot[],
): readonly BbbBusinessIdentity[] {
  const byBusiness = new Map<string, PreparedProfileSnapshot[]>();
  for (const snapshot of snapshots) {
    const values = byBusiness.get(snapshot.providerBusinessKey) ?? [];
    values.push(snapshot);
    byBusiness.set(snapshot.providerBusinessKey, values);
  }
  return [...byBusiness.entries()].map(([providerBusinessKey, values]) => ({
    providerBusinessKey,
    snapshots: [...values].sort((left, right) =>
      snapshotIdentity(left).localeCompare(snapshotIdentity(right)),
    ),
    normalizedNames: uniqueSorted(
      values.flatMap((value) => value.normalizedNames),
    ),
    looseNames: uniqueSorted(
      values
        .flatMap((value) => [value.name, value.legalName])
        .map((value) => normalizePrivateBbbBusinessName(value, { loose: true }))
        .filter((value): value is string => value !== null),
    ),
    phones: uniqueSorted(values.flatMap((value) => value.normalizedPhones)),
    licenses: uniqueSorted(values.flatMap((value) => value.licenseIdentifiers)),
  }));
}

function buildPrivateBbbMatchPlan(
  companies: readonly OfficialCompanyIdentity[],
  businesses: readonly BbbBusinessIdentity[],
): readonly MatchPlan[] {
  const businessesByKey = new Map(
    businesses.map((business) => [business.providerBusinessKey, business]),
  );
  const licenseIndex = buildSignalIndex(businesses, (value) => value.licenses);
  const phoneIndex = buildSignalIndex(businesses, (value) => value.phones);
  const nameIndex = buildSignalIndex(
    businesses,
    (value) => value.normalizedNames,
  );
  return companies.flatMap((company) => {
    const licenseCandidates = indexedCandidates(
      licenseIndex,
      company.licenses,
      businessesByKey,
    );
    if (licenseCandidates.length > 0) {
      return exactTierPlans(
        company,
        licenseCandidates,
        "exact_state_license",
        1,
      );
    }
    const phoneCandidates = indexedCandidates(
      phoneIndex,
      company.phones,
      businessesByKey,
    );
    if (phoneCandidates.length > 0) {
      return exactTierPlans(
        company,
        phoneCandidates,
        "exact_standardized_phone",
        0.95,
      );
    }
    const nameCandidates = indexedCandidates(
      nameIndex,
      company.normalizedNames,
      businessesByKey,
    );
    if (nameCandidates.length > 0) {
      return exactTierPlans(
        company,
        nameCandidates,
        "unique_exact_normalized_business_name",
        0.8,
      );
    }
    return fuzzyPlans(company, businesses);
  });
}

function buildIncompleteSourceMatchPlan(
  companies: readonly OfficialCompanyIdentity[],
): readonly MatchPlan[] {
  return companies.map((company) => ({
    company,
    business: null,
    candidateKey: "none",
    outcome: "unmatched",
    matchMethod: null,
    confidence: null,
    evidencePayload: {
      disposition: "source_incomplete_no_automatic_match",
      sourceCoverageComplete: false,
    },
  }));
}

function exactTierPlans(
  company: OfficialCompanyIdentity,
  candidates: readonly BbbBusinessIdentity[],
  matchMethod: NonNullable<MatchPlan["matchMethod"]>,
  confidence: number,
): readonly MatchPlan[] {
  const outcome = candidates.length === 1 ? "accepted" : "ambiguous";
  return candidates.map((business) => ({
    company,
    business,
    candidateKey: business.providerBusinessKey,
    outcome,
    matchMethod,
    confidence,
    evidencePayload: {
      tier: matchMethod,
      candidateCountAtTier: candidates.length,
    },
  }));
}

function fuzzyPlans(
  company: OfficialCompanyIdentity,
  businesses: readonly BbbBusinessIdentity[],
): readonly MatchPlan[] {
  const ranked = businesses
    .map((business) => ({
      business,
      score: maximumSimilarity(company.looseNames, business.looseNames),
    }))
    .filter((entry) => entry.score >= 0.9)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.business.providerBusinessKey.localeCompare(
          right.business.providerBusinessKey,
        ),
    );
  const top = ranked[0];
  if (top === undefined) {
    return [
      {
        company,
        business: null,
        candidateKey: "none",
        outcome: "unmatched",
        matchMethod: null,
        confidence: null,
        evidencePayload: { disposition: "no_candidate" },
      },
    ];
  }
  const runnerUp = ranked[1];
  const ambiguous = runnerUp !== undefined && top.score - runnerUp.score < 0.05;
  const selected =
    ambiguous && runnerUp !== undefined ? [top, runnerUp] : [top];
  return selected.map((entry) => ({
    company,
    business: entry.business,
    candidateKey: entry.business.providerBusinessKey,
    outcome: ambiguous ? "ambiguous" : "review",
    matchMethod: "jaro_winkler_cleaned_business_name",
    confidence: Number(entry.score.toFixed(4)),
    evidencePayload: {
      tier: "jaro_winkler_cleaned_business_name",
      fuzzyThreshold: 0.9,
      fuzzyMargin: 0.05,
      runnerUpScore: runnerUp?.score ?? null,
    },
  }));
}

function buildSignalIndex(
  businesses: readonly BbbBusinessIdentity[],
  values: (business: BbbBusinessIdentity) => readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const business of businesses) {
    for (const signal of values(business)) {
      const keys = index.get(signal) ?? new Set<string>();
      keys.add(business.providerBusinessKey);
      index.set(signal, keys);
    }
  }
  return index;
}

function indexedCandidates(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  signals: readonly string[],
  businessesByKey: ReadonlyMap<string, BbbBusinessIdentity>,
): readonly BbbBusinessIdentity[] {
  const keys = new Set<string>();
  for (const signal of signals) {
    for (const key of index.get(signal) ?? []) keys.add(key);
  }
  return [...keys]
    .sort()
    .map((key) => businessesByKey.get(key))
    .filter((value): value is BbbBusinessIdentity => value !== undefined);
}

async function activateReconciliationRun(params: {
  readonly client: PoolClient;
  readonly harvestRunId: string;
  readonly reconciliationKey: string;
  readonly prepared: PreparedBundle;
  readonly companies: readonly OfficialCompanyIdentity[];
  readonly matchPlans: readonly MatchPlan[];
  readonly acceptedPropertyLinkCount: number;
  readonly now: string;
  readonly counters: LoadCounters;
}): Promise<{ readonly id: string; readonly reused: boolean }> {
  const existing = await params.client.query<ReconciliationRunRow>(
    `SELECT "bbb_reconciliation_run_id" AS "id", "is_current"
     FROM "bbb_reconciliation_runs"
     WHERE "bbb_harvest_run_id" = $1 AND "reconciliation_key" = $2`,
    [params.harvestRunId, params.reconciliationKey],
  );
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    const retired = await params.client.query(
      `UPDATE "bbb_reconciliation_runs"
       SET "is_current" = false, "updated_at" = $3
       WHERE "bbb_harvest_run_id" = $1
         AND "bbb_reconciliation_run_id" <> $2
         AND "is_current" = true`,
      [params.harvestRunId, existingRow.id, params.now],
    );
    params.counters.changedRows += retired.rowCount ?? 0;
    if (!existingRow.is_current) {
      const activated = await params.client.query(
        `UPDATE "bbb_reconciliation_runs"
         SET "is_current" = true, "updated_at" = $2
         WHERE "bbb_reconciliation_run_id" = $1`,
        [existingRow.id, params.now],
      );
      params.counters.changedRows += activated.rowCount ?? 0;
    }
    return { id: existingRow.id, reused: true };
  }
  const retired = await params.client.query(
    `UPDATE "bbb_reconciliation_runs"
     SET "is_current" = false, "updated_at" = $2
     WHERE "bbb_harvest_run_id" = $1 AND "is_current" = true`,
    [params.harvestRunId, params.now],
  );
  params.counters.changedRows += retired.rowCount ?? 0;
  const counts = countMatchPlans(params.matchPlans);
  const result = await params.client.query<IdRow>(
    `INSERT INTO "bbb_reconciliation_runs" (
       "bbb_harvest_run_id", "reconciliation_key", "policy_version",
       "official_evidence_sha256", "official_evidence_artifact_uri", "status",
       "source_coverage_complete", "is_current", "official_identity_count",
       "official_company_count", "accepted_match_count",
       "review_candidate_count", "ambiguous_candidate_count", "unmatched_count",
       "accepted_property_link_count", "started_at", "finished_at"
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12, $13,
       $14, $15, $15
     )
     RETURNING "bbb_reconciliation_run_id" AS "id"`,
    [
      params.harvestRunId,
      params.reconciliationKey,
      MATCH_POLICY_VERSION,
      params.prepared.officialEvidenceSha256,
      privateArtifactUri(
        params.prepared.bundle,
        null,
        params.prepared.bundle.officialPermitCompanyEvidence,
      ),
      params.prepared.sourceAccessComplete ? "completed" : "incomplete_source",
      params.prepared.sourceAccessComplete,
      params.prepared.officialEvidence.length,
      params.companies.length,
      counts.acceptedMatchCount,
      counts.reviewCandidateCount,
      counts.ambiguousCandidateCount,
      counts.unmatchedCount,
      params.acceptedPropertyLinkCount,
      params.now,
    ],
  );
  params.counters.changedRows += result.rowCount ?? 0;
  return {
    id: requireId(result.rows[0]?.id, "BBB reconciliation run"),
    reused: false,
  };
}

async function persistMatchPlan(params: {
  readonly client: PoolClient;
  readonly reconciliationRunId: string;
  readonly matchPlans: readonly MatchPlan[];
  readonly storedSnapshots: ReadonlyMap<string, StoredSnapshot>;
  readonly now: string;
  readonly counters: LoadCounters;
}): Promise<void> {
  const acceptedMatchIds = new Map<string, string>();
  for (const plan of params.matchPlans) {
    const representative = plan.business?.snapshots[0] ?? null;
    const storedRepresentative =
      representative === null
        ? null
        : (params.storedSnapshots.get(snapshotIdentity(representative)) ??
          null);
    if (representative !== null && storedRepresentative === null) {
      throw new Error(
        `BBB representative snapshot was not persisted: ${representative.providerProfileKey}`,
      );
    }
    const evidencePayload = {
      ...plan.evidencePayload,
      officialEvidenceKeys: plan.company.evidence
        .map((entry) => entry.evidence.evidenceKey)
        .sort(),
      legalIdentitySource: "existing_official_company_and_permit_edges",
      bbbEstablishesLegalIdentity: false,
    };
    const result = await params.client.query<IdRow>(
      `INSERT INTO "bbb_reconciliation_matches" (
         "bbb_reconciliation_run_id", "company_id",
         "representative_profile_snapshot_id", "official_identity_key",
         "provider_business_key", "candidate_key", "outcome", "match_method",
         "confidence", "official_name", "official_normalized_name",
         "official_license_identifiers", "official_phone_identifiers",
         "evidence_sha256", "evidence_payload"
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[],
         $13::text[], $14, $15::jsonb
       )
       ON CONFLICT (
         "bbb_reconciliation_run_id", "official_identity_key", "candidate_key"
       ) DO NOTHING
       RETURNING "bbb_reconciliation_match_id" AS "id"`,
      [
        params.reconciliationRunId,
        plan.company.companyId,
        storedRepresentative?.id ?? null,
        plan.company.officialIdentityKey,
        plan.business?.providerBusinessKey ?? null,
        plan.candidateKey,
        plan.outcome,
        plan.matchMethod,
        plan.confidence,
        plan.company.names[0] ?? null,
        plan.company.normalizedNames[0] ?? null,
        plan.company.licenses,
        plan.company.phones,
        hashString(stableJsonStringify(evidencePayload)),
        JSON.stringify(evidencePayload),
      ],
    );
    params.counters.changedRows += result.rowCount ?? 0;
    const matchId = result.rows[0]?.id;
    if (plan.outcome === "accepted") {
      acceptedMatchIds.set(
        plan.company.companyId,
        requireId(matchId, "accepted BBB reconciliation match"),
      );
    }
  }

  const seenLinks = new Set<string>();
  for (const plan of params.matchPlans) {
    if (plan.outcome !== "accepted") continue;
    const matchId = requireId(
      acceptedMatchIds.get(plan.company.companyId),
      "accepted BBB reconciliation match",
    );
    const snapshotAsOf = plan.business?.snapshots[0]?.snapshotAsOf;
    if (snapshotAsOf === undefined) {
      throw new Error("Accepted BBB match has no profile snapshot");
    }
    for (const evidence of plan.company.evidence) {
      const linkKey = `${matchId}:${evidence.propertyImprovementId}:${evidence.propertyId}`;
      if (seenLinks.has(linkKey)) continue;
      seenLinks.add(linkKey);
      const result = await params.client.query(
        `INSERT INTO "bbb_property_link_evidence" (
           "bbb_reconciliation_match_id", "property_improvement_id",
           "property_id", "company_id", "permit_source_system",
           "permit_source_record_key", "official_evidence_key",
           "evidence_sha256", "snapshot_as_of"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (
           "bbb_reconciliation_match_id", "property_improvement_id", "property_id"
         ) DO NOTHING`,
        [
          matchId,
          evidence.propertyImprovementId,
          evidence.propertyId,
          evidence.companyId,
          evidence.permitSourceSystem,
          evidence.permitSourceRecordKey,
          evidence.evidence.evidenceKey,
          evidence.evidenceSha256,
          snapshotAsOf,
        ],
      );
      params.counters.changedRows += result.rowCount ?? 0;
    }
  }
}

function countMatchPlans(plans: readonly MatchPlan[]): {
  readonly acceptedMatchCount: number;
  readonly reviewCandidateCount: number;
  readonly ambiguousCandidateCount: number;
  readonly unmatchedCount: number;
} {
  return {
    acceptedMatchCount: plans.filter((plan) => plan.outcome === "accepted")
      .length,
    reviewCandidateCount: plans.filter((plan) => plan.outcome === "review")
      .length,
    ambiguousCandidateCount: plans.filter(
      (plan) => plan.outcome === "ambiguous",
    ).length,
    unmatchedCount: plans.filter((plan) => plan.outcome === "unmatched").length,
  };
}

function countAcceptedPropertyLinks(plans: readonly MatchPlan[]): number {
  const keys = new Set<string>();
  for (const plan of plans) {
    if (plan.outcome !== "accepted") continue;
    for (const evidence of plan.company.evidence) {
      keys.add(
        `${plan.company.companyId}:${evidence.propertyImprovementId}:${evidence.propertyId}`,
      );
    }
  }
  return keys.size;
}

function assertAdapterMatchExpectations(
  prepared: PreparedBundle,
  plans: readonly MatchPlan[],
): void {
  const receipt = prepared.adapterReceipt;
  if (receipt === null) return;
  const counts = countMatchPlans(plans);
  const methodCounts = {
    exact_state_license: plans.filter(
      (plan) =>
        plan.outcome === "accepted" &&
        plan.matchMethod === "exact_state_license",
    ).length,
    exact_standardized_phone: plans.filter(
      (plan) =>
        plan.outcome === "accepted" &&
        plan.matchMethod === "exact_standardized_phone",
    ).length,
    unique_exact_normalized_business_name: plans.filter(
      (plan) =>
        plan.outcome === "accepted" &&
        plan.matchMethod === "unique_exact_normalized_business_name",
    ).length,
  };
  if (
    countAcceptedPropertyLinks(plans) !== receipt.acceptedPropertyLinkCount ||
    new Set(plans.map((plan) => plan.company.companyId)).size !==
      receipt.officialCompanyCount ||
    counts.reviewCandidateCount !== receipt.reviewCandidateCount ||
    stableJsonStringify(methodCounts) !==
      stableJsonStringify(receipt.matchMethodCounts)
  ) {
    throw new Error(
      "BBB loader prediction does not match the Oracle adapter receipt",
    );
  }
  for (const plan of plans) {
    for (const resolved of plan.company.evidence) {
      const evidence = resolved.evidence;
      if (evidence.schemaVersion !== OFFICIAL_EVIDENCE_SCHEMA_VERSION_V2) {
        continue;
      }
      if (evidence.expectedMatch === undefined) continue;
      const actualProfileKeys = new Set(
        plan.business?.snapshots.map(
          (snapshot) => snapshot.providerProfileKey,
        ) ?? [],
      );
      if (
        plan.outcome !== "accepted" ||
        plan.business?.providerBusinessKey !==
          evidence.expectedMatch.providerBusinessKey ||
        plan.matchMethod !== evidence.expectedMatch.method ||
        plan.confidence !== evidence.expectedMatch.confidence ||
        evidence.expectedMatch.providerProfileKeys.some(
          (profileKey) => !actualProfileKeys.has(profileKey),
        )
      ) {
        throw new Error(
          `BBB exact-tier prediction mismatch for ${evidence.evidenceKey}`,
        );
      }
    }
  }
}

function deriveSourceAccessStatus(
  categories: readonly PreparedCategory[],
): "accessible" | "blocked" | "incomplete" {
  if (
    categories.some((category) =>
      ["blocked", "not_attempted_after_source_block"].includes(
        category.sourceAccessStatus,
      ),
    )
  ) {
    return "blocked";
  }
  if (
    categories.some(
      (category) =>
        category.sourceAccessStatus !== "accessible" ||
        !category.summary.completeWithinBounds,
    )
  ) {
    return "incomplete";
  }
  return "accessible";
}

function canonicalBbbProfileUrl(value: string | null): string {
  if (value === null) throw new Error("BBB profile is missing profileUrl");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/(?:^|\.)bbb\.org$/iu.test(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !url.pathname.includes("/profile/")
  ) {
    throw new Error(`Invalid BBB profile URL: ${value}`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function validateBbbCategoryUrl(
  value: string,
  options: { readonly allowPageParameter?: boolean } = {},
): void {
  const url = new URL(value);
  const pageValues = url.searchParams.getAll("page");
  const validSearch =
    options.allowPageParameter === true
      ? [...url.searchParams.keys()].every((key) => key === "page") &&
        (pageValues.length === 0 ||
          (pageValues.length === 1 && /^[1-9]\d*$/u.test(pageValues[0] ?? "")))
      : url.search === "";
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.bbb.org" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !validSearch ||
    !url.pathname.includes("/category/")
  ) {
    throw new Error(`Invalid BBB category URL: ${value}`);
  }
}

function businessUrlKey(profileUrl: string): string {
  const url = new URL(profileUrl);
  url.pathname = url.pathname.replace(/\/addressId\/[^/]+$/iu, "");
  return url.toString();
}

function extractProfileLicenses(record: JsonObject): readonly string[] {
  const values = new Set<string>();
  const entries = Array.isArray(record.licenses)
    ? record.licenses
    : Array.isArray(record.license_information)
      ? record.license_information
      : [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      addLicenseText(values, entry);
      continue;
    }
    if (!isJsonObject(entry)) continue;
    const direct = readFirstString(entry, [
      "licenseNumber",
      "license_number",
      "number",
    ]);
    const normalizedDirect = normalizePrivateBbbLicense(direct);
    if (normalizedDirect !== null) values.add(normalizedDirect);
    for (const key of ["rawText", "raw_text", "text", "description"]) {
      const text = readString(entry[key]);
      if (text !== null) addLicenseText(values, text);
    }
  }
  return [...values].sort();
}

function addLicenseText(values: Set<string>, text: string): void {
  for (const match of text.matchAll(LICENSE_IN_TEXT_PATTERN)) {
    const normalized = normalizePrivateBbbLicense(match[1]);
    if (normalized !== null) values.add(normalized);
  }
}

function readNameEntries(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!isJsonObject(entry)) return [];
    const name = readFirstString(entry, ["name", "alternateName", "value"]);
    return name === null ? [] : [name];
  });
}

function readStringEntries(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = readString(entry);
    return text === null ? [] : [text];
  });
}

function readFirstString(
  record: JsonObject,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const value = readString(record[alias]);
    if (value !== null) return value;
  }
  return null;
}

function readFirstTimestamp(
  record: JsonObject,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const value = readTimestamp(record[alias]);
    if (value !== null) return value;
  }
  return null;
}

function readObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function sanitizeSourceAccessEvidence(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const observedUrl = readString(value.observedUrl);
  if (observedUrl !== null) {
    validateBbbCategoryUrl(observedUrl, { allowPageParameter: true });
  }
  return compactObject({
    schemaVersion: readString(value.schemaVersion),
    source: readString(value.source),
    runId: readString(value.runId),
    batchRequestSha256: readString(value.batchRequestSha256),
    observedBatchJobId: readString(value.observedBatchJobId),
    observedAt: readTimestamp(value.observedAt),
    observedCategoryKey: readString(value.observedCategoryKey),
    observedUrl,
    httpStatus: readInteger(value.httpStatus),
    classification: readString(value.classification),
    failureReason: readString(value.failureReason),
    operatorDirective: readString(value.operatorDirective),
  });
}

function assertNoRawHtml(value: JsonObject): void {
  const serializedKeys = Object.keys(value).join(" ").toLowerCase();
  if (
    /(?:^|\s)(?:html|rawhtml|raw_page|rawpage)(?:\s|$)/u.test(serializedKeys)
  ) {
    throw new Error(
      "raw HTML fields are forbidden in BBB persistence payloads",
    );
  }
}

function privateArtifactUri(
  bundle: PrivateBbbBundle,
  categoryKey: string | null,
  relativePath: string,
): string {
  const segments = [
    "private://bbb",
    encodeURIComponent(bundle.countyKey),
    encodeURIComponent(bundle.runId),
    categoryKey === null ? null : encodeURIComponent(categoryKey),
    ...relativePath.split(/[\\/]/u).map(encodeURIComponent),
  ].filter((value): value is string => value !== null);
  return segments.join("/");
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes BBB bundle root: ${relativePath}`);
  }
  return resolved;
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Invalid JSON in ${label}: ${message}`);
  }
}

function nonemptyLines(body: string): readonly string[] {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotIdentity(snapshot: PreparedProfileSnapshot): string {
  return `${snapshot.providerProfileKey}:${snapshot.snapshotSha256}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function minimumTimestamp(values: readonly string[]): string {
  return [...values].sort()[0] ?? new Date(0).toISOString();
}

function maximumTimestamp(values: readonly string[]): string {
  return [...values].sort().at(-1) ?? new Date(0).toISOString();
}

function maximumSimilarity(
  leftValues: readonly string[],
  rightValues: readonly string[],
): number {
  let score = 0;
  for (const left of leftValues) {
    for (const right of rightValues) {
      score = Math.max(score, jaroWinklerSimilarity(left, right));
    }
  }
  return score;
}

function requireId(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`Missing ${label} id`);
  return value;
}
