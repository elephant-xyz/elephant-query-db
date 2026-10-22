import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { stableJsonStringify } from "./normalizers.js";

const HANDOFF_SCHEMA_VERSION = "oracle.bbb-private-loader-handoff.v1";
const SOURCE_MANIFEST_SCHEMA_VERSION = "oracle.bbb-official-permit-linkage.v1";
const SOURCE_LINK_SCHEMA_VERSION = "oracle.bbb-official-permit-link.v1";
const BUNDLE_SCHEMA_VERSION = "elephant.bbb-private-persistence-bundle.v1";
const OFFICIAL_EVIDENCE_SCHEMA_VERSION =
  "elephant.bbb-official-permit-company-evidence.v2";
const ADAPTER_RECEIPT_SCHEMA_VERSION =
  "elephant.bbb-private-bundle-adapter-receipt.v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const countyKeySchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const safeKeySchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\0"),
    "path must be relative and remain inside the handoff",
  );
const exactMatchMethodSchema = z.enum([
  "exact_state_license",
  "exact_standardized_phone",
  "unique_exact_normalized_business_name",
]);
const exactMatchCountsSchema = z
  .object({
    exact_state_license: z.number().int().nonnegative(),
    exact_standardized_phone: z.number().int().nonnegative(),
    unique_exact_normalized_business_name: z.number().int().nonnegative(),
  })
  .strict();
const artifactReceiptSchema = z
  .object({
    relativePath: relativePathSchema,
    bytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
    records: z.number().int().nonnegative().optional(),
  })
  .strict();
const requiredRecordArtifactSchema = artifactReceiptSchema.extend({
  records: z.number().int().positive(),
});

const handoffSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    countyKey: countyKeySchema,
    runId: z
      .string()
      .min(8)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9-]*$/u),
    sourceManifest: artifactReceiptSchema,
    reconciliationManifest: artifactReceiptSchema,
    permitCoverage: artifactReceiptSchema,
    permitCompanyEvidence: requiredRecordArtifactSchema,
    acceptedLinks: requiredRecordArtifactSchema,
    categories: z
      .array(
        z
          .object({
            categoryKey: countyKeySchema,
            harvestDirectory: relativePathSchema,
            summarySha256: sha256Schema,
            profileCount: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    expectations: z
      .object({
        sourceAccessComplete: z.literal(true),
        profileCount: z.number().int().positive(),
        officialIdentityCount: z.number().int().positive(),
        officialCompanyCount: z.number().int().positive(),
        profilesSha256: sha256Schema,
        acceptedPropertyLinkCount: z.number().int().positive(),
        reviewCandidateCount: z.literal(0),
        fuzzyAcceptedCount: z.literal(0),
        matchMethodCounts: exactMatchCountsSchema,
        permitWatermarkDigest: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((handoff, context) => {
    const categoryKeys = handoff.categories.map(
      (category) => category.categoryKey,
    );
    if (new Set(categoryKeys).size !== categoryKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "category keys must be unique",
      });
    }
    const expectedAccepted = Object.values(
      handoff.expectations.matchMethodCounts,
    ).reduce((total, count) => total + count, 0);
    if (expectedAccepted !== handoff.expectations.acceptedPropertyLinkCount) {
      context.addIssue({
        code: "custom",
        path: ["expectations", "matchMethodCounts"],
        message: "exact-tier counts must equal accepted property links",
      });
    }
    if (
      handoff.permitCompanyEvidence.records !==
      handoff.expectations.officialIdentityCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["permitCompanyEvidence", "records"],
        message: "permit-company records must equal official identity count",
      });
    }
  });

const categorySummarySchema = z
  .object({
    schemaVersion: z.literal("elephant.bbb-category-harvest.v1"),
    county: countyKeySchema,
    categoryKey: countyKeySchema,
    profilesHarvested: z.number().int().nonnegative(),
    profilesFailedPermanent: z.number().int().nonnegative(),
    completeWithinBounds: z.boolean(),
    sourceAccessStatus: z.string().optional(),
    profileParts: z.array(
      z
        .object({
          relativePath: relativePathSchema,
          recordCount: z.number().int().positive(),
          bytes: z.number().int().positive(),
          sha256: sha256Schema,
        })
        .strict(),
    ),
    failurePart: z
      .object({
        relativePath: relativePathSchema,
        recordCount: z.number().int().positive(),
        bytes: z.number().int().positive(),
        sha256: sha256Schema,
      })
      .strict()
      .nullable()
      .optional(),
  })
  .passthrough();

const reconciliationSchema = z
  .object({
    schemaVersion: z.literal("elephant.bbb-reconciliation.v1"),
    county: countyKeySchema,
    sourceAccessStatus: z.literal("accessible"),
    sourceAccessComplete: z.literal(true),
    categoryCount: z.number().int().positive(),
    rawProfileCount: z.number().int().positive(),
    uniqueProfileCount: z.number().int().positive(),
    duplicateProfileCount: z.number().int().nonnegative(),
    profilesBytes: z.number().int().positive(),
    profilesSha256: sha256Schema,
    permanentFailureCount: z.number().int().nonnegative(),
    categories: z.array(
      z
        .object({
          categoryKey: countyKeySchema,
          profilesHarvested: z.number().int().nonnegative(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const sourceManifestSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_MANIFEST_SCHEMA_VERSION),
    county: countyKeySchema,
    linkedAt: z.string().datetime({ offset: true }),
    sourceAccessStatus: z.literal("accessible"),
    sourceAccessComplete: z.literal(true),
    categoryCount: z.number().int().positive(),
    uniqueProfileCount: z.number().int().positive(),
    officialIdentitySetCount: z.number().int().positive(),
    officialCompanyCount: z.number().int().positive(),
    acceptedCompanyMatchCount: z.number().int().positive(),
    acceptedPermitLinkCount: z.number().int().positive(),
    acceptedPropertyCount: z.number().int().positive(),
    reviewCandidateCount: z.number().int().nonnegative(),
    fuzzyAcceptedCount: z.number().int().nonnegative(),
    matchMethodCounts: z.record(z.string(), z.number().int().nonnegative()),
    everyAcceptedPropertyHasOfficialLinkedPermit: z.literal(true),
    bbbEstablishesLegalIdentity: z.literal(false),
    inputs: z
      .object({
        bbbProfilesSha256: sha256Schema,
        permitContractorEvidenceSha256: sha256Schema,
        permitWatermarkDigest: sha256Schema,
      })
      .strict(),
    artifacts: z
      .object({
        acceptedLinks: z
          .object({
            records: z.number().int().positive(),
            bytes: z.number().int().positive(),
            sha256: sha256Schema,
          })
          .strict(),
      })
      .passthrough(),
  })
  .passthrough();

const sourceLinkSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_LINK_SCHEMA_VERSION),
    county: countyKeySchema,
    property_id: z.string().uuid(),
    property_improvement_id: z.string().uuid(),
    official_company_request_identifier: z.string().min(1).max(500),
    official_license_identifiers: z
      .array(z.string().min(1).max(100))
      .default([]),
    bbb_business_id: z.string().min(1).max(500),
    bbb_profile_ids: z.array(z.string().min(1).max(500)).min(1),
    match_method: exactMatchMethodSchema,
    confidence: z.number().min(0).max(1),
    bbb_establishes_legal_identity: z.literal(false),
  })
  .passthrough();

const permitCompanyEvidenceSchema = z
  .object({
    schemaVersion: z.literal("oracle.bbb-permit-company-evidence.v1"),
    evidence_key: safeKeySchema,
    county: countyKeySchema,
    property_id: z.string().uuid(),
    property_improvement_id: z.string().uuid(),
    official_company_request_identifier: z.string().min(1).max(500),
    official_company_name: z.string().min(1).max(500).nullable().optional(),
    official_alternate_names: z.array(z.string().min(1).max(500)).default([]),
    official_phone_identifiers: z.array(z.string().min(1).max(100)).default([]),
    official_license_identifiers: z
      .array(z.string().min(1).max(100))
      .default([]),
    as_of: z.string().datetime({ offset: true }),
  })
  .strict();

type Handoff = z.infer<typeof handoffSchema>;
type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>;
type SourceLink = z.infer<typeof sourceLinkSchema>;
type PermitCompanyEvidence = z.infer<typeof permitCompanyEvidenceSchema>;

export type PrivateBbbAdapterResult = {
  readonly bundlePath: string;
  readonly adapterReceiptPath: string;
  readonly adapterReceiptSha256: string;
  readonly officialEvidenceSha256: string;
  readonly profileCount: number;
  readonly acceptedPropertyLinkCount: number;
};

export async function adaptOraclePrivateBbbHandoff(params: {
  readonly handoffPath: string;
  readonly outputDirectory: string;
}): Promise<PrivateBbbAdapterResult> {
  const absoluteHandoffPath = path.resolve(params.handoffPath);
  const handoffRoot = path.dirname(absoluteHandoffPath);
  const handoffBody = await readFile(absoluteHandoffPath, "utf8");
  const handoff = handoffSchema.parse(
    parseJson(handoffBody, absoluteHandoffPath),
  );

  const sourceManifestBody = await readVerifiedArtifact(
    handoffRoot,
    handoff.sourceManifest,
  );
  const sourceManifest = sourceManifestSchema.parse(
    parseJson(sourceManifestBody, "Oracle BBB source manifest"),
  );
  const reconciliationBody = await readVerifiedArtifact(
    handoffRoot,
    handoff.reconciliationManifest,
  );
  const reconciliation = reconciliationSchema.parse(
    parseJson(reconciliationBody, "Oracle BBB reconciliation manifest"),
  );
  const permitCoverageBody = await readVerifiedArtifact(
    handoffRoot,
    handoff.permitCoverage,
  );
  const permitCompanyEvidenceBody = await readVerifiedArtifact(
    handoffRoot,
    handoff.permitCompanyEvidence,
  );
  const permitCompanyEvidence = parseJsonLines(
    permitCompanyEvidenceBody,
    "permit-company evidence",
  ).map((value) => permitCompanyEvidenceSchema.parse(value));
  assertRecordCount(
    permitCompanyEvidenceBody,
    handoff.permitCompanyEvidence,
    "permit-company evidence",
  );
  const acceptedLinksBody = await readVerifiedArtifact(
    handoffRoot,
    handoff.acceptedLinks,
  );
  const acceptedLinks = parseJsonLines(acceptedLinksBody, "accepted links").map(
    (value) => sourceLinkSchema.parse(value),
  );
  assertRecordCount(acceptedLinksBody, handoff.acceptedLinks, "accepted links");

  validateSourceManifests({
    handoff,
    sourceManifest,
    reconciliation,
    permitCoverageBody,
    permitCompanyEvidence,
    acceptedLinks,
  });

  const outputRoot = path.resolve(params.outputDirectory);
  const reconciledProfiles = new Map<string, string>();
  let rawProfileCount = 0;
  const categoryReceipts: {
    readonly categoryKey: string;
    readonly summarySha256: string;
    readonly profileCount: number;
  }[] = [];
  for (const category of handoff.categories) {
    const sourceDirectory = resolveInside(
      handoffRoot,
      category.harvestDirectory,
    );
    const summaryPath = path.join(sourceDirectory, "manifest", "summary.json");
    const summaryBody = await readFile(summaryPath, "utf8");
    if (sha256(summaryBody) !== category.summarySha256) {
      throw new Error(
        `BBB category summary digest mismatch: ${category.categoryKey}`,
      );
    }
    const summary = categorySummarySchema.parse(
      parseJson(summaryBody, summaryPath),
    );
    if (
      summary.county !== handoff.countyKey ||
      summary.categoryKey !== category.categoryKey ||
      summary.sourceAccessStatus !== "accessible" ||
      !summary.completeWithinBounds ||
      summary.profilesFailedPermanent !== 0 ||
      summary.profilesHarvested !== category.profileCount
    ) {
      throw new Error(
        `BBB category coverage mismatch: ${category.categoryKey}`,
      );
    }
    let categoryProfileCount = 0;
    for (const part of summary.profileParts) {
      if (!part.relativePath.startsWith("profiles/")) {
        throw new Error(
          `BBB profile part is outside profiles/: ${part.relativePath}`,
        );
      }
      const partBody = await readVerifiedPart(sourceDirectory, part);
      const lines = nonemptyLines(partBody);
      categoryProfileCount += lines.length;
      rawProfileCount += lines.length;
      for (const line of lines) {
        const profile = parseJson(line, part.relativePath);
        const identity = profileIdentity(profile);
        if (!reconciledProfiles.has(identity)) {
          reconciledProfiles.set(identity, line);
        }
      }
      await writeOutput(
        outputRoot,
        path.join("harvest", category.categoryKey, part.relativePath),
        partBody,
      );
    }
    if (categoryProfileCount !== category.profileCount) {
      throw new Error(
        `BBB category profile count mismatch: ${category.categoryKey}`,
      );
    }
    if (summary.failurePart !== null && summary.failurePart !== undefined) {
      const failureBody = await readVerifiedPart(
        sourceDirectory,
        summary.failurePart,
      );
      await writeOutput(
        outputRoot,
        path.join(
          "harvest",
          category.categoryKey,
          summary.failurePart.relativePath,
        ),
        failureBody,
      );
    }
    await writeOutput(
      outputRoot,
      path.join("harvest", category.categoryKey, "manifest", "summary.json"),
      summaryBody,
    );
    categoryReceipts.push({
      categoryKey: category.categoryKey,
      summarySha256: category.summarySha256,
      profileCount: category.profileCount,
    });
  }

  const reconciledBody =
    [...reconciledProfiles.values()].join("\n") +
    (reconciledProfiles.size > 0 ? "\n" : "");
  if (
    rawProfileCount !== reconciliation.rawProfileCount ||
    reconciledProfiles.size !== reconciliation.uniqueProfileCount ||
    rawProfileCount - reconciledProfiles.size !==
      reconciliation.duplicateProfileCount ||
    Buffer.byteLength(reconciledBody) !== reconciliation.profilesBytes ||
    sha256(reconciledBody) !== reconciliation.profilesSha256 ||
    reconciliation.uniqueProfileCount !== handoff.expectations.profileCount ||
    reconciliation.profilesSha256 !== handoff.expectations.profilesSha256
  ) {
    throw new Error(
      "BBB profile coverage or reconciled profile digest is incomplete",
    );
  }

  const acceptedLinksByEvidenceKey = new Map(
    acceptedLinks.map((link) => [permitCompanyTuple(link), link]),
  );
  const officialEvidenceBody =
    permitCompanyEvidence
      .map((evidence) =>
        JSON.stringify(
          toOfficialEvidence(
            evidence,
            acceptedLinksByEvidenceKey.get(permitCompanyTuple(evidence)),
          ),
        ),
      )
      .join("\n") + "\n";
  const officialEvidenceSha256 = sha256(officialEvidenceBody);
  await writeOutput(
    outputRoot,
    path.join("private", "official-evidence.jsonl"),
    officialEvidenceBody,
  );
  await writeOutput(
    outputRoot,
    path.join("reconciled", "bbb-reconciliation-manifest.json"),
    reconciliationBody,
  );

  const adapterReceipt = {
    schemaVersion: ADAPTER_RECEIPT_SCHEMA_VERSION,
    countyKey: handoff.countyKey,
    runId: handoff.runId,
    sourceManifestSha256: handoff.sourceManifest.sha256,
    reconciliationManifestSha256: handoff.reconciliationManifest.sha256,
    profilesSha256: reconciliation.profilesSha256,
    permitCoverageSha256: handoff.permitCoverage.sha256,
    permitCompanyEvidenceSha256: handoff.permitCompanyEvidence.sha256,
    acceptedLinksSha256: handoff.acceptedLinks.sha256,
    officialEvidenceSha256,
    permitWatermarkDigest: handoff.expectations.permitWatermarkDigest,
    sourceAccessComplete: true,
    profileCount: reconciliation.uniqueProfileCount,
    officialIdentityCount: handoff.expectations.officialIdentityCount,
    officialCompanyCount: handoff.expectations.officialCompanyCount,
    categories: categoryReceipts,
    acceptedPropertyLinkCount: handoff.expectations.acceptedPropertyLinkCount,
    reviewCandidateCount: 0,
    fuzzyAcceptedCount: 0,
    matchMethodCounts: handoff.expectations.matchMethodCounts,
  } as const;
  const adapterReceiptBody = `${JSON.stringify(adapterReceipt, null, 2)}\n`;
  const adapterReceiptSha256 = sha256(adapterReceiptBody);
  await writeOutput(outputRoot, "adapter-receipt.json", adapterReceiptBody);

  const bundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    countyKey: handoff.countyKey,
    runId: handoff.runId,
    reconciliationManifest: "reconciled/bbb-reconciliation-manifest.json",
    categories: handoff.categories.map((category) => ({
      categoryKey: category.categoryKey,
      harvestDirectory: `harvest/${category.categoryKey}`,
    })),
    officialPermitCompanyEvidence: "private/official-evidence.jsonl",
    oracleAdapterReceipt: {
      relativePath: "adapter-receipt.json",
      sha256: adapterReceiptSha256,
    },
  };
  const bundlePath = path.join(outputRoot, "bundle.json");
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);

  return {
    bundlePath,
    adapterReceiptPath: path.join(outputRoot, "adapter-receipt.json"),
    adapterReceiptSha256,
    officialEvidenceSha256,
    profileCount: reconciliation.uniqueProfileCount,
    acceptedPropertyLinkCount: handoff.expectations.acceptedPropertyLinkCount,
  };
}

function validateSourceManifests(params: {
  readonly handoff: Handoff;
  readonly sourceManifest: z.infer<typeof sourceManifestSchema>;
  readonly reconciliation: z.infer<typeof reconciliationSchema>;
  readonly permitCoverageBody: string;
  readonly permitCompanyEvidence: readonly PermitCompanyEvidence[];
  readonly acceptedLinks: readonly SourceLink[];
}): void {
  const expected = params.handoff.expectations;
  const matchMethodCounts = {
    exact_state_license:
      params.sourceManifest.matchMethodCounts.exact_state_license ?? 0,
    exact_standardized_phone:
      params.sourceManifest.matchMethodCounts.exact_standardized_phone ?? 0,
    unique_exact_normalized_business_name:
      params.sourceManifest.matchMethodCounts
        .unique_exact_normalized_business_name ?? 0,
  };
  const exactMatchMethods = new Set(Object.keys(matchMethodCounts));
  const hasUnexpectedMatchTier = Object.entries(
    params.sourceManifest.matchMethodCounts,
  ).some(([method, count]) => !exactMatchMethods.has(method) && count !== 0);
  if (
    params.sourceManifest.county !== params.handoff.countyKey ||
    params.reconciliation.county !== params.handoff.countyKey ||
    params.sourceManifest.categoryCount !== params.handoff.categories.length ||
    params.reconciliation.categoryCount !== params.handoff.categories.length ||
    params.sourceManifest.uniqueProfileCount !== expected.profileCount ||
    params.sourceManifest.officialIdentitySetCount !==
      expected.officialIdentityCount ||
    params.sourceManifest.officialCompanyCount !==
      expected.officialCompanyCount ||
    params.sourceManifest.inputs.bbbProfilesSha256 !==
      expected.profilesSha256 ||
    params.sourceManifest.inputs.permitContractorEvidenceSha256 !==
      params.handoff.permitCompanyEvidence.sha256 ||
    params.sourceManifest.inputs.permitWatermarkDigest !==
      expected.permitWatermarkDigest ||
    params.sourceManifest.acceptedCompanyMatchCount !==
      expected.acceptedPropertyLinkCount ||
    params.sourceManifest.acceptedPermitLinkCount !==
      expected.acceptedPropertyLinkCount ||
    params.sourceManifest.acceptedPropertyCount !==
      expected.acceptedPropertyLinkCount ||
    params.sourceManifest.reviewCandidateCount !==
      expected.reviewCandidateCount ||
    params.sourceManifest.fuzzyAcceptedCount !== expected.fuzzyAcceptedCount ||
    hasUnexpectedMatchTier ||
    stableJsonStringify(matchMethodCounts) !==
      stableJsonStringify(expected.matchMethodCounts) ||
    params.sourceManifest.artifacts.acceptedLinks.records !==
      params.handoff.acceptedLinks.records ||
    params.sourceManifest.artifacts.acceptedLinks.bytes !==
      params.handoff.acceptedLinks.bytes ||
    params.sourceManifest.artifacts.acceptedLinks.sha256 !==
      params.handoff.acceptedLinks.sha256 ||
    params.permitCompanyEvidence.length !== expected.officialIdentityCount ||
    params.acceptedLinks.length !== expected.acceptedPropertyLinkCount
  ) {
    throw new Error("Oracle BBB source manifest does not match the handoff");
  }
  const actualMethodCounts = {
    exact_state_license: 0,
    exact_standardized_phone: 0,
    unique_exact_normalized_business_name: 0,
  };
  const evidenceKeys = params.permitCompanyEvidence.map(
    (evidence) => evidence.evidence_key,
  );
  const evidenceTuples = params.permitCompanyEvidence.map(permitCompanyTuple);
  const officialCompanies = new Set(
    params.permitCompanyEvidence.map(
      (evidence) => evidence.official_company_request_identifier,
    ),
  );
  if (
    new Set(evidenceKeys).size !== evidenceKeys.length ||
    new Set(evidenceTuples).size !== evidenceTuples.length ||
    officialCompanies.size !== expected.officialCompanyCount
  ) {
    throw new Error(
      "Oracle BBB permit-company evidence is duplicated or incomplete",
    );
  }
  const evidenceByTuple = new Map(
    params.permitCompanyEvidence.map((evidence) => [
      permitCompanyTuple(evidence),
      evidence,
    ]),
  );
  const acceptedTuples = new Set<string>();
  for (const link of params.acceptedLinks) {
    if (link.county !== params.handoff.countyKey) {
      throw new Error("Oracle BBB accepted-link county mismatch");
    }
    const tuple = permitCompanyTuple(link);
    const evidence = evidenceByTuple.get(tuple);
    if (
      evidence === undefined ||
      acceptedTuples.has(tuple) ||
      stableJsonStringify([...link.official_license_identifiers].sort()) !==
        stableJsonStringify([...evidence.official_license_identifiers].sort())
    ) {
      throw new Error(
        "Oracle BBB accepted link does not match unique permit-company evidence",
      );
    }
    acceptedTuples.add(tuple);
    actualMethodCounts[link.match_method] += 1;
  }
  if (
    stableJsonStringify(actualMethodCounts) !==
    stableJsonStringify(expected.matchMethodCounts)
  ) {
    throw new Error("Oracle BBB accepted-link tiers do not match the handoff");
  }

  const coverage = parseJson(params.permitCoverageBody, "permit coverage") as {
    readonly county?: unknown;
    readonly datasets?: readonly Record<string, unknown>[];
  };
  const permits = Array.isArray(coverage.datasets)
    ? coverage.datasets.find((dataset) => dataset.source === "permits")
    : undefined;
  if (
    coverage.county !== params.handoff.countyKey ||
    permits?.watermark_digest !== expected.permitWatermarkDigest ||
    permits.expected_count !== permits.ingested_count ||
    permits.valid_unlinked_permit_count !== 0 ||
    permits.excluded_source_record_count !== 0
  ) {
    throw new Error("Oracle BBB permit coverage or watermark is incomplete");
  }
}

function toOfficialEvidence(
  evidence: PermitCompanyEvidence,
  acceptedLink: SourceLink | undefined,
): Record<string, unknown> {
  const sourceEvidenceSha256 = sha256(stableJsonStringify(evidence));
  return {
    schemaVersion: OFFICIAL_EVIDENCE_SCHEMA_VERSION,
    evidenceKey: evidence.evidence_key,
    permit: {
      propertyImprovementId: evidence.property_improvement_id,
      propertyId: evidence.property_id,
    },
    company: {
      requestIdentifier: evidence.official_company_request_identifier,
    },
    contractor: {
      name: evidence.official_company_name ?? null,
      alternateNames: evidence.official_alternate_names,
      phones: evidence.official_phone_identifiers,
      licenseIdentifiers: evidence.official_license_identifiers,
    },
    ...(acceptedLink === undefined
      ? {}
      : {
          expectedMatch: {
            providerBusinessKey: acceptedLink.bbb_business_id,
            providerProfileKeys: [...acceptedLink.bbb_profile_ids].sort(),
            method: acceptedLink.match_method,
            confidence: acceptedLink.confidence,
          },
        }),
    asOf: evidence.as_of,
    sourceEvidenceSha256,
  };
}

function permitCompanyTuple(
  value:
    | SourceLink
    | Pick<
        PermitCompanyEvidence,
        | "property_id"
        | "property_improvement_id"
        | "official_company_request_identifier"
      >,
): string {
  return [
    value.property_id,
    value.property_improvement_id,
    value.official_company_request_identifier,
  ].join("\u0000");
}

async function readVerifiedArtifact(
  root: string,
  receipt: ArtifactReceipt,
): Promise<string> {
  const body = await readFile(
    resolveInside(root, receipt.relativePath),
    "utf8",
  );
  if (
    Buffer.byteLength(body) !== receipt.bytes ||
    sha256(body) !== receipt.sha256
  ) {
    throw new Error(`Artifact integrity failure: ${receipt.relativePath}`);
  }
  return body;
}

async function readVerifiedPart(
  root: string,
  receipt: {
    readonly relativePath: string;
    readonly recordCount: number;
    readonly bytes: number;
    readonly sha256: string;
  },
): Promise<string> {
  const body = await readFile(
    resolveInside(root, receipt.relativePath),
    "utf8",
  );
  if (
    Buffer.byteLength(body) !== receipt.bytes ||
    sha256(body) !== receipt.sha256 ||
    nonemptyLines(body).length !== receipt.recordCount
  ) {
    throw new Error(`BBB part integrity failure: ${receipt.relativePath}`);
  }
  return body;
}

function assertRecordCount(
  body: string,
  receipt: ArtifactReceipt,
  label: string,
): void {
  if (
    receipt.records === undefined ||
    nonemptyLines(body).length !== receipt.records
  ) {
    throw new Error(`${label} record count does not match its receipt`);
  }
}

async function writeOutput(
  outputRoot: string,
  relativePath: string,
  body: string,
): Promise<void> {
  const outputPath = resolveInside(outputRoot, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body);
}

function profileIdentity(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("BBB profile must be a JSON object");
  }
  const profile = value as Record<string, unknown>;
  for (const key of [
    "providerProfileId",
    "provider_profile_id",
    "profileUrl",
    "profile_url",
  ]) {
    const candidate = profile[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  throw new Error("BBB profile is missing a stable profile identity");
}

function parseJsonLines(body: string, label: string): readonly unknown[] {
  return nonemptyLines(body).map((line) => parseJson(line, label));
}

function nonemptyLines(body: string): readonly string[] {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes root: ${relativePath}`);
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
