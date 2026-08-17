CREATE TABLE "geometry_rings" (
	"geometry_ring_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"geometry_id" uuid NOT NULL,
	"request_identifier" text NOT NULL,
	"source_geometry_type" text NOT NULL,
	"polygon_index" integer NOT NULL,
	"ring_index" integer NOT NULL,
	"ring_role" text NOT NULL,
	"coordinates" jsonb NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geometry_rings_geometry_polygon_ring_unique" UNIQUE("geometry_id","polygon_index","ring_index"),
	CONSTRAINT "geometry_rings_source_type_check" CHECK ("geometry_rings"."source_geometry_type" IN ('Polygon', 'MultiPolygon')),
	CONSTRAINT "geometry_rings_role_check" CHECK ("geometry_rings"."ring_role" IN ('exterior', 'interior')),
	CONSTRAINT "geometry_rings_indexes_check" CHECK ("geometry_rings"."polygon_index" >= 0 AND "geometry_rings"."ring_index" >= 0),
	CONSTRAINT "geometry_rings_role_index_check" CHECK (("geometry_rings"."ring_index" = 0 AND "geometry_rings"."ring_role" = 'exterior') OR ("geometry_rings"."ring_index" > 0 AND "geometry_rings"."ring_role" = 'interior'))
);
--> statement-breakpoint
CREATE TABLE "illinois_sos_component_records" (
	"illinois_sos_component_record_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_kind" text NOT NULL,
	"component" text NOT NULL,
	"file_number" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"source_file_name" text NOT NULL,
	"source_line_number" integer NOT NULL,
	"record_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"privacy_classification" text DEFAULT 'private_non_publishable' NOT NULL,
	"publication_approved" boolean DEFAULT false NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "illinois_sos_component_records_source_record_unique" UNIQUE("source_system","source_record_key"),
	CONSTRAINT "illinois_sos_component_records_entity_kind_check" CHECK ("illinois_sos_component_records"."entity_kind" in ('corporation', 'llc')),
	CONSTRAINT "illinois_sos_component_records_privacy_check" CHECK ("illinois_sos_component_records"."privacy_classification" = 'private_non_publishable'),
	CONSTRAINT "illinois_sos_component_records_publication_check" CHECK ("illinois_sos_component_records"."publication_approved" = false)
);
--> statement-breakpoint
ALTER TABLE "geometry_rings" ADD CONSTRAINT "geometry_rings_geometry_id_geometries_geometry_id_fk" FOREIGN KEY ("geometry_id") REFERENCES "public"."geometries"("geometry_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "geometry_rings_source_record_idx" ON "geometry_rings" USING btree ("source_system","source_record_key");
--> statement-breakpoint
CREATE INDEX "geometry_rings_geometry_idx" ON "geometry_rings" USING btree ("geometry_id");
--> statement-breakpoint
CREATE INDEX "geometry_rings_request_idx" ON "geometry_rings" USING btree ("source_system","request_identifier");
--> statement-breakpoint
CREATE INDEX "illinois_sos_component_records_entity_file_idx" ON "illinois_sos_component_records" USING btree ("entity_kind","file_number");
--> statement-breakpoint
CREATE INDEX "illinois_sos_component_records_snapshot_idx" ON "illinois_sos_component_records" USING btree ("component","snapshot_date");
