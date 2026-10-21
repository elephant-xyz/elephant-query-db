CREATE TABLE "bbb_artifact_watermarks" (
	"bbb_artifact_watermark_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bbb_harvest_category_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"artifact_uri" text,
	"artifact_sha256" text NOT NULL,
	"previous_artifact_sha256" text,
	"artifact_bytes" integer NOT NULL,
	"record_count" integer NOT NULL,
	"merged_count" integer NOT NULL,
	"tombstone_count" integer DEFAULT 0 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"retired_at" timestamp with time zone,
	"retirement_reason" text,
	"last_merged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_artifact_watermarks_nonnegative_counts_check" CHECK ("bbb_artifact_watermarks"."artifact_bytes" >= 0
        AND "bbb_artifact_watermarks"."record_count" >= 0
        AND "bbb_artifact_watermarks"."merged_count" >= 0
        AND "bbb_artifact_watermarks"."tombstone_count" >= 0),
	CONSTRAINT "bbb_artifact_watermarks_retirement_check" CHECK (("bbb_artifact_watermarks"."is_current" = true
          AND "bbb_artifact_watermarks"."retired_at" IS NULL
          AND "bbb_artifact_watermarks"."retirement_reason" IS NULL)
        OR
        ("bbb_artifact_watermarks"."is_current" = false
          AND "bbb_artifact_watermarks"."retired_at" IS NOT NULL
          AND "bbb_artifact_watermarks"."retirement_reason" = 'removed_from_corrected_manifest'))
);
--> statement-breakpoint
CREATE TABLE "bbb_harvest_categories" (
	"bbb_harvest_category_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bbb_harvest_run_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"category_url" text NOT NULL,
	"job_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"request_sha256" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"manifest_artifact_uri" text,
	"source_access_status" text NOT NULL,
	"complete_within_bounds" boolean NOT NULL,
	"advertised_results" integer,
	"category_pages_visited" integer DEFAULT 0 NOT NULL,
	"profiles_selected" integer DEFAULT 0 NOT NULL,
	"profiles_harvested" integer DEFAULT 0 NOT NULL,
	"profiles_failed_permanent" integer DEFAULT 0 NOT NULL,
	"source_access_evidence" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_harvest_categories_nonnegative_counts_check" CHECK ("bbb_harvest_categories"."category_pages_visited" >= 0
        AND "bbb_harvest_categories"."profiles_selected" >= 0
        AND "bbb_harvest_categories"."profiles_harvested" >= 0
        AND "bbb_harvest_categories"."profiles_failed_permanent" >= 0),
	CONSTRAINT "bbb_harvest_categories_access_status_check" CHECK ("bbb_harvest_categories"."source_access_status" IN (
        'accessible',
        'blocked',
        'not_attempted_after_source_block',
        'incomplete'
      ))
);
--> statement-breakpoint
CREATE TABLE "bbb_harvest_runs" (
	"bbb_harvest_run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"county_key" text NOT NULL,
	"run_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"source" text NOT NULL,
	"bundle_sha256" text NOT NULL,
	"reconciliation_manifest_sha256" text NOT NULL,
	"profiles_sha256" text,
	"source_access_status" text NOT NULL,
	"source_access_complete" boolean NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"category_count" integer DEFAULT 0 NOT NULL,
	"raw_profile_count" integer DEFAULT 0 NOT NULL,
	"unique_profile_count" integer DEFAULT 0 NOT NULL,
	"duplicate_profile_count" integer DEFAULT 0 NOT NULL,
	"permanent_failure_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"source_artifact_uri" text,
	"source_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_harvest_runs_nonnegative_counts_check" CHECK ("bbb_harvest_runs"."category_count" >= 0
        AND "bbb_harvest_runs"."raw_profile_count" >= 0
        AND "bbb_harvest_runs"."unique_profile_count" >= 0
        AND "bbb_harvest_runs"."duplicate_profile_count" >= 0
        AND "bbb_harvest_runs"."permanent_failure_count" >= 0),
	CONSTRAINT "bbb_harvest_runs_access_status_check" CHECK ("bbb_harvest_runs"."source_access_status" IN ('accessible', 'blocked', 'incomplete'))
);
--> statement-breakpoint
CREATE TABLE "bbb_profile_category_memberships" (
	"bbb_profile_category_membership_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bbb_harvest_category_id" uuid NOT NULL,
	"bbb_artifact_watermark_id" uuid NOT NULL,
	"bbb_profile_snapshot_id" uuid NOT NULL,
	"profile_source_key" text NOT NULL,
	"artifact_relative_path" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"retired_at" timestamp with time zone,
	"retirement_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_profile_memberships_retirement_check" CHECK (("bbb_profile_category_memberships"."is_current" = true
          AND "bbb_profile_category_memberships"."retired_at" IS NULL
          AND "bbb_profile_category_memberships"."retirement_reason" IS NULL)
        OR
        ("bbb_profile_category_memberships"."is_current" = false
          AND "bbb_profile_category_memberships"."retired_at" IS NOT NULL
          AND "bbb_profile_category_memberships"."retirement_reason" IN (
            'missing_from_corrected_artifact',
            'superseded_by_corrected_snapshot',
            'superseded_by_corrected_artifact'
          )))
);
--> statement-breakpoint
CREATE TABLE "bbb_profile_snapshots" (
	"bbb_profile_snapshot_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'BBB' NOT NULL,
	"provider_profile_key" text NOT NULL,
	"provider_business_key" text NOT NULL,
	"provider_profile_id" text,
	"provider_business_id" text,
	"provider_bbb_id" text,
	"profile_url" text NOT NULL,
	"name" text,
	"legal_name" text,
	"normalized_names" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"normalized_phones" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"license_identifiers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"is_accredited" boolean,
	"bbb_rating" text,
	"review_count" integer,
	"complaint_count" integer,
	"source_retrieved_at" timestamp with time zone,
	"snapshot_as_of" timestamp with time zone NOT NULL,
	"extraction_schema_version" text NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"extracted_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_artifact_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_profile_snapshots_count_check" CHECK (("bbb_profile_snapshots"."review_count" IS NULL OR "bbb_profile_snapshots"."review_count" >= 0)
        AND ("bbb_profile_snapshots"."complaint_count" IS NULL OR "bbb_profile_snapshots"."complaint_count" >= 0))
);
--> statement-breakpoint
CREATE TABLE "bbb_property_link_evidence" (
	"bbb_property_link_evidence_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bbb_reconciliation_match_id" uuid NOT NULL,
	"property_improvement_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"permit_source_system" text NOT NULL,
	"permit_source_record_key" text NOT NULL,
	"official_evidence_key" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"snapshot_as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bbb_reconciliation_matches" (
	"bbb_reconciliation_match_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bbb_reconciliation_run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"representative_profile_snapshot_id" uuid,
	"official_identity_key" text NOT NULL,
	"provider_business_key" text,
	"candidate_key" text NOT NULL,
	"outcome" text NOT NULL,
	"match_method" text,
	"confidence" numeric(5, 4),
	"official_name" text,
	"official_normalized_name" text,
	"official_license_identifiers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"official_phone_identifiers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"evidence_sha256" text NOT NULL,
	"evidence_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_reconciliation_matches_outcome_check" CHECK ("bbb_reconciliation_matches"."outcome" IN ('accepted', 'review', 'ambiguous', 'unmatched')),
	CONSTRAINT "bbb_reconciliation_matches_accepted_tier_check" CHECK ("bbb_reconciliation_matches"."outcome" <> 'accepted'
        OR (
          "bbb_reconciliation_matches"."representative_profile_snapshot_id" IS NOT NULL
          AND "bbb_reconciliation_matches"."provider_business_key" IS NOT NULL
          AND "bbb_reconciliation_matches"."match_method" IN (
            'exact_state_license',
            'exact_standardized_phone',
            'unique_exact_normalized_business_name'
          )
        )),
	CONSTRAINT "bbb_reconciliation_matches_fuzzy_review_only_check" CHECK ("bbb_reconciliation_matches"."match_method" <> 'jaro_winkler_cleaned_business_name'
        OR "bbb_reconciliation_matches"."outcome" IN ('review', 'ambiguous')),
	CONSTRAINT "bbb_reconciliation_matches_unmatched_check" CHECK ("bbb_reconciliation_matches"."outcome" <> 'unmatched'
        OR (
          "bbb_reconciliation_matches"."representative_profile_snapshot_id" IS NULL
          AND "bbb_reconciliation_matches"."provider_business_key" IS NULL
          AND "bbb_reconciliation_matches"."match_method" IS NULL
        )),
	CONSTRAINT "bbb_reconciliation_matches_confidence_check" CHECK ("bbb_reconciliation_matches"."confidence" IS NULL
        OR ("bbb_reconciliation_matches"."confidence" >= 0 AND "bbb_reconciliation_matches"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "bbb_reconciliation_runs" (
	"bbb_reconciliation_run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bbb_harvest_run_id" uuid NOT NULL,
	"reconciliation_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"official_evidence_sha256" text NOT NULL,
	"official_evidence_artifact_uri" text,
	"status" text NOT NULL,
	"source_coverage_complete" boolean NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"official_identity_count" integer DEFAULT 0 NOT NULL,
	"official_company_count" integer DEFAULT 0 NOT NULL,
	"accepted_match_count" integer DEFAULT 0 NOT NULL,
	"review_candidate_count" integer DEFAULT 0 NOT NULL,
	"ambiguous_candidate_count" integer DEFAULT 0 NOT NULL,
	"unmatched_count" integer DEFAULT 0 NOT NULL,
	"accepted_property_link_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bbb_reconciliation_runs_status_check" CHECK ("bbb_reconciliation_runs"."status" IN ('completed', 'incomplete_source')),
	CONSTRAINT "bbb_reconciliation_runs_nonnegative_counts_check" CHECK ("bbb_reconciliation_runs"."official_identity_count" >= 0
        AND "bbb_reconciliation_runs"."official_company_count" >= 0
        AND "bbb_reconciliation_runs"."accepted_match_count" >= 0
        AND "bbb_reconciliation_runs"."review_candidate_count" >= 0
        AND "bbb_reconciliation_runs"."ambiguous_candidate_count" >= 0
        AND "bbb_reconciliation_runs"."unmatched_count" >= 0
        AND "bbb_reconciliation_runs"."accepted_property_link_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "bbb_artifact_watermarks" ADD CONSTRAINT "bbb_artifact_watermarks_bbb_harvest_category_id_bbb_harvest_categories_bbb_harvest_category_id_fk" FOREIGN KEY ("bbb_harvest_category_id") REFERENCES "public"."bbb_harvest_categories"("bbb_harvest_category_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_harvest_categories" ADD CONSTRAINT "bbb_harvest_categories_bbb_harvest_run_id_bbb_harvest_runs_bbb_harvest_run_id_fk" FOREIGN KEY ("bbb_harvest_run_id") REFERENCES "public"."bbb_harvest_runs"("bbb_harvest_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_profile_category_memberships" ADD CONSTRAINT "bbb_profile_category_memberships_bbb_harvest_category_id_bbb_harvest_categories_bbb_harvest_category_id_fk" FOREIGN KEY ("bbb_harvest_category_id") REFERENCES "public"."bbb_harvest_categories"("bbb_harvest_category_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_profile_category_memberships" ADD CONSTRAINT "bbb_profile_category_memberships_bbb_artifact_watermark_id_bbb_artifact_watermarks_bbb_artifact_watermark_id_fk" FOREIGN KEY ("bbb_artifact_watermark_id") REFERENCES "public"."bbb_artifact_watermarks"("bbb_artifact_watermark_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_profile_category_memberships" ADD CONSTRAINT "bbb_profile_category_memberships_bbb_profile_snapshot_id_bbb_profile_snapshots_bbb_profile_snapshot_id_fk" FOREIGN KEY ("bbb_profile_snapshot_id") REFERENCES "public"."bbb_profile_snapshots"("bbb_profile_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_property_link_evidence" ADD CONSTRAINT "bbb_property_link_evidence_bbb_reconciliation_match_id_bbb_reconciliation_matches_bbb_reconciliation_match_id_fk" FOREIGN KEY ("bbb_reconciliation_match_id") REFERENCES "public"."bbb_reconciliation_matches"("bbb_reconciliation_match_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_property_link_evidence" ADD CONSTRAINT "bbb_property_link_evidence_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_property_link_evidence" ADD CONSTRAINT "bbb_property_link_evidence_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_property_link_evidence" ADD CONSTRAINT "bbb_property_link_evidence_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_reconciliation_matches" ADD CONSTRAINT "bbb_reconciliation_matches_bbb_reconciliation_run_id_bbb_reconciliation_runs_bbb_reconciliation_run_id_fk" FOREIGN KEY ("bbb_reconciliation_run_id") REFERENCES "public"."bbb_reconciliation_runs"("bbb_reconciliation_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_reconciliation_matches" ADD CONSTRAINT "bbb_reconciliation_matches_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_reconciliation_matches" ADD CONSTRAINT "bbb_reconciliation_matches_representative_profile_snapshot_id_bbb_profile_snapshots_bbb_profile_snapshot_id_fk" FOREIGN KEY ("representative_profile_snapshot_id") REFERENCES "public"."bbb_profile_snapshots"("bbb_profile_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bbb_reconciliation_runs" ADD CONSTRAINT "bbb_reconciliation_runs_bbb_harvest_run_id_bbb_harvest_runs_bbb_harvest_run_id_fk" FOREIGN KEY ("bbb_harvest_run_id") REFERENCES "public"."bbb_harvest_runs"("bbb_harvest_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_artifact_watermarks_category_path_idx" ON "bbb_artifact_watermarks" USING btree ("bbb_harvest_category_id","relative_path");--> statement-breakpoint
CREATE INDEX "bbb_artifact_watermarks_hash_idx" ON "bbb_artifact_watermarks" USING btree ("artifact_sha256");--> statement-breakpoint
CREATE INDEX "bbb_artifact_watermarks_current_idx" ON "bbb_artifact_watermarks" USING btree ("bbb_harvest_category_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_harvest_categories_run_category_idx" ON "bbb_harvest_categories" USING btree ("bbb_harvest_run_id","category_key");--> statement-breakpoint
CREATE INDEX "bbb_harvest_categories_status_idx" ON "bbb_harvest_categories" USING btree ("source_access_status","complete_within_bounds");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_harvest_runs_county_run_idx" ON "bbb_harvest_runs" USING btree ("county_key","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_harvest_runs_current_county_idx" ON "bbb_harvest_runs" USING btree ("county_key") WHERE "bbb_harvest_runs"."is_current" = true;--> statement-breakpoint
CREATE INDEX "bbb_harvest_runs_status_idx" ON "bbb_harvest_runs" USING btree ("county_key","source_access_status","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_profile_memberships_revision_profile_idx" ON "bbb_profile_category_memberships" USING btree ("bbb_harvest_category_id","artifact_relative_path","artifact_sha256","profile_source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_profile_memberships_current_profile_idx" ON "bbb_profile_category_memberships" USING btree ("bbb_harvest_category_id","artifact_relative_path","profile_source_key") WHERE "bbb_profile_category_memberships"."is_current" = true;--> statement-breakpoint
CREATE INDEX "bbb_profile_memberships_snapshot_idx" ON "bbb_profile_category_memberships" USING btree ("bbb_profile_snapshot_id");--> statement-breakpoint
CREATE INDEX "bbb_profile_memberships_current_idx" ON "bbb_profile_category_memberships" USING btree ("bbb_harvest_category_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_profile_snapshots_identity_hash_idx" ON "bbb_profile_snapshots" USING btree ("provider","provider_profile_key","snapshot_sha256");--> statement-breakpoint
CREATE INDEX "bbb_profile_snapshots_business_idx" ON "bbb_profile_snapshots" USING btree ("provider","provider_business_key");--> statement-breakpoint
CREATE INDEX "bbb_profile_snapshots_profile_url_idx" ON "bbb_profile_snapshots" USING btree ("profile_url");--> statement-breakpoint
CREATE INDEX "bbb_profile_snapshots_names_gin" ON "bbb_profile_snapshots" USING gin ("normalized_names");--> statement-breakpoint
CREATE INDEX "bbb_profile_snapshots_phones_gin" ON "bbb_profile_snapshots" USING gin ("normalized_phones");--> statement-breakpoint
CREATE INDEX "bbb_profile_snapshots_licenses_gin" ON "bbb_profile_snapshots" USING gin ("license_identifiers");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_property_link_evidence_match_permit_idx" ON "bbb_property_link_evidence" USING btree ("bbb_reconciliation_match_id","property_improvement_id","property_id");--> statement-breakpoint
CREATE INDEX "bbb_property_link_evidence_property_idx" ON "bbb_property_link_evidence" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "bbb_property_link_evidence_permit_idx" ON "bbb_property_link_evidence" USING btree ("property_improvement_id");--> statement-breakpoint
CREATE INDEX "bbb_property_link_evidence_company_idx" ON "bbb_property_link_evidence" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bbb_property_link_evidence_source_key_idx" ON "bbb_property_link_evidence" USING btree ("permit_source_system","permit_source_record_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_reconciliation_matches_candidate_idx" ON "bbb_reconciliation_matches" USING btree ("bbb_reconciliation_run_id","official_identity_key","candidate_key");--> statement-breakpoint
CREATE INDEX "bbb_reconciliation_matches_company_outcome_idx" ON "bbb_reconciliation_matches" USING btree ("company_id","outcome");--> statement-breakpoint
CREATE INDEX "bbb_reconciliation_matches_profile_idx" ON "bbb_reconciliation_matches" USING btree ("representative_profile_snapshot_id");--> statement-breakpoint
CREATE INDEX "bbb_reconciliation_matches_business_idx" ON "bbb_reconciliation_matches" USING btree ("provider_business_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_reconciliation_runs_key_idx" ON "bbb_reconciliation_runs" USING btree ("bbb_harvest_run_id","reconciliation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bbb_reconciliation_runs_current_idx" ON "bbb_reconciliation_runs" USING btree ("bbb_harvest_run_id") WHERE "bbb_reconciliation_runs"."is_current" = true;--> statement-breakpoint
CREATE INDEX "bbb_reconciliation_runs_status_idx" ON "bbb_reconciliation_runs" USING btree ("status","finished_at");