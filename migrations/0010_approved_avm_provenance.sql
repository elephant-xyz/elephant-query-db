ALTER TABLE "property_valuations" ADD COLUMN "request_identifier" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "vendor_property_id" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "county_fips" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "source_profile_id" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "publication_permitted" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "publication_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "license_review_reference" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "source_manifest_sha256" text;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD COLUMN "source_records_sha256" text;--> statement-breakpoint
CREATE INDEX "property_valuations_approved_property_date_idx" ON "property_valuations" USING btree ("property_id","publication_permitted","valuation_date");--> statement-breakpoint
ALTER TABLE "property_valuations" ADD CONSTRAINT "property_valuations_bounds_check" CHECK ("property_valuations"."current_avm_value" IS NULL OR (
        "property_valuations"."current_avm_value" > 0
        AND ("property_valuations"."low_value" IS NULL OR "property_valuations"."low_value" <= "property_valuations"."current_avm_value")
        AND ("property_valuations"."high_value" IS NULL OR "property_valuations"."high_value" >= "property_valuations"."current_avm_value")
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD CONSTRAINT "property_valuations_publication_approval_check" CHECK ("property_valuations"."publication_permitted" IS NOT TRUE OR (
        "property_valuations"."property_id" IS NOT NULL
        AND "property_valuations"."request_identifier" IS NOT NULL
        AND "property_valuations"."current_avm_value" IS NOT NULL
        AND "property_valuations"."valuation_date" IS NOT NULL
        AND "property_valuations"."valuation_method_type" IS NOT NULL
        AND "property_valuations"."confidence_score" IS NOT NULL
        AND "property_valuations"."low_value" IS NOT NULL
        AND "property_valuations"."high_value" IS NOT NULL
        AND "property_valuations"."provider" IS NOT NULL
        AND "property_valuations"."vendor_property_id" IS NOT NULL
        AND "property_valuations"."county_fips" ~ '^[0-9]{5}$'
        AND "property_valuations"."source_profile_id" IS NOT NULL
        AND "property_valuations"."publication_approved_at" IS NOT NULL
        AND "property_valuations"."license_review_reference" IS NOT NULL
        AND "property_valuations"."source_record_hash" ~ '^[a-f0-9]{64}$'
        AND "property_valuations"."source_artifact_uri" IS NOT NULL
        AND "property_valuations"."source_manifest_sha256" ~ '^[a-f0-9]{64}$'
        AND "property_valuations"."source_records_sha256" ~ '^[a-f0-9]{64}$'
      )) NOT VALID;