# Schema Design

## Goal

Create a queryable Postgres database for all data extracted by the oracle node while staying close to the Elephant lexicon. The database must be easy for Vercel apps to query, support rerunnable loaders, and normalize/match the Lee County appraisal, permit, and Sunbiz tracks.

## Design decision

Use logical tables only. Do not create a generic raw-record registry, generic entity table, generic relationship table, or generic matching layer.

```diagram
╭────────────────────────╮       direct FK / keys       ╭────────────────────────────╮
│ appraisal logical rows │─────────────────────────────▶│ parcels/properties/address │
╰────────────────────────╯                              ╰─────────────┬──────────────╯
                                                                       │
╭────────────────────────╮       direct FK / keys                      │
│ permit logical rows    │─────────────────────────────────────────────╯
│ property_improvements  │
╰────────────────────────╯

╭────────────────────────╮       company/address keys    ╭────────────────────────────╮
│ Sunbiz logical rows    │──────────────────────────────▶│ companies/people/addresses │
╰────────────────────────╯                               ╰────────────────────────────╯

╭────────────────────────╮       company/profile keys     ╭────────────────────────────╮
│ BBB reputation rows    │──────────────────────────────▶│ companies/addresses/scores │
╰────────────────────────╯                               ╰────────────────────────────╯
```

Why this shape:

- **Type safety:** downstream apps import Drizzle tables and `$inferSelect` / `$inferInsert` types from this package.
- **Query speed:** apps query typed columns and direct joins instead of unpacking generic JSON records.
- **Lexicon alignment:** table names and important column names mirror lexicon classes/properties where practical.
- **Rerun safety:** each logical table has a stable `(source_system, source_record_key)` unique key plus `source_record_hash`, `source_artifact_uri`, and `loaded_at`.
- **Full fidelity:** every source-derived row keeps `source_payload`; permit rows also keep important raw text fields from Accela, and BBB profiles keep the full staged profile payload even when only some fields are promoted to typed columns.

## Rerunnable loading plan

1. Read extracted files from S3/local artifacts in deterministic order.
2. For each logical record, compute:
   - `source_system` such as `lee_appraiser`, `lee_accela`, `sunbiz`, or `bbb`
   - `source_record_key` from the natural source key, e.g. parcel id, permit number + child ordinal, document number + role, or artifact chunk key
   - `source_record_hash` from the normalized source payload
   - `source_artifact_uri` from the input S3/local artifact
3. Upsert into the target logical table on `(source_system, source_record_key)`.
4. If `source_record_hash` changed, update typed columns, `source_payload`, `source_artifact_uri`, and `loaded_at`.
5. Run matching after source-specific loads by updating direct logical FKs (`property_id`, `parcel_id`, `address_id`, `company_id`, `person_id`) rather than writing generic relationship rows.
6. Re-running the same artifact should be idempotent; running a newer artifact should insert new source keys and update changed source keys.

## Table families

### Shared logical tables

- `addresses`
- `unnormalized_addresses`
- `people`
- `companies`

### Appraisal tables

- `parcels`
- `properties`
- `ownerships`
- `taxes`
- `sales_histories`
- `property_valuations`
- `structures`
- `flood_storm_information`
- `utilities`
- `layouts`
- `lots` — lexicon `lot`; intentionally not `mappings`

### Permit tables

- `property_improvements` — the lexicon-aligned home for permits
- `inspections`
- `permit_contacts`
- `permit_events`
- `permit_fees`
- `permit_links`
- `permit_custom_fields`
- `permit_list_windows`

### Sunbiz tables

- `business_registrations`
- `business_registration_addresses`
- `business_registration_parties`
- `business_registration_annual_reports`
- `business_registration_events` — reserved for `corevent.zip` / filing history
- `sunbiz_extraction_chunks`

### BBB reputation tables

- `business_reputation_profiles`
- `business_reputation_alternate_names`
- `business_reputation_categories`
- `business_reputation_rating_reasons`
- `business_reputation_contacts`
- `business_reputation_licenses`
- `business_reputation_service_areas`
- `business_reputation_locations`
- `business_reputation_reviews`
- `business_reputation_complaints`
- `business_reputation_complaint_events`
- `business_reputation_media`
- `business_reputation_external_links`
- `contractor_quality_scores`

## Source-to-table mapping

### Lee appraisal website

Primary query path:

- `parcels.parcel_identifier` is the source parcel key.
- `properties.parcel_id` links a property to its parcel.
- `ownerships.property_id` links owners to property rows; owner strings can also link to `people` or `companies` when safely normalized.
- `taxes`, `sales_histories`, `structures`, `flood_storm_information`, `utilities`, `layouts`, and `lots` link to `properties.property_id`.

### Accela permits

Primary query path:

- `property_improvements.permit_number` / Accela ids are the source permit keys.
- `property_improvements.parcel_identifier` stores the parsed parcel number even before a parcel match exists.
- `property_improvements.parcel_id`, `property_id`, `address_id`, and `contractor_company_id` are filled when matching succeeds.
- Child rows use `property_improvement_id`.
- Accela extras stay in `more_details`, `more_details_raw_text`, `inspections_raw_text`, `processing_status_raw_text`, `raw_text`, and child extension tables.

### Sunbiz corporate quarterly data

Primary query path:

- `business_registrations.document_number` is the source company filing key.
- `business_registrations.company_id` links the registration to normalized `companies` when matched.
- `business_registration_addresses.address_id` links principal/mailing addresses to normalized addresses when matched.
- `business_registration_parties.party_person_id` / `party_company_id` link registered agents/officers after classification.
- Annual report columns are preserved on `business_registrations`; repeatable rows also land in `business_registration_annual_reports`.

### BBB business profile artifacts

Primary query path:

- `business_reputation_profiles` is the source BBB profile anchor and links to `companies.company_id` plus the primary profile `addresses.address_id` when resolvable.
- Child `business_reputation_*` tables preserve repeatable sections: alternate names, categories, rating reasons, management contacts, licenses, service areas, locations, reviews, complaints, complaint events, media, and external/social links.
- `contractor_quality_scores` stores versioned derived scores tied to both `companies` and `business_reputation_profiles`; raw BBB facts remain on the profile/child rows.
- `business_reputation_profiles.source_payload` keeps the entire staged BBB profile JSON, so every field present in the artifact remains queryable even before it has a typed column.

BBB source data should be loaded from staged JSON or JSONL profile artifacts. The current direct-collection path is the approved oracle-node Puppeteer harvester; the database loader consumes those artifacts and does not browse BBB.org itself.

## Query patterns to optimize first

1. **Parcel detail page** — parcel id to property, owners, addresses, taxes, sales, structures, permits, nearby businesses.
2. **Address search** — normalized or partial address to parcels/properties, permit history, Sunbiz registrations using that address.
3. **Permit search** — permit number, contractor name, date range, status, parcel id, or address to `property_improvements` plus contacts, fees, inspections, documents, matched property/company.
4. **Company search** — Sunbiz document number, FEI, legal name, contractor name to companies, registrations, principals/officers/agents, addresses, permits.
5. **Contractor quality search** — permit contractor to BBB profile, rating/accreditation, complaint/review evidence, and versioned score.
6. **Reconciliation** — source-system/source-key counts and changed hashes by table/artifact.

## Vercel access pattern

1. Vercel app connects to Postgres through a managed provider connection pool.
2. API routes query read-optimized logical tables and views.
3. Heavy transforms and matchers run outside request/response paths, then update direct FKs on the same logical tables.
4. JSONB fields remain available for evidence popovers/debug views but should not be the primary API contract.

Suggested first read models:

- `property_profile_view`
- `permit_search_view`
- `company_profile_view`
- `address_profile_view`

## Why not pure graph first?

Neptune remains useful as a future graph mirror, but Postgres is better as the first serving database because:

- Vercel access is simpler
- SQL handles filtering, pagination, counts, facets, and joins well
- typed logical tables preserve compile-time safety
- JSONB preserves raw source evidence
- the same normalized facts can later be projected into Neptune if graph algorithms become important
