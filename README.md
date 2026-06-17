# Elephant Query DB

Type-safe Node/TypeScript package for the queryable Postgres database that serves normalized Elephant oracle data to apps such as Vercel frontends.

The schema is Postgres-first, lexicon-aligned, and intentionally **logical-table only**:

- no generic `ingest.raw_records`, `lexicon.entities`, `lexicon.relationships`, or generic matching tables are created
- tables use Elephant lexicon container names where possible (`addresses`, `parcels`, `properties`, `property_improvements`, `business_registrations`, `business_reputation_profiles`, etc.)
- relationships are represented with direct typed foreign keys such as `properties.parcel_id`, `property_improvements.parcel_id`, and `business_registrations.company_id`
- reruns/upserts use per-table `source_system`, `source_record_key`, `source_record_hash`, `source_artifact_uri`, and `loaded_at` columns
- source data is preserved in each logical row through `source_payload` / source-specific raw-text columns so we can remap when the lexicon expands

## Contents

- [`docs/schema-design.md`](docs/schema-design.md) — logical table families, rerun/idempotency model, and Vercel access pattern
- [`docs/lexicon-alignment.md`](docs/lexicon-alignment.md) — how local lexicon classes map into typed tables and direct foreign keys
- [`docs/open-lexicon-gaps.md`](docs/open-lexicon-gaps.md) — permit/Sunbiz/appraisal facts that should later be promoted into the lexicon
- [`src/schema`](src/schema) — Drizzle schema-as-code source of truth
- [`migrations`](migrations) — generated SQL migrations from Drizzle; do not hand-edit unless a migration needs a deliberate SQL-only operation
- [`src/lexicon/generated.ts`](src/lexicon/generated.ts) — generated compile-time class/relationship metadata from `../lexicon/src/data/lexicon.json`

## Package usage

Downstream services should import the schema and types from this package instead of copying SQL definitions:

```ts
import { businessRegistrations, propertyImprovements, type PropertyImprovement } from "@elephant-xyz/query-db";
```

The Postgres database can live in Neon, Supabase, RDS, or another Postgres provider. This package gives apps shared Drizzle table objects, generated migrations, and `$inferSelect` / `$inferInsert` types.

## Development commands

```bash
npm install
npm run generate:lexicon
npm run typecheck
npm run test
npm run build
npm run generate:migrations
```

Regenerate migrations from the TypeScript schema with `npm run generate:migrations`; checked-in migration files are artifacts, not the schema source of truth.

## Current scope

This design covers the active Lee County ingestion tracks:

1. appraisal/property appraiser data
2. Accela permit data, modeled primarily as `property_improvements`
3. Sunbiz quarterly corporate registration data
4. BBB business reputation profile artifacts for contractor quality scoring

The initial database is optimized for parcel, address, company, person, permit, business-registration, and contractor-reputation searches while retaining enough source evidence to rerun loaders safely and backfill new columns later.

BBB data is loaded from staged JSON or JSONL profile artifacts. Those artifacts can come from an approved browser harvest produced by `oracle-node/scripts/harvest-bbb-category.mjs` or from a feed/export with a compatible profile shape. The loader maps known BBB sections into `business_reputation_*` child tables and keeps the complete profile JSON in `business_reputation_profiles.source_payload`, so newly discovered BBB fields remain queryable and can be promoted into typed columns later without losing data.

Example bulk-stage/load command for BBB-only input:

```bash
npm run load:bulk -- \
  --tracks bbb \
  --bbb-prefix permit-harvest/bbb/category-data/browser-harvest-v1/profiles/
```
