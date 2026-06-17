CREATE TABLE "business_reputation_alternate_names" (
	"business_reputation_alternate_name_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"alternate_name" text NOT NULL,
	"normalized_name" text,
	"name_type" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_categories" (
	"business_reputation_category_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"category_name" text NOT NULL,
	"category_code" text,
	"category_url" text,
	"is_primary" boolean,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_complaint_events" (
	"business_reputation_complaint_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_complaint_id" uuid NOT NULL,
	"event_date" date,
	"event_type" text NOT NULL,
	"actor_name" text,
	"actor_role" text,
	"event_text" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_complaints" (
	"business_reputation_complaint_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"provider_complaint_id" text,
	"complaint_date" date,
	"complaint_closed_date" date,
	"complaint_type" text,
	"complaint_category" text,
	"complaint_status" text,
	"complaint_summary" text,
	"complaint_text" text,
	"desired_outcome" text,
	"resolution_text" text,
	"customer_display_name" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_contacts" (
	"business_reputation_contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"person_id" uuid,
	"contact_name" text NOT NULL,
	"normalized_name" text,
	"title" text,
	"role" text,
	"phone" text,
	"email" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_external_links" (
	"business_reputation_external_link_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"link_kind" text NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_licenses" (
	"business_reputation_license_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"license_number" text,
	"license_type" text,
	"license_status" text,
	"agency" text,
	"jurisdiction" text,
	"issue_date" date,
	"expiration_date" date,
	"raw_text" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_locations" (
	"business_reputation_location_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"address_id" uuid,
	"relationship_type" text NOT NULL,
	"location_name" text,
	"provider_profile_id" text,
	"provider_business_id" text,
	"provider_bbb_id" text,
	"profile_url" text,
	"phone" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_media" (
	"business_reputation_media_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"media_kind" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"description" text,
	"content_type" text,
	"storage_uri" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_profiles" (
	"business_reputation_profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"address_id" uuid,
	"request_identifier" text,
	"provider" text,
	"provider_profile_id" text,
	"provider_business_id" text,
	"provider_bbb_id" text,
	"profile_url" text,
	"profile_type" text,
	"profile_slug" text,
	"local_bbb_name" text,
	"local_bbb_url" text,
	"name" text,
	"legal_name" text,
	"normalized_name" text,
	"description" text,
	"phone" text,
	"email" text,
	"email_url" text,
	"website_url" text,
	"is_accredited" boolean,
	"accreditation_status" text,
	"accredited_since" date,
	"accreditation_revoked_date" date,
	"bbb_rating" text,
	"rating_score" numeric(6, 2),
	"rating_reason_not_rated" text,
	"review_average_rating" numeric(5, 2),
	"review_count" integer,
	"complaint_count" integer,
	"closed_complaints_past_three_years" integer,
	"closed_complaints_past_twelve_months" integer,
	"unanswered_complaints" integer,
	"bbb_file_opened_date" date,
	"business_started_date" date,
	"business_local_started_date" date,
	"business_incorporated_date" date,
	"new_owner_date" date,
	"years_in_business" integer,
	"number_of_employees" integer,
	"entity_type" text,
	"hq_status" text,
	"source_retrieved_at" timestamp with time zone,
	"parser_source" text,
	"schema_version" text,
	"source_http_request" jsonb,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_rating_reasons" (
	"business_reputation_rating_reason_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"reason_ordinal" integer,
	"reason_code" text,
	"reason_text" text NOT NULL,
	"reason_impact" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_reviews" (
	"business_reputation_review_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"provider_review_id" text,
	"review_date" date,
	"review_rating" numeric(5, 2),
	"review_title" text,
	"review_text" text,
	"reviewer_display_name" text,
	"review_status" text,
	"business_response_date" date,
	"business_response_text" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_reputation_service_areas" (
	"business_reputation_service_area_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reputation_profile_id" uuid NOT NULL,
	"address_id" uuid,
	"area_name" text NOT NULL,
	"area_type" text,
	"city_name" text,
	"county_name" text,
	"state_code" text,
	"postal_code" text,
	"country_code" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contractor_quality_scores" (
	"contractor_quality_score_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"business_reputation_profile_id" uuid,
	"request_identifier" text,
	"scoring_model" text NOT NULL,
	"score" numeric(6, 2),
	"score_band" text,
	"match_confidence" text,
	"match_method" text,
	"factor_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_reputation_alternate_names" ADD CONSTRAINT "business_reputation_alternate_names_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_categories" ADD CONSTRAINT "business_reputation_categories_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_complaint_events" ADD CONSTRAINT "business_reputation_complaint_events_business_reputation_complaint_id_business_reputation_complaints_business_reputation_complaint_id_fk" FOREIGN KEY ("business_reputation_complaint_id") REFERENCES "public"."business_reputation_complaints"("business_reputation_complaint_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_complaints" ADD CONSTRAINT "business_reputation_complaints_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_contacts" ADD CONSTRAINT "business_reputation_contacts_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_contacts" ADD CONSTRAINT "business_reputation_contacts_person_id_people_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("person_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_external_links" ADD CONSTRAINT "business_reputation_external_links_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_licenses" ADD CONSTRAINT "business_reputation_licenses_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_locations" ADD CONSTRAINT "business_reputation_locations_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_locations" ADD CONSTRAINT "business_reputation_locations_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_media" ADD CONSTRAINT "business_reputation_media_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_profiles" ADD CONSTRAINT "business_reputation_profiles_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_profiles" ADD CONSTRAINT "business_reputation_profiles_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_rating_reasons" ADD CONSTRAINT "business_reputation_rating_reasons_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_reviews" ADD CONSTRAINT "business_reputation_reviews_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_service_areas" ADD CONSTRAINT "business_reputation_service_areas_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reputation_service_areas" ADD CONSTRAINT "business_reputation_service_areas_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_quality_scores" ADD CONSTRAINT "contractor_quality_scores_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_quality_scores" ADD CONSTRAINT "contractor_quality_scores_business_reputation_profile_id_business_reputation_profiles_business_reputation_profile_id_fk" FOREIGN KEY ("business_reputation_profile_id") REFERENCES "public"."business_reputation_profiles"("business_reputation_profile_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_alt_names_source_record_idx" ON "business_reputation_alternate_names" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_alt_names_profile_idx" ON "business_reputation_alternate_names" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "business_reputation_alt_names_normalized_idx" ON "business_reputation_alternate_names" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_categories_source_record_idx" ON "business_reputation_categories" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_categories_profile_idx" ON "business_reputation_categories" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "business_reputation_categories_name_idx" ON "business_reputation_categories" USING btree ("category_name");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_complaint_events_source_record_idx" ON "business_reputation_complaint_events" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_complaint_events_complaint_date_idx" ON "business_reputation_complaint_events" USING btree ("business_reputation_complaint_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_complaints_source_record_idx" ON "business_reputation_complaints" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_complaints_profile_date_idx" ON "business_reputation_complaints" USING btree ("business_reputation_profile_id","complaint_date");--> statement-breakpoint
CREATE INDEX "business_reputation_complaints_provider_idx" ON "business_reputation_complaints" USING btree ("provider_complaint_id");--> statement-breakpoint
CREATE INDEX "business_reputation_complaints_status_idx" ON "business_reputation_complaints" USING btree ("complaint_status");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_contacts_source_record_idx" ON "business_reputation_contacts" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_contacts_profile_idx" ON "business_reputation_contacts" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "business_reputation_contacts_person_idx" ON "business_reputation_contacts" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "business_reputation_contacts_name_idx" ON "business_reputation_contacts" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_external_links_source_record_idx" ON "business_reputation_external_links" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_external_links_profile_idx" ON "business_reputation_external_links" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_licenses_source_record_idx" ON "business_reputation_licenses" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_licenses_profile_idx" ON "business_reputation_licenses" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "business_reputation_licenses_number_idx" ON "business_reputation_licenses" USING btree ("license_number");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_locations_source_record_idx" ON "business_reputation_locations" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_locations_profile_idx" ON "business_reputation_locations" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "business_reputation_locations_address_idx" ON "business_reputation_locations" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "business_reputation_locations_url_idx" ON "business_reputation_locations" USING btree ("profile_url");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_media_source_record_idx" ON "business_reputation_media" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_media_profile_idx" ON "business_reputation_media" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_profiles_source_record_idx" ON "business_reputation_profiles" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_profiles_provider_url_idx" ON "business_reputation_profiles" USING btree ("profile_url");--> statement-breakpoint
CREATE INDEX "business_reputation_profiles_company_idx" ON "business_reputation_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "business_reputation_profiles_address_idx" ON "business_reputation_profiles" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "business_reputation_profiles_provider_business_idx" ON "business_reputation_profiles" USING btree ("provider","provider_business_id");--> statement-breakpoint
CREATE INDEX "business_reputation_profiles_rating_idx" ON "business_reputation_profiles" USING btree ("bbb_rating");--> statement-breakpoint
CREATE INDEX "business_reputation_profiles_normalized_name_idx" ON "business_reputation_profiles" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_rating_reasons_source_record_idx" ON "business_reputation_rating_reasons" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_rating_reasons_profile_idx" ON "business_reputation_rating_reasons" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_reviews_source_record_idx" ON "business_reputation_reviews" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_reviews_profile_date_idx" ON "business_reputation_reviews" USING btree ("business_reputation_profile_id","review_date");--> statement-breakpoint
CREATE INDEX "business_reputation_reviews_provider_idx" ON "business_reputation_reviews" USING btree ("provider_review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_reputation_service_areas_source_record_idx" ON "business_reputation_service_areas" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "business_reputation_service_areas_profile_idx" ON "business_reputation_service_areas" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "business_reputation_service_areas_address_idx" ON "business_reputation_service_areas" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "business_reputation_service_areas_state_zip_idx" ON "business_reputation_service_areas" USING btree ("state_code","postal_code");--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_quality_scores_source_record_idx" ON "contractor_quality_scores" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "contractor_quality_scores_company_idx" ON "contractor_quality_scores" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contractor_quality_scores_profile_idx" ON "contractor_quality_scores" USING btree ("business_reputation_profile_id");--> statement-breakpoint
CREATE INDEX "contractor_quality_scores_score_idx" ON "contractor_quality_scores" USING btree ("score");