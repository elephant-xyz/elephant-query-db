# Open Lexicon Gaps

These are facts we should preserve in Postgres now and consider adding to the Elephant lexicon later.

## Permit / Accela gaps

Current best lexicon class: `property_improvement`.

Missing or weakly represented facts:

- dedicated `permit` or `jurisdiction_record` class
- Accela record id / alt id / module / record type hierarchy
- permit description and work-location details
- contacts by role: applicant, owner, contractor, licensed professional, architect, engineer
- contractor license numbers and license status
- workflow/status events with event date, actor, comments, and task name
- fee line items, payment status, assessed amount, paid amount, balance
- inspection comments, inspectors, result text, scheduling windows
- documents/attachments with document type, S3 URI, source URL, upload date
- custom field groups and field names from Accela

Current schema handling:

- main permit facts land in `property_improvements`
- contacts/events/fees/document links/custom fields land in `permit_*` extension tables
- full Accela payload remains in `source_payload` for every related row

## Sunbiz gaps

New classes now exist locally for:

- `business_registration`
- `business_registration_address`
- `business_registration_party`

Still missing or weakly represented facts:

- `business_registration_event` for `corevent.zip` filing history
- annual reports as repeatable child records instead of three fixed fields
- registered agent/officer party normalization into person/company subclasses
- explicit FEI normalization/visibility policy
- document image links and filing document metadata

Current schema handling:

- quarterly corporate records land in `business_registrations`
- principal/mailing address roles land in `business_registration_addresses`
- registered agents and officers land in `business_registration_parties`
- future `corevent.zip` records land in `business_registration_events`

## Appraisal gaps

Current lexicon coverage is broad, and the schema now has typed projections for property, parcel, ownership, tax, sale, structure, flood/storm, utility, layout, and lot output files. The Lee County appraiser source may still expose source-specific facts that need decisions:

- appraisal land lines / land use rows as repeatable child records
- parcel geometry quality and source CRS metadata
- tax district/millage breakdowns by authority
- exemption detail rows by exemption code/year
- building/extra feature rows that do not map cleanly to `structure` or `layout`
- owner name strings that cannot be safely split into person/company

Current schema handling:

- appraiser core facts land in existing lexicon-aligned typed tables
- ambiguous details should stay in `source_payload` until a reliable mapper exists
- matching decisions should update direct logical foreign keys only when confidence is high; otherwise keep the unmatched evidence in typed columns and `source_payload`

## Overture places / `business_location` gaps

Places do **not** map onto an existing lexicon class. `company` is a party (name, request identifier, source request) and is the shared parent every other track FKs into — loading 40k Lee places there would pollute it. **`nearby_location` looks like the answer and is not**: it is property-relative (`distance_miles`, `is_walkable`), its `location_type` is a closed 13-value lifestyle enum, and it has no identity, geometry, or operating status of its own. It is a marketing projection *derived from* places.

Follow the Sunbiz precedent: tables land in Neon now; the lexicon class is a separate tracked PR. The Sunbiz analogue classes (`business_registration*`) were described as added locally and are **not** on `lexicon` `main` as of 2026-08-12 — track the places lexicon PR URL or this one will not land either.

Proposed class (not landed in this pass): `business_location`.

Facts preserved in Postgres now:

- GERS id, Overture release stamp, `taxonomy.primary` / `taxonomy.hierarchy` / `taxonomy.alternate`, `basic_category` (Overture labels passed through; no Elephant vocabulary mapping)
- `legacy_category_primary` until the September 2026 Overture release removes `categories`
- point geometry (EPSG:4326), operating status, confidence, brand, websites/phones/emails
- per-record `sources[]` (licence gate + GERS bridge-file fallback)
- advisory `is_hosted_service` + `hosted_service_rule`
- `first_seen_release` / `last_seen_release` / `is_current` (absence is not closure)

Current schema handling:

- places land in `business_locations` with children `business_location_categories` and `business_location_sources`
- `overture_place_extractions` holds the honest per-(county, release) denominators; `oracle_dataset_coverage.expected_count` is NULL
- `address_id` is a soft link (`ON DELETE SET NULL`); **`company_id` is never written at ingest**
- `business_location_parcel_links` is schema-only; point-in-polygon linking is a later step
- full Overture record remains in `source_payload`
