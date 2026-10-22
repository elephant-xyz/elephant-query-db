# Private BBB Reputation Persistence

## Boundary

Use this path only for private contractor-reputation reconciliation. It does not
add a Lexicon or Atlas class, change a public export, or establish legal
identity.

The repository already contains legacy `business_reputation_*` tables and a
loader that can create source-local `companies` rows. The private loader added
here deliberately does not use that path. It:

- reads existing official `companies`, `property_improvements`, and
  `permit_contacts` edges;
- never inserts or updates a company, permit contact, property improvement, or
  property;
- never joins a BBB office address directly to a property;
- accepts property evidence only when the existing permit has a property and
  the existing official company edge is present;
- keeps fuzzy name candidates review-only; and
- stores sanitized extracted fields plus source hashes, never raw HTML or
  credentials.

## Private tables

- `bbb_harvest_runs` — county/run coverage and row-free source provenance.
- `bbb_harvest_categories` — category bounds, access state, counts, and
  manifest digest.
- `bbb_artifact_watermarks` — current content hash per profile part.
- `bbb_profile_snapshots` — immutable, sanitized profile snapshots.
- `bbb_profile_category_memberships` — category membership by artifact
  revision; corrected or removed records are retired with a tombstone reason.
- `bbb_reconciliation_runs` — versioned match-policy and official-evidence
  digest.
- `bbb_reconciliation_matches` — accepted, review, ambiguous, and unmatched
  outcomes.
- `bbb_property_link_evidence` — accepted property evidence anchored to an
  existing official company-linked permit.

All foreign keys from BBB evidence to legal identity and permits use
`ON DELETE RESTRICT`. The migration adds tables and indexes only; it does not
alter shared tables.

## Bundle contract

Keep the bundle and every referenced artifact outside Git:

```json
{
  "schemaVersion": "elephant.bbb-private-persistence-bundle.v1",
  "countyKey": "sample-county",
  "runId": "sample-bbb-run-v1",
  "reconciliationManifest": "reconciled/bbb-reconciliation-manifest.json",
  "categories": [
    {
      "categoryKey": "roofing-contractors",
      "harvestDirectory": "harvest/roofing-contractors"
    }
  ],
  "officialPermitCompanyEvidence": "private/official-evidence.jsonl"
}
```

For Oracle content-addressed handoffs, do not manually rewrite private rows.
Create an external `oracle.bbb-private-loader-handoff.v1` manifest that points
to the source linkage manifest, reconciliation manifest, category harvest
directories, permit coverage, permit-company evidence, and accepted links.
Every pointer must include bytes and SHA-256; every category must pin its
summary digest and profile count. The expectations must pin:

- complete source coverage;
- total and per-category profile counts plus reconciled profile digest;
- exact accepted-link tier counts;
- zero review candidates and zero fuzzy accepts;
- accepted property-link count; and
- the exact permit watermark digest.

The row-free manifest shape is:

```json
{
  "schemaVersion": "oracle.bbb-private-loader-handoff.v1",
  "countyKey": "lake",
  "runId": "lake-bbb-full-20261021-v1",
  "sourceManifest": {
    "relativePath": "source/linkage-manifest.json",
    "bytes": 123,
    "sha256": "<64 lowercase hex>"
  },
  "reconciliationManifest": {
    "relativePath": "reconciled/bbb-reconciliation-manifest.json",
    "bytes": 123,
    "sha256": "<64 lowercase hex>"
  },
  "permitCoverage": {
    "relativePath": "coverage/dataset-coverage.json",
    "bytes": 123,
    "sha256": "<64 lowercase hex>"
  },
  "permitCompanyEvidence": {
    "relativePath": "private/permit-company-evidence.jsonl",
    "bytes": 123,
    "sha256": "6ef315c332ec4ce48ed77cbf5de5d6293c55336ceba7dc15e3a8a06d0b362c41",
    "records": 48
  },
  "acceptedLinks": {
    "relativePath": "private/accepted-links.jsonl",
    "bytes": 123,
    "sha256": "<64 lowercase hex>",
    "records": 3
  },
  "categories": [
    {
      "categoryKey": "roofing-contractors",
      "harvestDirectory": "harvest/roofing-contractors",
      "summarySha256": "<64 lowercase hex>",
      "profileCount": 18
    },
    {
      "categoryKey": "air-conditioning-repair",
      "harvestDirectory": "harvest/air-conditioning-repair",
      "summarySha256": "<64 lowercase hex>",
      "profileCount": 19
    }
  ],
  "expectations": {
    "sourceAccessComplete": true,
    "profileCount": 37,
    "officialIdentityCount": 48,
    "officialCompanyCount": 31,
    "profilesSha256": "e0e1835ec1cdc4031bcb2a197a621a1e7b58dced11ea57f6400d1af4aca4549d",
    "acceptedPropertyLinkCount": 3,
    "reviewCandidateCount": 0,
    "fuzzyAcceptedCount": 0,
    "matchMethodCounts": {
      "exact_state_license": 0,
      "exact_standardized_phone": 0,
      "unique_exact_normalized_business_name": 3
    },
    "permitWatermarkDigest": "3900dcfe1852447b679f6b2b091fbdb37982cafd3f319cb0be6bd01b87ffb339"
  }
}
```

Replace every placeholder and byte count from the private content-addressed
artifacts. The adapter fails closed if any receipt differs.

Prepare the canonical bundle in a private ignored directory:

```bash
npm run prepare:bbb-private -- \
  --handoff "$ORACLE_BBB_HANDOFF" \
  --output-dir "$PRIVATE_BBB_BUNDLE_DIR"
```

The adapter accepts only `oracle.bbb-official-permit-link.v1` exact-license,
exact-phone, or unique-exact-name links. It rejects fuzzy accepted links,
incomplete coverage, changed category/profile parts, mismatched
permit-company evidence, and watermark drift. It writes a row-free adapter
receipt plus private canonical evidence; only the synthetic test fixture may
live in Git.

Each official-evidence JSONL record must use source keys that already exist in
Query DB:

```json
{
  "schemaVersion": "elephant.bbb-official-permit-company-evidence.v1",
  "evidenceKey": "synthetic-evidence-1",
  "permit": {
    "sourceSystem": "sample_permits",
    "sourceRecordKey": "sample:permit:1"
  },
  "company": {
    "sourceSystem": "official_license",
    "sourceRecordKey": "official:license:company:1"
  },
  "contractor": {
    "name": "Synthetic Roofing LLC",
    "alternateNames": [],
    "phones": ["5555550100"],
    "licenseIdentifiers": ["CCC0000000"]
  },
  "asOf": "2026-01-01T00:00:00.000Z"
}
```

The Oracle adapter emits v2 evidence outside Git. It carries the existing
`property_improvement_id`, `property_id`, and official company request
identifier from the accepted private link, plus the expected BBB business,
profile keys, exact tier, confidence, and source-evidence digest. At plan/apply
time the loader requires those IDs to resolve exactly one existing
company-linked permit/property edge and independently reproduces the expected
exact match. It never trusts the source link to establish legal identity.

The adapter's private permit-company input uses
`oracle.bbb-permit-company-evidence.v1` JSONL. Each record requires a unique
`evidence_key`, `county`, `property_id`, `property_improvement_id`,
`official_company_request_identifier`, `as_of`, and arrays for official
alternate names, phones, and licenses; `official_company_name` is optional.
The three accepted-link records must reference unique tuples from that complete
evidence set. The adapter converts every identity record, not only accepted
links, so the loader independently reproduces accepted, review, ambiguous, and
unmatched outcomes.

The loader verifies category manifest counts, part byte counts and SHA-256
digests, reconciled profile counts/digest, source-access state, and every
official permit/company/property edge before beginning reconciliation.

Run only after the target migration and official source rows are approved.
First predict the exact outcome in a read-only transaction:

```bash
DATABASE_URL=... npm run load:bbb-private -- \
  --plan \
  --bundle /private/path/bundle.json
```

Require the plan to report the reviewed profile count, three exact Lake links,
zero fuzzy accepts, and `ready: true`. After explicit operator approval, apply:

```bash
DATABASE_URL=... npm run load:bbb-private -- \
  --apply \
  --bundle /private/path/bundle.json
```

Then perform the read-only current-digest verification:

```bash
DATABASE_URL=... npm run load:bbb-private -- \
  --verify \
  --bundle /private/path/bundle.json
```

Do not print or commit `DATABASE_URL`, the bundle, profile parts, or official
evidence.

## Matching and reload rules

Automatic acceptance is a strict cascade:

1. unique exact state-license identifier (`1.00`);
2. unique exact normalized ten-digit phone (`0.95`);
3. unique exact normalized business name (`0.80`).

Name normalization removes punctuation and legal suffixes while retaining
trade words. Jaro-Winkler candidates at or above `0.90` are stored only as
`review` or `ambiguous`; the database constraint prevents that method from
being accepted.

An identical bundle plus official-evidence digest returns zero writes. If a
part changes at the same path, the loader:

1. advances its content-hash watermark;
2. keeps old profile snapshots immutable;
3. retires old category memberships with an explicit tombstone reason;
4. inserts memberships for the corrected revision; and
5. creates a new current reconciliation run.

It never truncates shared tables or deletes legal identity.

## Lake row-free canary handoff

The completed private Lake evidence can be adapted by the contract above, but
this repository change does not apply the migration or load DEV:

- 37 unique profiles: 18 roofing and 19 HVAC;
- zero duplicate profiles and zero permanent failures;
- 27 provider businesses;
- 48 official identity sets across 31 official companies;
- 3 accepted unique exact-name company matches;
- 3 accepted permits and 3 accepted properties;
- every accepted property has an official linked permit;
- fuzzy accepted count: zero;
- reconciled profile SHA-256:
  `e0e1835ec1cdc4031bcb2a197a621a1e7b58dced11ea57f6400d1af4aca4549d`;
- official permit-company evidence SHA-256:
  `6ef315c332ec4ce48ed77cbf5de5d6293c55336ceba7dc15e3a8a06d0b362c41`;
- permit watermark digest:
  `3900dcfe1852447b679f6b2b091fbdb37982cafd3f319cb0be6bd01b87ffb339`.

Before a DEV canary:

1. obtain normal owner approval and merge the migration;
2. apply it to DEV through the repository's reviewed migration path;
3. prove the 31 official companies, relevant permits, and linked properties
   exist under stable Query DB source keys;
4. create the external handoff manifest and run `prepare:bbb-private` without
   copying rows into Git;
5. recompute and compare the three row-free digests above;
6. run `load:bbb-private -- --plan` and require 37 profiles, 3 accepted
   unique-exact-name links, zero review candidates, and zero fuzzy accepts; and
7. obtain explicit operator approval before the first DEV write.

After the canary, require 37 current unique profiles, 3 current accepted
property links, no orphan foreign keys, no legacy reputation-table writes, and
an immediate replay reporting zero writes.

## Rollback guidance

Prefer roll-forward correction after any data has been loaded so immutable
evidence remains auditable. Stop the loader and retain the private rows while a
fix is reviewed.

Before the first load, an owner may reverse the additive migration by dropping
only the new tables in this dependency order, without `CASCADE`:

1. `bbb_property_link_evidence`
2. `bbb_reconciliation_matches`
3. `bbb_reconciliation_runs`
4. `bbb_profile_category_memberships`
5. `bbb_profile_snapshots`
6. `bbb_artifact_watermarks`
7. `bbb_harvest_categories`
8. `bbb_harvest_runs`

Never truncate or cascade through `companies`, `properties`,
`property_improvements`, or `permit_contacts`.
