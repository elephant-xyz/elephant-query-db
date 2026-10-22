import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPrivateBbbBundle } from "../src/loader/private-bbb.js";

const TEST_DATABASE_URL = process.env.PRIVATE_BBB_TEST_DATABASE_URL;
const describePostgres =
  TEST_DATABASE_URL === undefined ? describe.skip : describe;

type SyntheticProfile = {
  readonly recordKind: "bbb_business_profile";
  readonly schemaVersion: "elephant.bbb-category-harvest.v1";
  readonly source: "bbb-public-browser";
  readonly sourceRetrievedAt: string;
  readonly providerProfileId: string;
  readonly providerBusinessId: string;
  readonly providerBbbId: string;
  readonly profileUrl: string;
  readonly name: string;
  readonly legalName: string;
  readonly phone?: string;
  readonly licenses?: readonly { readonly rawText: string }[];
  readonly accredited: boolean;
  readonly bbbRating: string;
  readonly reviewsComplaintsSummary: {
    readonly reviewsTotal: number;
    readonly complaintsTotal: number;
  };
  readonly bbbHarvest: {
    readonly mainPage: { readonly html: string };
  };
};

type CategoryFixture = {
  readonly key: string;
  readonly profiles: readonly SyntheticProfile[];
  readonly sourceAccessStatus?: "accessible" | "blocked";
};

type FixtureIds = {
  readonly acceptedCompanyId: string;
  readonly companyCount: number;
  readonly resolverState: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
};

const fixtureDirectories: string[] = [];
const RUN_ID = "lake-private-bbb-test-v1";
const FIXED_TIME = "2026-10-21T21:03:33.326Z";
const RAW_HTML_MARKER = "PRIVATE-RAW-HTML-MUST-NOT-PERSIST";

let pool: Pool;
let fixture: FixtureIds;

describePostgres("private BBB Postgres persistence", () => {
  beforeAll(async () => {
    const databaseUrl = requireLocalTestDatabaseUrl();
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await resetAndMigrate(pool);
    fixture = await seedOfficialPermitEvidence(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await Promise.all(
      fixtureDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("loads, replays, corrects, tombstones, and fails closed on blocked coverage", async () => {
    const profiles = syntheticProfiles();
    const duplicatedEvidence = [...fixture.evidence, fixture.evidence[0]!];
    const initialBundle = await writeBundle({
      directoryLabel: "initial",
      runId: RUN_ID,
      categories: [
        { key: "roofing-contractors", profiles },
        { key: "air-conditioning-repair", profiles: [profiles[0]!] },
      ],
      officialEvidence: duplicatedEvidence,
    });

    const initial = await loadPrivateBbbBundle({
      pool,
      bundlePath: initialBundle,
      now: FIXED_TIME,
    });
    expect(initial).toMatchObject({
      profileCount: 6,
      sourceAccessStatus: "accessible",
      sourceAccessComplete: true,
      insertedSnapshots: 6,
      insertedMemberships: 7,
      acceptedMatchCount: 3,
      reviewCandidateCount: 1,
      ambiguousCandidateCount: 2,
      unmatchedCount: 1,
      acceptedPropertyLinkCount: 3,
      replayed: false,
    });
    expect(initial.changedRows).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          `SELECT
             "raw_profile_count",
             "unique_profile_count",
             "duplicate_profile_count"
           FROM "bbb_harvest_runs"
           WHERE "county_key" = 'lake' AND "run_id" = $1`,
          [RUN_ID],
        )
      ).rows,
    ).toEqual([
      {
        raw_profile_count: 7,
        unique_profile_count: 6,
        duplicate_profile_count: 1,
      },
    ]);

    const matchRows = await pool.query<{
      readonly outcome: string;
      readonly match_method: string | null;
    }>(
      `SELECT "outcome", "match_method"
         FROM "bbb_reconciliation_matches"
         ORDER BY "outcome", "match_method" NULLS LAST`,
    );
    expect(
      matchRows.rows
        .filter((row) => row.outcome === "accepted")
        .map((row) => row.match_method)
        .sort(),
    ).toEqual([
      "exact_standardized_phone",
      "exact_state_license",
      "unique_exact_normalized_business_name",
    ]);
    expect(
      matchRows.rows.filter(
        (row) => row.match_method === "jaro_winkler_cleaned_business_name",
      ),
    ).toEqual([
      {
        outcome: "review",
        match_method: "jaro_winkler_cleaned_business_name",
      },
    ]);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*) FROM "bbb_property_link_evidence"`,
      ),
    ).toBe(3);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*)
           FROM "bbb_profile_snapshots"
           WHERE "extracted_payload"::text LIKE $1`,
        [`%${RAW_HTML_MARKER}%`],
      ),
    ).toBe(0);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*) FROM "business_reputation_profiles"`,
      ),
    ).toBe(0);
    expect(await scalarCount(pool, `SELECT count(*) FROM "companies"`)).toBe(
      fixture.companyCount,
    );

    const replay = await loadPrivateBbbBundle({
      pool,
      bundlePath: initialBundle,
      now: FIXED_TIME,
    });
    expect(replay).toMatchObject({
      changedRows: 0,
      insertedSnapshots: 0,
      insertedMemberships: 0,
      retiredMemberships: 0,
      replayed: true,
    });

    const correctedProfiles = profiles
      .filter((profile) => profile.providerBusinessId !== "exact-name")
      .map((profile) =>
        profile.providerBusinessId === "license"
          ? { ...profile, bbbRating: "A" }
          : profile,
      );
    const correctedBundle = await writeBundle({
      directoryLabel: "corrected",
      runId: RUN_ID,
      categories: [
        { key: "roofing-contractors", profiles: correctedProfiles },
        { key: "air-conditioning-repair", profiles: [profiles[0]!] },
      ],
      officialEvidence: duplicatedEvidence,
    });
    const corrected = await loadPrivateBbbBundle({
      pool,
      bundlePath: correctedBundle,
      now: "2026-10-22T12:00:00.000Z",
    });
    expect(corrected).toMatchObject({
      profileCount: 5,
      acceptedMatchCount: 2,
      reviewCandidateCount: 1,
      ambiguousCandidateCount: 2,
      unmatchedCount: 2,
      acceptedPropertyLinkCount: 2,
      insertedSnapshots: 1,
      insertedMemberships: 5,
      retiredMemberships: 6,
      replayed: false,
    });
    expect(
      await scalarCount(pool, `SELECT count(*) FROM "bbb_profile_snapshots"`),
    ).toBe(7);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*)
           FROM "bbb_profile_category_memberships"
           WHERE "is_current" = true`,
      ),
    ).toBe(6);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*)
           FROM "bbb_profile_category_memberships"
           WHERE "retirement_reason" = 'missing_from_corrected_artifact'`,
      ),
    ).toBe(1);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*)
           FROM "bbb_artifact_watermarks"
           WHERE "previous_artifact_sha256" IS NOT NULL`,
      ),
    ).toBe(1);

    const restored = await loadPrivateBbbBundle({
      pool,
      bundlePath: initialBundle,
      now: "2026-10-22T13:00:00.000Z",
    });
    expect(restored).toMatchObject({
      profileCount: 6,
      acceptedMatchCount: 3,
      acceptedPropertyLinkCount: 3,
      insertedSnapshots: 0,
      insertedMemberships: 6,
      retiredMemberships: 5,
      replayed: false,
    });
    expect(
      await scalarCount(
        pool,
        `SELECT count(*)
         FROM "bbb_profile_category_memberships"
         WHERE "is_current" = true`,
      ),
    ).toBe(7);

    const blockedBundle = await writeBundle({
      directoryLabel: "blocked",
      runId: "lake-private-bbb-blocked-v2",
      categories: [
        {
          key: "roofing-contractors",
          profiles: [],
          sourceAccessStatus: "blocked",
        },
      ],
      officialEvidence: duplicatedEvidence,
    });
    const blocked = await loadPrivateBbbBundle({
      pool,
      bundlePath: blockedBundle,
      now: "2026-10-23T12:00:00.000Z",
    });
    expect(blocked).toMatchObject({
      sourceAccessStatus: "blocked",
      sourceAccessComplete: false,
      profileCount: 0,
      acceptedMatchCount: 0,
      reviewCandidateCount: 0,
      ambiguousCandidateCount: 0,
      unmatchedCount: 6,
      acceptedPropertyLinkCount: 0,
    });
    const currentCoverage = await pool.query<{
      readonly source_access_status: string;
      readonly source_access_complete: boolean;
      readonly reconciliation_status: string;
    }>(
      `SELECT
           harvest."source_access_status",
           harvest."source_access_complete",
           reconciliation."status" AS "reconciliation_status"
         FROM "bbb_harvest_runs" harvest
         JOIN "bbb_reconciliation_runs" reconciliation
           ON reconciliation."bbb_harvest_run_id" =
              harvest."bbb_harvest_run_id"
          AND reconciliation."is_current" = true
         WHERE harvest."is_current" = true`,
    );
    expect(currentCoverage.rows).toEqual([
      {
        source_access_status: "blocked",
        source_access_complete: false,
        reconciliation_status: "incomplete_source",
      },
    ]);

    expect(
      await pool.query(
        `SELECT
             improvement."source_record_key",
             improvement."contractor_company_id",
             contact."company_id" AS "contact_company_id"
           FROM "property_improvements" improvement
           LEFT JOIN "permit_contacts" contact
             ON contact."property_improvement_id" =
                improvement."property_improvement_id"
           ORDER BY improvement."source_record_key", contact."permit_contact_id"`,
      ),
    ).toMatchObject({ rows: fixture.resolverState });
    expect(await scalarCount(pool, `SELECT count(*) FROM "companies"`)).toBe(
      fixture.companyCount,
    );
  }, 120_000);

  it("rolls back when an official company is not linked to its permit", async () => {
    const first = fixture.evidence[0]!;
    const second = fixture.evidence[1]!;
    const invalidEvidence = {
      ...first,
      evidenceKey: "official-evidence-invalid-edge",
      company: second.company,
    };
    const invalidBundle = await writeBundle({
      directoryLabel: "invalid-official-edge",
      runId: "lake-private-bbb-invalid-v3",
      categories: [
        { key: "roofing-contractors", profiles: [syntheticProfiles()[0]!] },
      ],
      officialEvidence: [invalidEvidence],
    });
    await expect(
      loadPrivateBbbBundle({
        pool,
        bundlePath: invalidBundle,
        now: "2026-10-24T12:00:00.000Z",
      }),
    ).rejects.toThrow(/company is not linked to its permit/);
    expect(
      await scalarCount(
        pool,
        `SELECT count(*)
         FROM "bbb_harvest_runs"
         WHERE "run_id" = 'lake-private-bbb-invalid-v3'`,
      ),
    ).toBe(0);
  });

  it("keeps FK delete behavior restrictive and required indexes present", async () => {
    const indexes = await pool.query<{ readonly indexname: string }>(
      `SELECT "indexname"
       FROM "pg_indexes"
       WHERE "schemaname" = 'public'
         AND "tablename" LIKE 'bbb_%'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    expect(indexNames.has("bbb_profile_snapshots_licenses_gin")).toBe(true);
    expect(
      indexNames.has("bbb_reconciliation_matches_company_outcome_idx"),
    ).toBe(true);
    expect(indexNames.has("bbb_property_link_evidence_permit_idx")).toBe(true);

    const deleteActions = await pool.query<{ readonly confdeltype: string }>(
      `SELECT constraint_row."confdeltype"
       FROM "pg_constraint" constraint_row
       JOIN "pg_class" table_row
         ON table_row."oid" = constraint_row."conrelid"
       WHERE constraint_row."contype" = 'f'
         AND table_row."relname" IN (
           'bbb_property_link_evidence',
           'bbb_reconciliation_matches'
         )`,
    );
    expect(new Set(deleteActions.rows.map((row) => row.confdeltype))).toEqual(
      new Set(["r"]),
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(`DELETE FROM "companies" WHERE "company_id" = $1`, [
          fixture.acceptedCompanyId,
        ]),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

function requireLocalTestDatabaseUrl(): string {
  if (TEST_DATABASE_URL === undefined) {
    throw new Error("PRIVATE_BBB_TEST_DATABASE_URL is required");
  }
  const parsed = new URL(TEST_DATABASE_URL);
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const databaseName = parsed.pathname.replace(/^\//u, "");
  if (!localHost || !databaseName.includes("test")) {
    throw new Error(
      "PRIVATE_BBB_TEST_DATABASE_URL must target a local disposable test database",
    );
  }
  return TEST_DATABASE_URL;
}

async function resetAndMigrate(target: Pool): Promise<void> {
  await target.query(`DROP EXTENSION IF EXISTS "postgis" CASCADE`);
  await target.query(`DROP SCHEMA IF EXISTS "public" CASCADE`);
  await target.query(`CREATE SCHEMA "public"`);
  const migrationFiles = (await readdir("migrations"))
    .filter((fileName) => /^\d{4}_.+\.sql$/u.test(fileName))
    .sort();
  for (const migrationFile of migrationFiles) {
    const body = await readFile(path.join("migrations", migrationFile), "utf8");
    const separator = body.includes("CREATE INDEX CONCURRENTLY")
      ? ";"
      : "--> statement-breakpoint";
    const statements = body
      .split(separator)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await target.query(statement);
  }
}

async function seedOfficialPermitEvidence(target: Pool): Promise<FixtureIds> {
  const cases = [
    {
      key: "license",
      companyName: "Official License Holdings LLC",
      contractorName: "Different License Display",
      licenses: ["CCC1111111"],
      phones: [],
      contactOnly: false,
    },
    {
      key: "phone",
      companyName: "Official Phone Holdings LLC",
      contractorName: "Different Phone Display",
      licenses: [],
      phones: ["(352) 555-0102"],
      contactOnly: true,
    },
    {
      key: "exact-name",
      companyName: "Exact Roofing LLC",
      contractorName: "Exact Roofing LLC",
      licenses: [],
      phones: [],
      contactOnly: false,
    },
    {
      key: "fuzzy",
      companyName: "Covenant Constrction LLC",
      contractorName: "Covenant Constrction LLC",
      licenses: [],
      phones: [],
      contactOnly: false,
    },
    {
      key: "ambiguous",
      companyName: "Twin Climate LLC",
      contractorName: "Twin Climate LLC",
      licenses: [],
      phones: [],
      contactOnly: false,
    },
    {
      key: "unmatched",
      companyName: "No Match Mechanical LLC",
      contractorName: "No Match Mechanical LLC",
      licenses: [],
      phones: [],
      contactOnly: false,
    },
  ] as const;
  const evidence: Record<string, unknown>[] = [];
  let acceptedCompanyId = "";
  for (const [index, value] of cases.entries()) {
    const company = await target.query<{ readonly company_id: string }>(
      `INSERT INTO "companies" (
         "name", "normalized_name", "source_payload", "source_system",
         "source_record_key", "source_record_hash"
       ) VALUES ($1, $2, '{}'::jsonb, 'dbpr', $3, $4)
       RETURNING "company_id"`,
      [
        value.companyName,
        value.companyName.toUpperCase(),
        `dbpr:${value.key}:company`,
        sha256(value.companyName),
      ],
    );
    const companyId = company.rows[0]!.company_id;
    if (value.key === "license") acceptedCompanyId = companyId;
    const property = await target.query<{ readonly property_id: string }>(
      `INSERT INTO "properties" (
         "parcel_identifier", "source_payload", "source_system",
         "source_record_key", "source_record_hash"
       ) VALUES ($1, '{}'::jsonb, 'lake_appraiser', $2, $3)
       RETURNING "property_id"`,
      [
        `synthetic-parcel-${index + 1}`,
        `lake:property:${index + 1}`,
        sha256(`property-${index + 1}`),
      ],
    );
    const improvement = await target.query<{
      readonly property_improvement_id: string;
    }>(
      `INSERT INTO "property_improvements" (
         "property_id", "contractor_company_id", "permit_number",
         "source_payload", "source_system", "source_record_key",
         "source_record_hash"
       ) VALUES ($1, $2, $3, '{}'::jsonb, 'lake_permits', $4, $5)
       RETURNING "property_improvement_id"`,
      [
        property.rows[0]!.property_id,
        value.contactOnly ? null : companyId,
        `SYN-${index + 1}`,
        `lake:permit:${index + 1}`,
        sha256(`permit-${index + 1}`),
      ],
    );
    if (value.contactOnly) {
      await target.query(
        `INSERT INTO "permit_contacts" (
           "property_improvement_id", "contact_role", "company_id", "raw_name",
           "source_payload", "source_system", "source_record_key",
           "source_record_hash"
         ) VALUES ($1, 'CONTRACTOR', $2, $3, '{}'::jsonb, 'lake_permits', $4, $5)`,
        [
          improvement.rows[0]!.property_improvement_id,
          companyId,
          value.contractorName,
          `lake:permit:${index + 1}:contact:1`,
          sha256(`contact-${index + 1}`),
        ],
      );
    }
    evidence.push({
      schemaVersion: "elephant.bbb-official-permit-company-evidence.v1",
      evidenceKey: `official-evidence-${index + 1}`,
      permit: {
        sourceSystem: "lake_permits",
        sourceRecordKey: `lake:permit:${index + 1}`,
      },
      company: {
        sourceSystem: "dbpr",
        sourceRecordKey: `dbpr:${value.key}:company`,
      },
      contractor: {
        name: value.contractorName,
        alternateNames: [],
        phones: value.phones,
        licenseIdentifiers: value.licenses,
      },
      asOf: FIXED_TIME,
    });
  }
  const resolverState = (
    await target.query<Record<string, unknown>>(
      `SELECT
         improvement."source_record_key",
         improvement."contractor_company_id",
         contact."company_id" AS "contact_company_id"
       FROM "property_improvements" improvement
       LEFT JOIN "permit_contacts" contact
         ON contact."property_improvement_id" =
            improvement."property_improvement_id"
       ORDER BY improvement."source_record_key", contact."permit_contact_id"`,
    )
  ).rows;
  return {
    acceptedCompanyId,
    companyCount: cases.length,
    resolverState,
    evidence,
  };
}

function syntheticProfiles(): readonly SyntheticProfile[] {
  return [
    profile({
      businessId: "license",
      name: "License Profile Business LLC",
      licenses: [
        {
          rawText:
            "BBB records show a license number of CCC1111111 for this business",
        },
      ],
    }),
    profile({
      businessId: "phone",
      name: "Phone Profile Business LLC",
      phone: "(352) 555-0102",
    }),
    profile({ businessId: "exact-name", name: "Exact Roofing Inc." }),
    profile({ businessId: "fuzzy", name: "Covenant Construction LLC" }),
    profile({ businessId: "twin-a", name: "Twin Climate LLC" }),
    profile({ businessId: "twin-b", name: "Twin Climate Inc." }),
  ];
}

function profile(params: {
  readonly businessId: string;
  readonly name: string;
  readonly phone?: string;
  readonly licenses?: readonly { readonly rawText: string }[];
}): SyntheticProfile {
  return {
    recordKind: "bbb_business_profile",
    schemaVersion: "elephant.bbb-category-harvest.v1",
    source: "bbb-public-browser",
    sourceRetrievedAt: FIXED_TIME,
    providerProfileId: `0733:${params.businessId}`,
    providerBusinessId: params.businessId,
    providerBbbId: "0733",
    profileUrl: `https://www.bbb.org/us/fl/leesburg/profile/contractor/synthetic-${params.businessId}`,
    name: params.name,
    legalName: params.name,
    ...(params.phone === undefined ? {} : { phone: params.phone }),
    ...(params.licenses === undefined ? {} : { licenses: params.licenses }),
    accredited: true,
    bbbRating: "A+",
    reviewsComplaintsSummary: { reviewsTotal: 1, complaintsTotal: 0 },
    bbbHarvest: {
      mainPage: { html: `<html>${RAW_HTML_MARKER}</html>` },
    },
  };
}

async function writeBundle(params: {
  readonly directoryLabel: string;
  readonly runId: string;
  readonly categories: readonly CategoryFixture[];
  readonly officialEvidence: readonly Record<string, unknown>[];
}): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `query-db-bbb-${params.directoryLabel}-`),
  );
  fixtureDirectories.push(root);
  const categoryReceipts: {
    readonly categoryKey: string;
    readonly profilesSelected: number;
    readonly profilesHarvested: number;
    readonly profilesFailedPermanent: number;
    readonly requestSha256: string;
    readonly sourceAccessStatus: string;
  }[] = [];
  const reconciledProfiles = new Map<string, string>();
  let rawProfileCount = 0;
  for (const category of params.categories) {
    const harvestDirectory = path.join("harvest", category.key);
    const absoluteHarvestDirectory = path.join(root, harvestDirectory);
    const profileBody =
      category.profiles.map((value) => JSON.stringify(value)).join("\n") +
      (category.profiles.length > 0 ? "\n" : "");
    const profilePart =
      category.profiles.length === 0
        ? null
        : {
            relativePath: "profiles/profiles-part-0001.jsonl",
            recordCount: category.profiles.length,
            bytes: Buffer.byteLength(profileBody),
            sha256: sha256(profileBody),
          };
    if (profilePart !== null) {
      await mkdir(path.join(absoluteHarvestDirectory, "profiles"), {
        recursive: true,
      });
      await writeFile(
        path.join(absoluteHarvestDirectory, profilePart.relativePath),
        profileBody,
      );
    }
    rawProfileCount += category.profiles.length;
    for (const value of category.profiles) {
      if (!reconciledProfiles.has(value.providerProfileId)) {
        reconciledProfiles.set(value.providerProfileId, JSON.stringify(value));
      }
    }
    const sourceAccessStatus = category.sourceAccessStatus ?? "accessible";
    const requestSha256 = sha256(`request:${params.runId}:${category.key}`);
    const complete = sourceAccessStatus === "accessible";
    const summary = {
      schemaVersion: "elephant.bbb-category-harvest.v1",
      jobId: `${params.runId}-${category.key}`,
      county: "lake",
      source: "bbb-public-browser",
      categoryKey: category.key,
      categoryUrl: `https://www.bbb.org/us/fl/leesburg/category/${category.key}`,
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      advertisedResults: complete ? category.profiles.length : null,
      categoryPagesVisited: complete ? 1 : 0,
      profileUrlsDiscovered: category.profiles.length,
      profilesSelected: category.profiles.length,
      profilesHarvested: category.profiles.length,
      profilesFailedPermanent: 0,
      requestSha256,
      completeWithinBounds: complete,
      sourceAccessStatus,
      sourceAccessEvidence:
        sourceAccessStatus === "blocked"
          ? {
              schemaVersion: "elephant.bbb-source-access-evidence.v1",
              source: "bbb-public-browser",
              runId: params.runId,
              batchRequestSha256: sha256(`batch:${params.runId}`),
              observedBatchJobId: "11111111-2222-4333-8444-555555555555",
              observedAt: FIXED_TIME,
              observedCategoryKey: category.key,
              observedUrl: `https://www.bbb.org/us/fl/leesburg/category/${category.key}`,
              httpStatus: 403,
              classification: "blocked",
              failureReason: "blocked",
              operatorDirective: "stop_no_further_bbb_requests",
            }
          : null,
      profileParts: profilePart === null ? [] : [profilePart],
      failurePart: null,
    };
    await mkdir(path.join(absoluteHarvestDirectory, "manifest"), {
      recursive: true,
    });
    await writeFile(
      path.join(absoluteHarvestDirectory, "manifest", "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    categoryReceipts.push({
      categoryKey: category.key,
      profilesSelected: category.profiles.length,
      profilesHarvested: category.profiles.length,
      profilesFailedPermanent: 0,
      requestSha256,
      sourceAccessStatus,
    });
  }
  const reconciledBody =
    [...reconciledProfiles.values()].join("\n") +
    (reconciledProfiles.size > 0 ? "\n" : "");
  const sourceAccessStatus = params.categories.some(
    (category) => category.sourceAccessStatus === "blocked",
  )
    ? "blocked"
    : "accessible";
  const reconciliation = {
    schemaVersion: "elephant.bbb-reconciliation.v1",
    county: "lake",
    reconciledAt: FIXED_TIME,
    categoryCount: params.categories.length,
    categories: categoryReceipts,
    rawProfileCount,
    uniqueProfileCount: reconciledProfiles.size,
    duplicateProfileCount: rawProfileCount - reconciledProfiles.size,
    sourceAccessStatus,
    sourceAccessComplete: sourceAccessStatus === "accessible",
    profilesBytes: Buffer.byteLength(reconciledBody),
    profilesSha256: sha256(reconciledBody),
    permanentFailureCount: 0,
  };
  await mkdir(path.join(root, "reconciled"), { recursive: true });
  await writeFile(
    path.join(root, "reconciled", "bbb-reconciliation-manifest.json"),
    `${JSON.stringify(reconciliation, null, 2)}\n`,
  );
  await mkdir(path.join(root, "private"), { recursive: true });
  await writeFile(
    path.join(root, "private", "official-evidence.jsonl"),
    `${params.officialEvidence.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  const bundle = {
    schemaVersion: "elephant.bbb-private-persistence-bundle.v1",
    countyKey: "lake",
    runId: params.runId,
    reconciliationManifest: "reconciled/bbb-reconciliation-manifest.json",
    categories: params.categories.map((category) => ({
      categoryKey: category.key,
      harvestDirectory: `harvest/${category.key}`,
    })),
    officialPermitCompanyEvidence: "private/official-evidence.jsonl",
  };
  const bundlePath = path.join(root, "bundle.json");
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundlePath;
}

async function scalarCount(
  target: Pool,
  sql: string,
  values: readonly unknown[] = [],
): Promise<number> {
  const result = await target.query<{ readonly count: string }>(sql, [
    ...values,
  ]);
  return Number(result.rows[0]?.count ?? 0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
