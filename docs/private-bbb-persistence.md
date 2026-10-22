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

The loader verifies category manifest counts, part byte counts and SHA-256
digests, reconciled profile counts/digest, source-access state, and every
official permit/company/property edge before beginning reconciliation.

Run only after the target migration and official source rows are approved:

```bash
DATABASE_URL=... npm run load:bbb-private -- --bundle /private/path/bundle.json
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

## Lake row-free canary plan

The completed private Lake evidence is suitable for a future canary, but this
change does not apply the migration or load DEV:

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
4. adapt the private official evidence to the bundle contract without copying
   rows into Git;
5. recompute and compare the three row-free digests above;
6. run a read-only preflight that predicts 3 accepted exact-name links and zero
   fuzzy accepts; and
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
