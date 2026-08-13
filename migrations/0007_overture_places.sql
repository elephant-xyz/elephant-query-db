CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "business_locations" (
	"business_location_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"county_key" text NOT NULL,
	"county_fips" text NOT NULL,
	"gers_id" text NOT NULL,
	"overture_version" integer,
	"name_primary" text,
	"normalized_name" text,
	"taxonomy_primary" text,
	"taxonomy_hierarchy" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"basic_category" text,
	"legacy_category_primary" text,
	"operating_status" text,
	"confidence" numeric(8, 6),
	"websites" text[],
	"socials" text[],
	"emails" text[],
	"phones" text[],
	"brand_name" text,
	"brand_wikidata" text,
	"address_freeform" text,
	"address_locality" text,
	"address_postcode" text,
	"address_region" text,
	"address_country" text,
	"longitude" numeric(12, 8),
	"latitude" numeric(12, 8),
	"geometry" geometry(Point,4326),
	"is_hosted_service" boolean,
	"hosted_service_rule" text,
	"first_seen_release" text NOT NULL,
	"last_seen_release" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"company_id" uuid,
	"address_id" uuid,
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
CREATE TABLE "business_location_categories" (
	"business_location_category_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_location_id" uuid NOT NULL,
	"category_label" text NOT NULL,
	"taxonomy_path" text,
	"is_primary" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "business_location_sources" (
	"business_location_source_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_location_id" uuid NOT NULL,
	"dataset" text NOT NULL,
	"record_id" text,
	"update_time" text,
	"confidence" numeric(8, 6),
	"license" text,
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
CREATE TABLE "overture_place_extractions" (
	"overture_place_extraction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"county_key" text NOT NULL,
	"county_fips" text NOT NULL,
	"overture_release" text NOT NULL,
	"tiger_boundary_source" text NOT NULL,
	"tiger_vintage" text NOT NULL,
	"bbox_count" integer NOT NULL,
	"clip_count" integer NOT NULL,
	"distinct_taxonomy_primary" integer,
	"distinct_source_datasets" text[],
	"operating_status_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_distribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer,
	"licence_gate_passed" boolean NOT NULL,
	"extraction_location" text,
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
CREATE TABLE "business_location_parcel_links" (
	"business_location_parcel_link_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_location_id" uuid NOT NULL,
	"parcel_id" uuid,
	"folio_id" text,
	"match_confidence" text,
	"match_method" text,
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
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_location_categories" ADD CONSTRAINT "business_location_categories_business_location_id_fk" FOREIGN KEY ("business_location_id") REFERENCES "public"."business_locations"("business_location_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_location_sources" ADD CONSTRAINT "business_location_sources_business_location_id_fk" FOREIGN KEY ("business_location_id") REFERENCES "public"."business_locations"("business_location_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_location_parcel_links" ADD CONSTRAINT "business_location_parcel_links_business_location_id_fk" FOREIGN KEY ("business_location_id") REFERENCES "public"."business_locations"("business_location_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_location_parcel_links" ADD CONSTRAINT "business_location_parcel_links_parcel_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("parcel_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "business_locations_source_record_idx" ON "business_locations" USING btree ("source_system","source_record_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_locations_county_gers_idx" ON "business_locations" USING btree ("county_key","gers_id");
--> statement-breakpoint
CREATE INDEX "business_locations_geometry_gix" ON "business_locations" USING gist ("geometry");
--> statement-breakpoint
CREATE INDEX "business_locations_taxonomy_hierarchy_gin" ON "business_locations" USING gin ("taxonomy_hierarchy");
--> statement-breakpoint
CREATE INDEX "business_locations_county_taxonomy_idx" ON "business_locations" USING btree ("county_key","taxonomy_primary");
--> statement-breakpoint
CREATE INDEX "business_locations_basic_category_idx" ON "business_locations" USING btree ("basic_category");
--> statement-breakpoint
CREATE INDEX "business_locations_normalized_name_idx" ON "business_locations" USING btree ("normalized_name");
--> statement-breakpoint
CREATE INDEX "business_locations_address_idx" ON "business_locations" USING btree ("address_id");
--> statement-breakpoint
CREATE INDEX "business_locations_county_current_idx" ON "business_locations" USING btree ("county_key","is_current");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_location_categories_source_record_idx" ON "business_location_categories" USING btree ("source_system","source_record_key");
--> statement-breakpoint
CREATE INDEX "business_location_categories_location_idx" ON "business_location_categories" USING btree ("business_location_id");
--> statement-breakpoint
CREATE INDEX "business_location_categories_label_idx" ON "business_location_categories" USING btree ("category_label");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_location_sources_source_record_idx" ON "business_location_sources" USING btree ("source_system","source_record_key");
--> statement-breakpoint
CREATE INDEX "business_location_sources_location_idx" ON "business_location_sources" USING btree ("business_location_id");
--> statement-breakpoint
CREATE INDEX "business_location_sources_dataset_idx" ON "business_location_sources" USING btree ("dataset");
--> statement-breakpoint
CREATE UNIQUE INDEX "overture_place_extractions_source_record_idx" ON "overture_place_extractions" USING btree ("source_system","source_record_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "overture_place_extractions_county_release_idx" ON "overture_place_extractions" USING btree ("county_key","overture_release");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_location_parcel_links_source_record_idx" ON "business_location_parcel_links" USING btree ("source_system","source_record_key");
--> statement-breakpoint
CREATE INDEX "business_location_parcel_links_location_idx" ON "business_location_parcel_links" USING btree ("business_location_id");
--> statement-breakpoint
CREATE INDEX "business_location_parcel_links_parcel_idx" ON "business_location_parcel_links" USING btree ("parcel_id");
