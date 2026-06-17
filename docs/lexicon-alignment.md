# Lexicon Alignment

The local lexicon at `../lexicon/src/data/lexicon.json` is class/container based. This package uses that lexicon as naming guidance, but it does **not** create generic lexicon database tables.

## Core mapping rules

1. `classes[].container_name` becomes the preferred logical table name.
2. Lexicon property names are preserved as SQL column names when they are important query fields.
3. Each logical table owns its own primary key, e.g. `property_id`, `parcel_id`, `property_improvement_id`, `business_registration_id`.
4. Lexicon relationship concepts become direct typed foreign keys where useful, e.g. `properties.parcel_id`, `property_improvements.address_id`, `business_registration_addresses.address_id`.
5. Generated lexicon metadata remains available from `src/lexicon/generated.ts` for codegen/docs/tests, but it is not part of the migration surface.
6. Raw/source values that are not lexicon-normalized yet are kept in `source_payload`, raw text columns, and source-specific extension tables.

## Classes used by the first schema

| Lexicon class | Table | Main source tracks |
| --- | --- | --- |
| `address` | `addresses` | appraisal, permits, Sunbiz |
| `unnormalized_address` | `unnormalized_addresses` | appraisal seeds/searches |
| `parcel` | `parcels` | appraisal, permits |
| `property` | `properties` | appraisal |
| `ownership` | `ownerships` | appraisal |
| `person` | `people` | appraisal owners, permit contacts, Sunbiz parties |
| `company` | `companies` | appraisal owners, permit contractors, Sunbiz entities |
| `tax` | `taxes` | appraisal |
| `sales_history` | `sales_histories` | appraisal |
| `property_valuation` | `property_valuations` | appraisal / valuation outputs |
| `structure` | `structures` | appraisal building details, permit-derived roof/window/etc. facts |
| `flood_storm_information` | `flood_storm_information` | appraisal flood/elevation details |
| `utility` | `utilities` | appraisal utility/HVAC/plumbing/electrical details |
| `layout` | `layouts` | appraisal room/layout/pool details |
| `lot` | `lots` | appraisal lot/site details; deliberately not `mappings` because that container is shared with the `mapping` class |
| `property_improvement` | `property_improvements` | permits |
| `inspection` | `inspections` | permits |
| `business_registration` | `business_registrations` | Sunbiz |
| `business_registration_address` | `business_registration_addresses` | Sunbiz |
| `business_registration_party` | `business_registration_parties` | Sunbiz |

## Relationship concepts represented as direct keys

### Appraisal/property

- `property_has_parcel` → `properties.parcel_id`
- `property_has_tax` → `taxes.property_id`
- `property_has_sales_history` → `sales_histories.property_id`
- `property_has_structure` → `structures.property_id`
- `property_has_flood_storm_information` → `flood_storm_information.property_id`
- `property_has_utility` → `utilities.property_id`
- `property_has_layout` → `layouts.property_id`
- `property_has_lot` → `lots.property_id`
- owner/person/company links → `ownerships.owner_person_id` / `ownerships.owner_company_id`

### Permits/property improvements

- `property_has_property_improvement` → `property_improvements.property_id`
- `parcel_has_property_improvement` → `property_improvements.parcel_id`
- `property_improvement_has_address` → `property_improvements.address_id`
- `property_improvement_has_contractor` → `property_improvements.contractor_company_id`
- `property_improvement_has_inspection` → `inspections.property_improvement_id`
- permit contacts/fees/events/files/custom fields → `permit_*`.`property_improvement_id`

### Sunbiz

- `company_has_business_registration` → `business_registrations.company_id`
- `business_registration_has_address` → `business_registration_addresses.business_registration_id`
- `business_registration_address_has_address` → `business_registration_addresses.address_id`
- `business_registration_has_party` → `business_registration_parties.business_registration_id`
- `business_registration_party_has_address` → `business_registration_parties.address_id`
- party person/company classification → `business_registration_parties.party_person_id` / `party_company_id`

## Practical compromise

Not every lexicon class gets a dedicated table in the first migration. The schema only creates tables needed for the three active data tracks. If a future source exposes a new repeatable concept, add a logical table for that concept instead of routing it through a generic entity table.
