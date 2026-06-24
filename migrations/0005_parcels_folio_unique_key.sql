-- Migration: re-key parcel dedup on the folio (request_identifier) instead of
-- the digits-only normalized parcel_identifier.
--
-- Background: parcels were upserted with ON CONFLICT (jurisdiction_key,
-- parcel_identifier), where parcel_identifier was the DIGITS-ONLY normalized
-- form (normalizeParcelIdentifier strips all non-digits). That collapsed
-- genuinely-distinct parcels whose STRAP contains letters — e.g. Lee condo
-- units `…0001A/0001B/0001C` and mid-string-letter STRAPs (`…9A0/9B0/9C0` →
-- `…90`) all hashed to one key. Result: ~31k distinct parcels lost and ~20.9k
-- orphaned `properties` (parcel_id NULL).
--
-- Fix: key parcels on request_identifier (the folioID), which is 1:1 with the
-- raw STRAP (516,841 distinct seed STRAPs == 516,841 distinct folios). The child
-- tables already resolve their parent FK via the folio-based source_record_key
-- (lee_appraiser:<folio>:parcel:property_seed), so keying parcels on the folio
-- aligns parents and children and eliminates the orphans. parcel_identifier is
-- retained as the RAW STRAP for display/reference (letters preserved); the
-- digits-only normalized form is still used for cross-source MATCHING at read
-- time (see src/loader/scoped-load.ts).
--
-- IMPORTANT: a clean full re-load of all parcels from S3 is required after this
-- migration. A plain re-run on the existing data keeps colliding because the
-- already-loaded rows were deduped under the old digits-only key.
--
-- request_identifier is always populated on the parcels write spec (mapParcel),
-- so SET NOT NULL is safe; the guard below fails loudly if a stray NULL exists.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "parcels" WHERE "request_identifier" IS NULL) THEN
    RAISE EXCEPTION 'parcels.request_identifier has NULL rows; backfill before applying NOT NULL';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "parcels" DROP CONSTRAINT IF EXISTS "parcels_jurisdiction_key_parcel_identifier_unique";--> statement-breakpoint
ALTER TABLE "parcels" ALTER COLUMN "request_identifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_jurisdiction_key_request_identifier_unique" UNIQUE("jurisdiction_key","request_identifier");
