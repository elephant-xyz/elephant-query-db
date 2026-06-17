CREATE TABLE "deeds" (
	"deed_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"deed_type" text,
	"book" text,
	"page" text,
	"instrument_number" text,
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
CREATE TABLE "fact_sheets" (
	"fact_sheet_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"ipfs_url" text,
	"full_generation_command" text,
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
CREATE TABLE "files" (
	"file_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"deed_id" uuid,
	"request_identifier" text,
	"document_type" text,
	"file_format" text,
	"ipfs_url" text,
	"name" text,
	"original_url" text,
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
CREATE TABLE "geometries" (
	"geometry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
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
ALTER TABLE "addresses" ADD COLUMN "normalized_address_hash" text;--> statement-breakpoint
ALTER TABLE "ownerships" ADD COLUMN "mailing_address_id" uuid;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "address_id" uuid;--> statement-breakpoint
ALTER TABLE "property_improvements" ADD COLUMN "property_match_method" text;--> statement-breakpoint
ALTER TABLE "property_improvements" ADD COLUMN "property_match_confidence" text;--> statement-breakpoint
ALTER TABLE "business_registration_addresses" ADD COLUMN "address_match_method" text;--> statement-breakpoint
ALTER TABLE "business_registration_addresses" ADD COLUMN "address_match_confidence" text;--> statement-breakpoint
ALTER TABLE "business_registration_parties" ADD COLUMN "address_match_method" text;--> statement-breakpoint
ALTER TABLE "business_registration_parties" ADD COLUMN "address_match_confidence" text;--> statement-breakpoint
ALTER TABLE "deeds" ADD CONSTRAINT "deeds_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_sheets" ADD CONSTRAINT "fact_sheets_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_deed_id_deeds_deed_id_fk" FOREIGN KEY ("deed_id") REFERENCES "public"."deeds"("deed_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geometries" ADD CONSTRAINT "geometries_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deeds_source_record_idx" ON "deeds" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "deeds_property_idx" ON "deeds" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "deeds_book_page_idx" ON "deeds" USING btree ("book","page");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_sheets_source_record_idx" ON "fact_sheets" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "fact_sheets_property_idx" ON "fact_sheets" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_source_record_idx" ON "files" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "files_property_idx" ON "files" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "files_deed_idx" ON "files" USING btree ("deed_id");--> statement-breakpoint
CREATE INDEX "files_original_url_idx" ON "files" USING btree ("original_url");--> statement-breakpoint
CREATE UNIQUE INDEX "geometries_source_record_idx" ON "geometries" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "geometries_property_idx" ON "geometries" USING btree ("property_id");--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_mailing_address_id_addresses_address_id_fk" FOREIGN KEY ("mailing_address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_normalized_hash_idx" ON "addresses" USING btree ("normalized_address_hash");--> statement-breakpoint
CREATE INDEX "addresses_state_zip_hash_idx" ON "addresses" USING btree ("state_code","postal_code","normalized_address_hash");--> statement-breakpoint
CREATE INDEX "ownerships_mailing_address_idx" ON "ownerships" USING btree ("mailing_address_id");--> statement-breakpoint
CREATE INDEX "properties_address_idx" ON "properties" USING btree ("address_id");