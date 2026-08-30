ALTER TABLE "overture_place_extractions"
  ADD COLUMN IF NOT EXISTS "previous_release" text,
  ADD COLUMN IF NOT EXISTS "run_status" text DEFAULT 'loaded' NOT NULL,
  ADD COLUMN IF NOT EXISTS "active_change_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "deactivation_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "added_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "data_changed_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "removed_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "moved_in_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "moved_out_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "taxonomy_drift" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "published_cid" text,
  ADD COLUMN IF NOT EXISTS "published_ipns_name" text,
  ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "overture_place_extractions"
  DROP CONSTRAINT IF EXISTS "overture_place_extractions_run_status_check";
--> statement-breakpoint
UPDATE "overture_place_extractions" extraction
SET "run_status" = 'succeeded',
    "published_cid" = coverage."cid",
    "finished_at" = COALESCE(extraction."updated_at", now())
FROM "oracle_dataset_coverage" coverage
WHERE extraction."county_key" = 'lee'
  AND extraction."overture_release" = '2026-07-22.0'
  AND extraction."licence_gate_passed" = true
  AND coverage."county" = 'lee'
  AND coverage."source" = 'overture_places'
  AND coverage."cid" IS NOT NULL
  AND extraction."run_status" = 'loaded';
--> statement-breakpoint
ALTER TABLE "overture_place_extractions"
  ADD CONSTRAINT "overture_place_extractions_run_status_check"
  CHECK ("run_status" IN ('loaded', 'succeeded'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "overture_place_extractions_county_status_release_idx"
  ON "overture_place_extractions" ("county_key", "run_status", "overture_release");
