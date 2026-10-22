import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adaptOraclePrivateBbbHandoff } from "../src/loader/private-bbb-adapter.js";
import { parsePrivateBbbAdapterArgs } from "../scripts/prepare-private-bbb-bundle.js";

const FIXED_TIME = "2026-10-21T21:03:33.326Z";
const PERMIT_WATERMARK = "3".repeat(64);
const directories: string[] = [];

describe("Oracle private BBB bundle adapter", () => {
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("adapts a content-addressed synthetic Lake 37-profile/3-link handoff", async () => {
    const fixture = await writeSyntheticHandoff();
    const result = await adaptOraclePrivateBbbHandoff({
      handoffPath: fixture.handoffPath,
      outputDirectory: fixture.outputDirectory,
    });

    expect(result).toMatchObject({
      profileCount: 37,
      acceptedPropertyLinkCount: 3,
    });
    const bundle = JSON.parse(await readFile(result.bundlePath, "utf8")) as {
      readonly countyKey: string;
      readonly runId: string;
      readonly oracleAdapterReceipt: {
        readonly sha256: string;
      };
    };
    expect(bundle).toMatchObject({
      countyKey: "lake",
      runId: "lake-bbb-full-synthetic-v1",
    });
    expect(bundle.oracleAdapterReceipt.sha256).toBe(
      result.adapterReceiptSha256,
    );

    const receiptBody = await readFile(result.adapterReceiptPath, "utf8");
    expect(receiptBody).not.toContain("property_improvement_id");
    expect(receiptBody).not.toContain("official_company_request_identifier");
    expect(JSON.parse(receiptBody)).toMatchObject({
      profileCount: 37,
      acceptedPropertyLinkCount: 3,
      reviewCandidateCount: 0,
      fuzzyAcceptedCount: 0,
      permitWatermarkDigest: PERMIT_WATERMARK,
      matchMethodCounts: {
        exact_state_license: 0,
        exact_standardized_phone: 0,
        unique_exact_normalized_business_name: 3,
      },
    });
    const officialEvidence = (
      await readFile(
        path.join(
          fixture.outputDirectory,
          "private",
          "official-evidence.jsonl",
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(officialEvidence).toHaveLength(3);
    expect(
      officialEvidence.every(
        (row) =>
          row.schemaVersion ===
          "elephant.bbb-official-permit-company-evidence.v2",
      ),
    ).toBe(true);
  });

  it("rejects a corrected artifact whose content no longer matches its digest", async () => {
    const fixture = await writeSyntheticHandoff();
    await writeFile(fixture.firstProfilePart, '{"corrected":true}\n');
    await expect(
      adaptOraclePrivateBbbHandoff({
        handoffPath: fixture.handoffPath,
        outputDirectory: fixture.outputDirectory,
      }),
    ).rejects.toThrow(/part integrity failure/u);
  });

  it("rejects incomplete coverage and permit watermark drift", async () => {
    const incomplete = await writeSyntheticHandoff({
      sourceAccessComplete: false,
    });
    await expect(
      adaptOraclePrivateBbbHandoff({
        handoffPath: incomplete.handoffPath,
        outputDirectory: incomplete.outputDirectory,
      }),
    ).rejects.toThrow();

    const wrongWatermark = await writeSyntheticHandoff({
      coverageWatermark: "4".repeat(64),
    });
    await expect(
      adaptOraclePrivateBbbHandoff({
        handoffPath: wrongWatermark.handoffPath,
        outputDirectory: wrongWatermark.outputDirectory,
      }),
    ).rejects.toThrow(/coverage or watermark is incomplete/u);
  });

  it("rejects fuzzy accepted links instead of adapting them", async () => {
    const fixture = await writeSyntheticHandoff({
      fuzzyAcceptedLink: true,
    });
    await expect(
      adaptOraclePrivateBbbHandoff({
        handoffPath: fixture.handoffPath,
        outputDirectory: fixture.outputDirectory,
      }),
    ).rejects.toThrow();
  });

  it("requires explicit adapter input and output paths", () => {
    expect(
      parsePrivateBbbAdapterArgs([
        "--handoff",
        "/private/handoff.json",
        "--output-dir",
        "/private/output",
      ]),
    ).toEqual({
      handoffPath: "/private/handoff.json",
      outputDirectory: "/private/output",
    });
    expect(() => parsePrivateBbbAdapterArgs([])).toThrow(/--handoff/u);
  });
});

async function writeSyntheticHandoff(
  options: {
    readonly sourceAccessComplete?: boolean;
    readonly coverageWatermark?: string;
    readonly fuzzyAcceptedLink?: boolean;
  } = {},
): Promise<{
  readonly handoffPath: string;
  readonly outputDirectory: string;
  readonly firstProfilePart: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "query-db-bbb-adapter-"));
  directories.push(root);
  const inputRoot = path.join(root, "input");
  const outputDirectory = path.join(root, "output");
  const categoryDefinitions = [
    { key: "roofing-contractors", count: 18 },
    { key: "air-conditioning-repair", count: 19 },
  ] as const;
  const categories: {
    readonly categoryKey: string;
    readonly harvestDirectory: string;
    readonly summarySha256: string;
    readonly profileCount: number;
  }[] = [];
  const reconciledLines: string[] = [];
  let firstProfilePart = "";
  let profileIndex = 0;
  for (const category of categoryDefinitions) {
    const profiles = Array.from({ length: category.count }, () => {
      profileIndex += 1;
      const accepted = profileIndex <= 3;
      return {
        recordKind: "bbb_business_profile",
        schemaVersion: "elephant.bbb-category-harvest.v1",
        source: "bbb-public-browser",
        sourceRetrievedAt: FIXED_TIME,
        providerProfileId: `0733:profile-${profileIndex}`,
        providerBusinessId: accepted
          ? `accepted-${profileIndex}`
          : `unmatched-${profileIndex}`,
        providerBbbId: "0733",
        profileUrl: `https://www.bbb.org/us/fl/leesburg/profile/contractor/synthetic-${profileIndex}`,
        name: accepted
          ? `Synthetic Accepted ${profileIndex} LLC`
          : `Synthetic Unmatched ${profileIndex} LLC`,
        legalName: accepted
          ? `Synthetic Accepted ${profileIndex} LLC`
          : `Synthetic Unmatched ${profileIndex} LLC`,
        accredited: true,
        bbbRating: "A+",
        reviewsComplaintsSummary: {
          reviewsTotal: 0,
          complaintsTotal: 0,
        },
      };
    });
    const profileBody = `${profiles
      .map((profile) => JSON.stringify(profile))
      .join("\n")}\n`;
    reconciledLines.push(...profileBody.trim().split("\n"));
    const harvestDirectory = path.join("harvest", category.key);
    const absoluteHarvestDirectory = path.join(inputRoot, harvestDirectory);
    const profileRelativePath = "profiles/profiles-part-0001.jsonl";
    const profilePath = path.join(
      absoluteHarvestDirectory,
      profileRelativePath,
    );
    if (firstProfilePart.length === 0) firstProfilePart = profilePath;
    await mkdir(path.dirname(profilePath), { recursive: true });
    await writeFile(profilePath, profileBody);
    const summary = {
      schemaVersion: "elephant.bbb-category-harvest.v1",
      jobId: `synthetic-${category.key}`,
      county: "lake",
      source: "bbb-public-browser",
      categoryKey: category.key,
      categoryUrl: `https://www.bbb.org/us/fl/leesburg/category/${category.key}`,
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      advertisedResults: category.count,
      categoryPagesVisited: 1,
      profileUrlsDiscovered: category.count,
      profilesSelected: category.count,
      profilesHarvested: category.count,
      profilesFailedPermanent: 0,
      requestSha256: sha256(`request:${category.key}`),
      completeWithinBounds: true,
      sourceAccessStatus: "accessible",
      profileParts: [
        {
          relativePath: profileRelativePath,
          recordCount: category.count,
          bytes: Buffer.byteLength(profileBody),
          sha256: sha256(profileBody),
        },
      ],
      failurePart: null,
    };
    const summaryBody = `${JSON.stringify(summary, null, 2)}\n`;
    await mkdir(path.join(absoluteHarvestDirectory, "manifest"), {
      recursive: true,
    });
    await writeFile(
      path.join(absoluteHarvestDirectory, "manifest", "summary.json"),
      summaryBody,
    );
    categories.push({
      categoryKey: category.key,
      harvestDirectory,
      summarySha256: sha256(summaryBody),
      profileCount: category.count,
    });
  }

  const reconciledBody = `${reconciledLines.join("\n")}\n`;
  const reconciliation = {
    schemaVersion: "elephant.bbb-reconciliation.v1",
    county: "lake",
    reconciledAt: FIXED_TIME,
    categoryCount: 2,
    categories: categories.map((category) => ({
      categoryKey: category.categoryKey,
      profilesSelected: category.profileCount,
      profilesHarvested: category.profileCount,
      profilesFailedPermanent: 0,
      requestSha256: sha256(`request:${category.categoryKey}`),
      sourceAccessStatus: "accessible",
    })),
    rawProfileCount: 37,
    uniqueProfileCount: 37,
    duplicateProfileCount: 0,
    sourceAccessStatus: "accessible",
    sourceAccessComplete: true,
    profilesBytes: Buffer.byteLength(reconciledBody),
    profilesSha256: sha256(reconciledBody),
    permanentFailureCount: 0,
  };
  const reconciliationBody = `${JSON.stringify(reconciliation, null, 2)}\n`;
  const reconciliationPath = path.join(
    inputRoot,
    "reconciled",
    "bbb-reconciliation-manifest.json",
  );
  await mkdir(path.dirname(reconciliationPath), { recursive: true });
  await writeFile(reconciliationPath, reconciliationBody);

  const permitCompanyEvidenceBody =
    [1, 2, 3]
      .map((index) =>
        JSON.stringify({
          schemaVersion: "oracle.bbb-permit-company-evidence.v1",
          evidence_key: `synthetic-evidence-${index}`,
          county: "lake",
          property_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          property_improvement_id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          official_company_request_identifier: `synthetic-company-${index}`,
          official_company_name: `Synthetic Accepted ${index} LLC`,
          official_alternate_names: [],
          official_phone_identifiers: [],
          official_license_identifiers: [],
          as_of: FIXED_TIME,
        }),
      )
      .join("\n") + "\n";
  const permitCompanyEvidencePath = path.join(
    inputRoot,
    "private",
    "permit-company-evidence.jsonl",
  );
  await mkdir(path.dirname(permitCompanyEvidencePath), { recursive: true });
  await writeFile(permitCompanyEvidencePath, permitCompanyEvidenceBody);

  const acceptedLinks = [1, 2, 3].map((index) => ({
    schemaVersion: "oracle.bbb-official-permit-link.v1",
    county: "lake",
    property_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    property_improvement_id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    official_company_request_identifier: `synthetic-company-${index}`,
    official_license_identifiers: [],
    bbb_business_id: `0733:accepted-${index}`,
    bbb_profile_ids: [`0733:profile-${index}`],
    bbb_profile_urls: [
      `https://www.bbb.org/us/fl/leesburg/profile/contractor/synthetic-${index}`,
    ],
    match_method:
      options.fuzzyAcceptedLink === true && index === 1
        ? "jaro_winkler_cleaned_business_name"
        : "unique_exact_normalized_business_name",
    confidence: options.fuzzyAcceptedLink === true && index === 1 ? 0.92 : 0.8,
    legal_identity_source: "synthetic-official-evidence",
    bbb_establishes_legal_identity: false,
  }));
  const acceptedLinksBody = `${acceptedLinks
    .map((link) => JSON.stringify(link))
    .join("\n")}\n`;
  const acceptedLinksPath = path.join(
    inputRoot,
    "private",
    "accepted-links.jsonl",
  );
  await writeFile(acceptedLinksPath, acceptedLinksBody);

  const coverage = {
    county: "lake",
    exportedAt: FIXED_TIME,
    scope: "synthetic_lake_bbb",
    datasets: [
      {
        county: "lake",
        source: "permits",
        expected_count: 3,
        ingested_count: 3,
        linked_property_count: 3,
        valid_unlinked_permit_count: 0,
        excluded_source_record_count: 0,
        watermark_digest: options.coverageWatermark ?? PERMIT_WATERMARK,
      },
    ],
  };
  const coverageBody = `${JSON.stringify(coverage, null, 2)}\n`;
  const coveragePath = path.join(inputRoot, "coverage.json");
  await writeFile(coveragePath, coverageBody);

  const sourceManifest = {
    schemaVersion: "oracle.bbb-official-permit-linkage.v1",
    county: "lake",
    linkedAt: FIXED_TIME,
    sourceAccessStatus: "accessible",
    sourceAccessComplete: options.sourceAccessComplete ?? true,
    categoryCount: 2,
    uniqueProfileCount: 37,
    officialIdentitySetCount: 3,
    officialCompanyCount: 3,
    acceptedCompanyMatchCount: 3,
    acceptedPermitLinkCount: 3,
    acceptedPropertyCount: 3,
    reviewCandidateCount: 0,
    fuzzyAcceptedCount: 0,
    matchMethodCounts: {
      unique_exact_normalized_business_name: 3,
    },
    everyAcceptedPropertyHasOfficialLinkedPermit: true,
    bbbEstablishesLegalIdentity: false,
    inputs: {
      bbbProfilesSha256: reconciliation.profilesSha256,
      permitContractorEvidenceSha256: sha256(permitCompanyEvidenceBody),
      permitWatermarkDigest: PERMIT_WATERMARK,
    },
    artifacts: {
      acceptedLinks: {
        records: 3,
        bytes: Buffer.byteLength(acceptedLinksBody),
        sha256: sha256(acceptedLinksBody),
      },
    },
  };
  const sourceManifestBody = `${JSON.stringify(sourceManifest, null, 2)}\n`;
  const sourceManifestPath = path.join(inputRoot, "source-manifest.json");
  await writeFile(sourceManifestPath, sourceManifestBody);

  const handoff = {
    schemaVersion: "oracle.bbb-private-loader-handoff.v1",
    countyKey: "lake",
    runId: "lake-bbb-full-synthetic-v1",
    sourceManifest: receipt("source-manifest.json", sourceManifestBody),
    reconciliationManifest: receipt(
      "reconciled/bbb-reconciliation-manifest.json",
      reconciliationBody,
    ),
    permitCoverage: receipt("coverage.json", coverageBody),
    permitCompanyEvidence: {
      ...receipt(
        "private/permit-company-evidence.jsonl",
        permitCompanyEvidenceBody,
      ),
      records: 3,
    },
    acceptedLinks: {
      ...receipt("private/accepted-links.jsonl", acceptedLinksBody),
      records: 3,
    },
    categories,
    expectations: {
      sourceAccessComplete: true,
      profileCount: 37,
      officialIdentityCount: 3,
      officialCompanyCount: 3,
      profilesSha256: reconciliation.profilesSha256,
      acceptedPropertyLinkCount: 3,
      reviewCandidateCount: 0,
      fuzzyAcceptedCount: 0,
      matchMethodCounts: {
        exact_state_license: 0,
        exact_standardized_phone: 0,
        unique_exact_normalized_business_name: 3,
      },
      permitWatermarkDigest: PERMIT_WATERMARK,
    },
  };
  const handoffPath = path.join(inputRoot, "handoff.json");
  await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
  return { handoffPath, outputDirectory, firstProfilePart };
}

function receipt(
  relativePath: string,
  body: string,
): {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
} {
  return {
    relativePath,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
