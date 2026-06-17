# Data Load and Cross-Source Matching Plan

Date recorded: 2026-05-26

## Goal

Load all extracted appraisal, permit, Sunbiz, and BBB business reputation data into the Neon/Postgres query database, then connect records across the sources using deterministic parcel identifiers first, normalized address hashes second, and company/contractor identity for reputation enrichment.

The database should remain rerunnable: reprocessing the same S3 artifacts should be idempotent, and newer artifacts should update changed rows without duplicating old rows.

## Source tracks

1. **Lee appraisal** — authoritative parcel/property source.
   - Primary keys: parcel identifier, property/appraiser source keys.
   - Important joins: parcel id, site address, owner mailing address.
2. **Lee Accela permits** — all permit/detail records.
   - Primary keys: permit number / Accela ids.
   - Important joins: parsed parcel id, work-location address, contractor/applicant names.
3. **Sunbiz quarterly corporate data** — companies, registrations, registered agents/officers, and addresses.
   - Primary keys: document number plus child role/ordinal keys.
   - Important joins: principal/mailing/agent/officer addresses, company names, FEI/document number.
4. **BBB business profile artifacts** — company-level reputation, accreditation, rating, reviews, complaints, licenses, locations, service areas, contacts, media, and links.
   - Primary keys: provider profile/business id, BBB profile URL, or exported source key.
   - Important joins: contractor company name/address from permits, normalized company/address rows, and future Sunbiz company evidence.
   - Constraint: load only staged JSON/JSONL artifacts. The current approved direct-collection path is the oracle-node Puppeteer harvester; the query-db loader itself does not browse BBB.org.

## Execution model

This should run as an **AWS-side backfill/load job**, not inside Vercel request handling.

Recommended shape:

```diagram
╭────────────────────╮     ╭──────────────────────╮     ╭──────────────────────╮
│ Existing S3 output │────▶│ Step Functions       │────▶│ Neon Postgres         │
│ appraisal/permits  │     │ Distributed Map      │     │ elephant-query-db     │
│ sunbiz/BBB feeds   │     │ + Lambda workers     │     │ logical tables/views  │
╰────────────────────╯     ╰──────────┬───────────╯     ╰──────────────────────╯
                                       │
                                       ▼
                             ╭────────────────────╮
                             │ S3 result writer   │
                             │ reconciliation     │
                             ╰────────────────────╯
```

Why AWS-side:

- the extracted data already lives in S3 in the oracle-node AWS account
- full loads are long-running and should not be tied to Vercel function timeouts
- workers can be chunked, retried, throttled, and monitored with CloudWatch/SQS
- Vercel should only query Neon after the data is loaded

## AWS loader architecture decision

Use **Step Functions Distributed Map + bounded Lambda workers** for the first cloud loader. Do not start with AWS Glue for the database delivery path.

### Why Step Functions + Lambda is the default

- The source data is already broken into S3 artifacts/manifests, and the work is mostly independent record/chunk mapping into logical tables.
- AWS Step Functions Distributed Map can read large S3-backed datasets and run child workflows at high scale. AWS documents Inline Map as limited to 40 concurrent iterations, while Distributed Map supports up to 10,000 parallel child workflow executions and S3 item sources.
- Distributed Map exposes `MaxConcurrency`, `ItemBatcher`, failure thresholds, retries/catches, Map Run monitoring, and optional S3 result writing. That matches this loader's needs: throttle Neon writes, isolate bad chunks, and produce reconciliation artifacts.
- Lambda is appropriate only when each invocation is bounded: one S3 object or a small batch of records, not an entire source track. AWS Lambda docs call out S3 transfer variability and downstream latency as timeout risks, so the worker must use small batches and realistic upper-bound tests.
- AWS Lambda docs also recommend idempotent handlers and reusing SDK/database clients across warm invocations; the loader should still be correct if a worker is retried or duplicated.

### Why not AWS Glue first

Glue can do this, but it is a worse first fit for this workload:

- Glue Spark jobs are best when records depend on each other: distributed joins, aggregations, dedupe, diff detection, or large Parquet analytics.
- Glue JDBC support can write to PostgreSQL-compatible targets and even parallelize inserts with `bulkSize`, but that pushes many Spark executors toward Neon and makes database backpressure harder to control than Step Functions `MaxConcurrency`.
- Glue job bookmarks track S3 input by object modified time and can help incremental jobs, but they do not clean or manage target rows; we still need Postgres upserts and source hashes for safe reruns.
- Glue introduces Spark worker sizing, DPU cost, startup latency, separate Python/Scala packaging, and JDBC-driver operations before we have evidence that Spark is needed.

Use Glue later only if profiling shows a genuinely Spark-shaped step, for example:

1. precomputing huge cross-source address/name candidate sets into Parquet,
2. expensive dedupe/windowing across full snapshots,
3. converting raw JSON/HTML-derived artifacts into large columnar tables for analytics.

If that happens, use **Glue for S3-to-S3 preparation**, then Step Functions for throttled delivery into Neon/Postgres.

### Neon/Postgres implications

- Use the Neon pooled connection string for Lambda workers by default. Neon documents PgBouncer-backed pooling with up to 10,000 client connections, but active backend work is still limited by compute-size `max_connections` and `default_pool_size`; do not treat 10,000 as a safe write concurrency.
- Start with conservative Step Functions `MaxConcurrency` such as 10-20 chunk workers, one active DB client per worker, and batch sizes around 100-500 rows. Increase only while Neon pooler metrics show no waiting, `query_wait_timeout`, or write-latency growth.
- Use the direct, unpooled Neon connection for migrations and session-sensitive operations. Neon documents direct connections for migrations and features PgBouncer transaction pooling does not support.
- For normal loader writes, use multi-row `INSERT ... ON CONFLICT DO UPDATE` with a `source_record_hash` guard. PostgreSQL documents `ON CONFLICT DO UPDATE` as an atomic insert-or-update outcome under concurrency.
- If one table needs very high-volume import, stream into a permanent staging table keyed by `load_run_id`/`chunk_id` with PostgreSQL `COPY FROM STDIN`, then merge into the final logical table with `INSERT ... SELECT ... ON CONFLICT`. Avoid temp tables with pooled connections because Neon uses PgBouncer transaction mode.

### Recommended cloud flow

1. A small planner Lambda validates input manifests, estimates row/file counts, estimates rough cost, and creates a run manifest in S3.
2. Step Functions runs tracks in dependency order: appraisal load, permit load, Sunbiz load, permit matching, Sunbiz matching, reconciliation.
3. Each load stage uses Distributed Map over S3 manifest items with explicit `MaxConcurrency` and `ItemBatcher`.
4. Each worker reads one chunk/artifact, validates the expected shape, maps rows to logical table inputs, and upserts by `(source_system, source_record_key)`.
5. Each worker emits per-table inserted/updated/unchanged/error counts and writes chunk results to S3 via the Map result writer or explicit report objects.
6. Matching stages run bounded SQL updates in Neon/Postgres: parcel id first, normalized address hash second, names only for enrichment.
7. Reconciliation writes counts and unresolved-match reports back to S3 and CloudWatch.

The first implementation can still be a resumable Node.js CLI run from an AWS-authenticated environment to validate mappings against a local/fresh Neon branch. Once the smoke load works, promote the same chunk worker code to Lambda under Step Functions. Fallback execution options remain:

1. **ECS/Fargate task invoked by Step Functions** if one chunk cannot stay comfortably within Lambda timeout/memory.
2. **Glue → S3 → Step Functions** if a future preparation step requires Spark-scale joins/dedupes.
3. **SQS + Lambda workers** only if we want a continuously running queue-based incremental loader rather than explicit Step Functions runs.

The job needs these secrets/config values:

- read access to the oracle-node S3 bucket
- `DATABASE_URL` or pooled Neon connection string for `elephant-query-db`
- optional batch size/concurrency limits
- the exact S3 source prefixes/manifests for each data track, including the BBB profile artifact prefix when reputation data is loaded

## Current artifact sources

Use S3 as the source of truth for the loader. Do not rescrape county/Sunbiz sites for the database load unless a source artifact is missing.

Known current prefixes/artifacts:

### Permits

- Bucket/prefix root: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest`
- Current historical permit job: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/lee-permit-backfill-20260525`
- Permit list summaries/details live under that job prefix, including `lee/permit-lists/` and extracted permit JSON under `lee/extracted/permits/`.

### Sunbiz

- Staged original quarterly ZIP: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/sunbiz-source/quarterly/cor/cordata-2026q2.zip`
- Expanded quarterly text files: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/sunbiz-source/quarterly/cor/cordata-2026q2-expanded/`
- Lee ZIP-filtered manifest: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/sunbiz-lee-corporate-quarterly-2026q2-expanded/sunbiz/corporate-by-zip/manifest.json`
- Lexicon transform output: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/sunbiz-lee-corporate-quarterly-2026q2-expanded/lexicon-transform/business-registration-v1/`
- Transform summary: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/sunbiz-lee-corporate-quarterly-2026q2-expanded/lexicon-transform/business-registration-v1/summary.json`

### Appraisal

- Appraisal extraction is produced by the existing oracle-node appraisal prepare workflow.
- The loader should read the existing appraisal output artifacts from the workflow output S3 prefixes rather than querying the appraisal website again.
- Appraisal should be loaded first because it creates the parcel/property/address anchors for permit and Sunbiz matching.

### BBB

- BBB input should be profile JSON/JSONL staged in S3. For the Puppeteer category harvester, write to a run root such as `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/bbb/category-data/browser-harvest-v1/` and load the generated `profiles/` subprefix.
- The local bulk loader accepts `--tracks bbb --bbb-prefix <prefix>` and reads `.json` / `.jsonl` profile objects from that prefix using the same S3 `ListObjectsV2` pagination pattern as the other tracks.
- Supported input shapes include single profile objects, JSON arrays, JSONL profile lines, and common envelopes such as `{ businesses: [...] }`, `{ profiles: [...] }`, `{ results: [...] }`, or `{ data: { profiles: [...] } }`.
- BBB profile payloads are treated as the source of truth for reputation facts. The loader preserves each complete profile JSON in `business_reputation_profiles.source_payload`, while known repeatable sections also land in typed child tables for efficient query and scoring.

## Matching keys

### 1. Parcel id: strongest property join

Normalize all parcel identifiers into one canonical form:

```text
digits only, left/right spacing removed, preserve leading zeroes
```

Use this as the first-pass join:

- `parcels.parcel_identifier`
- `properties.parcel_identifier`
- `property_improvements.parcel_identifier`

Matching action:

1. Load appraisal `parcels` and `properties` first.
2. For each permit with `parcel_identifier`, find `parcels.parcel_identifier`.
3. Set `property_improvements.parcel_id` and, when there is a single property for the parcel, `property_improvements.property_id`.
4. Keep the raw permit parcel text in `property_improvements.parcel_identifier` even if no match is found.

This gives the cleanest permit-to-property join and should be treated as higher confidence than address matching.

### 2. Normalized address hash: cross-source fallback and Sunbiz join

Every address-like source string should be normalized into a canonical address key and hash.

Recommended canonical key components:

```text
street_number|pre_directional|street_name|street_suffix|post_directional|unit|city|state|postal_code5
```

Recommended hash:

```text
sha256(lowercase(canonical_key))
```

Store both:

- human-debuggable `normalized_address_key`
- fixed-width `normalized_address_hash`

Matching action:

1. Upsert every parsed address into `addresses` by `(source_system, source_record_key)`.
2. Also maintain a unique/searchable index on `(state_code, postal_code, normalized_address_hash)` or `(normalized_address_hash)` once collision behavior is understood.
3. Link source rows to `addresses.address_id`:
   - appraisal property site address → property/property-address FK
   - appraisal owner mailing address → ownership mailing address FK
   - permit work location → `property_improvements.address_id`
   - permit contacts → `permit_contacts.address_id`
   - Sunbiz principal/mailing addresses → `business_registration_addresses.address_id`
   - Sunbiz party addresses → `business_registration_parties.address_id`
4. For permits without parcel ids, use address hash to find candidate appraisal properties.
5. For Sunbiz, use address hash to find companies/agents/officers connected to property addresses.

Address hash confidence rules:

- exact hash + same ZIP5: high confidence
- exact hash + missing ZIP: medium confidence
- same street key but different unit: low confidence unless source has no unit data
- PO Boxes should not be matched to parcel site addresses; keep them for mailing/contact relationships only

### 3. Company/person names: enrichment only

Use normalized names only after parcel/address matching:

- permit contractor name ↔ Sunbiz company name
- appraisal owner company/person ↔ Sunbiz company/officer/agent names
- permit applicant/licensed professional ↔ Sunbiz parties

Do not use name-only matching to attach a permit to a property. Use names to rank/address-confirm company/person matches.

### 4. BBB contractor reputation enrichment

BBB rows are company-level reputation facts, not permit facts. Do not mutate Accela permit rows with BBB fields during source loading.

Recommended matching action:

1. Load BBB profiles into `companies`, `addresses`, `business_reputation_profiles`, child `business_reputation_*` tables, and `contractor_quality_scores`.
2. Match permit contractor companies to BBB companies using normalized contractor/company name plus address/phone/profile evidence where available.
3. Query contractor quality for a permit by joining `property_improvements.contractor_company_id` to `contractor_quality_scores.company_id`, optionally showing the source BBB profile and complaints/reviews as evidence.
4. Keep score rows derived and versioned by `scoring_model`; recompute by reloading or adding a new model rather than overwriting raw BBB facts.

The first scoring model is intentionally simple and transparent (`bbb-profile-v1`): BBB letter rating, accreditation status, complaint counts, and review-average/count are stored in `contractor_quality_scores.factor_payload` alongside the numeric score. The full BBB payload remains available for a richer model later.

## Schema changes needed before loading at scale

The current logical schema is close, but the load/match pipeline needs a few direct columns/indexes:

1. Add `normalized_address_hash` to `addresses`.
2. Add indexes for address lookup:
   - `addresses_normalized_hash_idx` on `normalized_address_hash`
   - optionally `addresses_state_zip_hash_idx` on `state_code`, `postal_code`, `normalized_address_hash`
3. Add direct address FKs for appraisal rows:
   - `properties.site_address_id` or `properties.address_id`
   - `ownerships.mailing_address_id` if owner mailing addresses are loaded separately
4. Consider storing `match_method` / `match_confidence` columns on nullable FKs that are filled by the matcher, for example:
   - `property_improvements.property_match_method`
   - `property_improvements.property_match_confidence`
   - `business_registration_addresses.address_match_method`
5. Add BBB reputation tables for staged profile artifacts:
   - `business_reputation_profiles` for provider-level business profile, rating, accreditation, profile URL, contact summary, and full raw JSON.
   - `business_reputation_alternate_names`, `business_reputation_categories`, `business_reputation_rating_reasons`, `business_reputation_contacts`, `business_reputation_licenses`, `business_reputation_service_areas`, `business_reputation_locations`, `business_reputation_reviews`, `business_reputation_complaints`, `business_reputation_complaint_events`, `business_reputation_media`, and `business_reputation_external_links` for repeatable BBB sections.
   - `contractor_quality_scores` for versioned derived scoring rows tied to `companies` and `business_reputation_profiles`.

Keep these as typed columns on logical tables. Do not add generic match/entity tables.

## Load order

### Phase 0 — Database setup

1. Connect the Vercel Neon resource `elephant-query-db` to the Vercel project that will query it.
2. Pull the database environment variables locally.
3. Apply the generated query-db migration.
4. Apply the small matching-support migration above if it has not been added yet.

### Phase 1 — Shared normalizers

Build a reusable loader utility package/script that provides:

- parcel id normalization
- address parsing/normalization/hash generation
- source record hash generation
- batch upsert helpers using `(source_system, source_record_key)`
- S3 artifact readers for JSON/JSONL/chunked outputs

### Phase 2 — Appraisal load first

Load appraisal data before other tracks because it is the anchor for parcel/property matching.

Order:

1. `addresses` for site and mailing addresses
2. `parcels`
3. `properties` with `parcel_id` and site `address_id`
4. `people` / `companies` for owners when classification is reliable
5. `ownerships`
6. `taxes`, `sales_histories`, `structures`, `flood_storm_information`, `utilities`, `layouts`, `lots`

Each row gets:

- `source_system = 'lee_appraiser'`
- stable `source_record_key`
- `source_record_hash`
- `source_artifact_uri`
- full `source_payload`

### Phase 3 — Permit load

Load permit details from the permit-harvest artifacts.

Order:

1. Upsert permit work-location/contact addresses into `addresses`.
2. Upsert contractor/contact people/companies when parsed confidently.
3. Upsert `property_improvements`.
4. Upsert children: `inspections`, `permit_contacts`, `permit_events`, `permit_fees`, `permit_links`, `permit_custom_fields`, `permit_list_windows`.
5. Run permit matching:
   - parcel id exact match first
   - address hash fallback second
   - contractor/company enrichment third

For every permit, preserve raw Accela evidence in `source_payload`, `more_details`, raw text columns, and child tables even when matching fails.

### Phase 4 — Sunbiz load

Load Sunbiz transformed chunks after appraisal addresses exist.

Order:

1. Upsert normalized company rows into `companies`.
2. Upsert principal/mailing/agent/officer addresses into `addresses`.
3. Upsert `business_registrations`.
4. Upsert `business_registration_addresses` with `address_id`.
5. Upsert `business_registration_parties` with `address_id`, and person/company classification when reliable.
6. Upsert `business_registration_annual_reports`.
7. Later, load `business_registration_events` from `corevent.zip`.
8. Run Sunbiz matching:
   - address hash to appraisal property addresses
   - address hash to permit work locations/contact addresses
   - company name + address/ZIP to permit contractors

### Phase 5 — BBB reputation load

Load BBB after or alongside company-bearing permit/Sunbiz tracks. BBB creates its own `companies` and `addresses` from staged profile artifacts first, then profile child rows and derived score rows.

Order:

1. `addresses`
2. `companies`
3. `people` for management/contact names when present
4. `business_reputation_profiles`
5. BBB child tables, with complaints before complaint events
6. `contractor_quality_scores`

Bulk loader command shape:

```bash
npm run load:bulk -- \
  --tracks bbb \
  --bbb-prefix permit-harvest/bbb/category-data/browser-harvest-v1/profiles/
```

## Upsert strategy

For every logical table:

```sql
insert ...
on conflict (source_system, source_record_key)
do update set
  typed_columns = excluded.typed_columns,
  source_payload = excluded.source_payload,
  source_record_hash = excluded.source_record_hash,
  source_artifact_uri = excluded.source_artifact_uri,
  loaded_at = now(),
  updated_at = now()
where table.source_record_hash is distinct from excluded.source_record_hash;
```

This makes unchanged reruns cheap and changed source rows auditable.

## Reconciliation queries

Track these counts after every load:

- rows by `source_system` per table
- changed rows by `loaded_at` window
- permits with `parcel_identifier` but no `parcel_id`
- permits with no parcel match but address hash candidates
- Sunbiz addresses with property-address hash matches
- duplicate normalized address hashes with conflicting parsed components
- PO Box counts excluded from site-address matching

## Implementation milestones

1. Add address hash and appraisal address FK migration to `elephant-query-db`.
2. Create loader scripts in `elephant-query-db` or a small adjacent loader package:
   - `load-appraisal`
   - `load-permits`
   - `load-sunbiz`
   - `match-permits`
   - `match-sunbiz`
   - `reconcile-load`
3. Run a local smoke load into a fresh local Postgres database.
4. Apply migrations to Neon.
5. Load a small S3 sample from each track into Neon.
6. Validate parcel/address joins manually for known examples.
7. Run full appraisal load.
8. Run full permit load and matching.
9. Run full Sunbiz load and matching.
10. Publish reconciliation counts and unresolved-match reports.

## Scoped final-load path

The local bulk loader now supports `--scope-manifest` for the final curated
1000-property database. Use the curated-commercial manifest as the scope file:

```bash
AWS_PROFILE=elephant-oracle-node AWS_REGION=us-east-1 \
  npm run load:bulk -- \
    --scope-manifest .loader-runs/curated-commercial-sample/curated-commercial-1000-manifest.json \
    --appraisal-prefix curated-commercial-2000-20260528/appraisal/transformed-data-with-media/ \
    --permit-prefix permit-harvest/lee-permit-backfill-20260525/lee/extracted/permits/ \
    --sunbiz-prefix permit-harvest/sunbiz-lee-corporate-quarterly-2026q2-expanded/lexicon-transform/business-registration-v1/classes/ \
    --tracks appraisal,permits,sunbiz \
    --concurrency 4
```

When scoped, appraisal artifacts are kept only when their mapped parcel/property
rows match a selected parcel id. Permits are kept only when the extracted Accela
parcel id matches a selected parcel id. Sunbiz is narrowed by selected property
address bases: the loader scans Sunbiz address relationship files, selects
documents whose address vertices touch the selected property bases, loads the
matching registrations/companies/parties/addresses, and converts address
relationships into direct `address_id` foreign-key references during merge.

Use `--phase stage` first for smoke runs; it writes only the local CSV stage file
and does not mutate Neon.

## Definition of done

- All extracted appraisal, permit, and Sunbiz source records are represented in logical tables.
- Every loaded row has source metadata and `source_payload`.
- Permit rows with valid parcel ids are linked to appraisal parcels/properties.
- Permit rows without parcel ids are linked by normalized address hash when confidence is high.
- Sunbiz addresses are linked to property/permit addresses by normalized address hash.
- Name-only matches are used only for company/person enrichment, not property attachment.
- The pipeline can be safely rerun without duplicate inserts.
