CREATE TABLE "addresses" (
	"address_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_identifier" text,
	"street_number" text,
	"street_pre_directional_text" text,
	"street_name" text,
	"street_suffix_type" text,
	"street_post_directional_text" text,
	"unit_identifier" text,
	"city_name" text,
	"municipality_name" text,
	"county_name" text,
	"state_code" text,
	"postal_code" text,
	"plus_four_postal_code" text,
	"country_code" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"township" text,
	"range" text,
	"section" text,
	"block" text,
	"lot" text,
	"route_number" text,
	"unnormalized_address" text,
	"normalized_address_key" text,
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
CREATE TABLE "companies" (
	"company_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_identifier" text,
	"name" text,
	"normalized_name" text,
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
CREATE TABLE "people" (
	"person_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_identifier" text,
	"prefix_name" text,
	"first_name" text,
	"middle_name" text,
	"last_name" text,
	"suffix_name" text,
	"full_name" text,
	"normalized_name" text,
	"birth_date" date,
	"us_citizenship_status" text,
	"veteran_status" boolean,
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
CREATE TABLE "unnormalized_addresses" (
	"unnormalized_address_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_identifier" text,
	"full_address" text,
	"county_jurisdiction" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"source_http_request" jsonb,
	"entry_http_request" jsonb,
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
CREATE TABLE "flood_storm_information" (
	"flood_storm_information_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"community_id" text,
	"panel_number" text,
	"map_version" text,
	"effective_date" date,
	"evacuation_zone" text,
	"flood_zone" text,
	"flood_insurance_required" boolean,
	"fema_search_url" text,
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
CREATE TABLE "layouts" (
	"layout_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"parent_layout_id" uuid,
	"structure_id" uuid,
	"request_identifier" text,
	"space_type" text,
	"space_index" integer,
	"space_type_index" integer,
	"building_number" text,
	"story_type" text,
	"floor_level" text,
	"built_year" integer,
	"installation_date" date,
	"size_square_feet" numeric(18, 2),
	"livable_area_sq_ft" numeric(18, 2),
	"total_area_sq_ft" numeric(18, 2),
	"heated_area_sq_ft" numeric(18, 2),
	"area_under_air_sq_ft" numeric(18, 2),
	"adjustable_area_sq_ft" numeric(18, 2),
	"flooring_material_type" text,
	"flooring_installation_date" date,
	"has_windows" boolean,
	"window_design_type" text,
	"window_material_type" text,
	"window_treatment_type" text,
	"is_finished" boolean,
	"furnished" boolean,
	"paint_condition" text,
	"flooring_wear" text,
	"clutter_level" text,
	"visible_damage" text,
	"countertop_material" text,
	"cabinet_style" text,
	"fixture_finish_quality" text,
	"design_style" text,
	"natural_light_quality" text,
	"decor_elements" text,
	"kitchen_renovation_date" date,
	"bathroom_renovation_date" date,
	"pool_type" text,
	"pool_equipment" text,
	"pool_condition" text,
	"pool_surface_type" text,
	"pool_water_quality" text,
	"pool_installation_date" date,
	"spa_type" text,
	"spa_installation_date" date,
	"safety_features" text,
	"view_type" text,
	"lighting_features" text,
	"condition_issues" text,
	"is_exterior" boolean,
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
CREATE TABLE "lots" (
	"lot_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"lot_type" text,
	"lot_length_feet" numeric(18, 2),
	"lot_width_feet" numeric(18, 2),
	"lot_area_sqft" numeric(18, 2),
	"lot_size_acre" numeric(18, 6),
	"landscaping_features" text,
	"view" text,
	"fencing_type" text,
	"fence_height" numeric(18, 2),
	"fence_length" numeric(18, 2),
	"driveway_material" text,
	"driveway_condition" text,
	"lot_condition_issues" text,
	"paving_area_sqft" numeric(18, 2),
	"paving_installation_date" date,
	"paving_type" text,
	"site_lighting_fixture_count" integer,
	"site_lighting_installation_date" date,
	"site_lighting_type" text,
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
CREATE TABLE "ownerships" (
	"ownership_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"owner_person_id" uuid,
	"owner_company_id" uuid,
	"ownership_identifier" text,
	"owned_by" text,
	"property_ownership_structure" text,
	"property_ownership_structure_other_description" text,
	"trust_information" text,
	"ownership_percentage" numeric(7, 4),
	"owner_occupied_indicator" boolean,
	"date_acquired" date,
	"date_sold" date,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownerships_percentage_check" CHECK ("ownerships"."ownership_percentage" IS NULL OR ("ownerships"."ownership_percentage" >= 0 AND "ownerships"."ownership_percentage" <= 100))
);
--> statement-breakpoint
CREATE TABLE "parcels" (
	"parcel_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_identifier" text,
	"parcel_identifier" text NOT NULL,
	"county_name" text,
	"state_code" text,
	"jurisdiction_key" text,
	"source_http_request" jsonb,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parcels_jurisdiction_key_parcel_identifier_unique" UNIQUE("jurisdiction_key","parcel_identifier")
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"property_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcel_id" uuid,
	"request_identifier" text,
	"parcel_identifier" text NOT NULL,
	"property_type" text,
	"property_usage_type" text,
	"structure_form" text,
	"build_status" text,
	"ownership_estate_type" text,
	"property_legal_description_text" text,
	"property_structure_built_year" integer,
	"property_effective_built_year" integer,
	"historic_designation" boolean,
	"livable_floor_area" text,
	"area_under_air" text,
	"total_area" text,
	"number_of_units" integer,
	"number_of_units_type" text,
	"subdivision" text,
	"zoning" text,
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
CREATE TABLE "property_valuations" (
	"property_valuation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"valuation_date" date,
	"valuation_method_type" text,
	"confidence_score" integer,
	"current_avm_value" numeric(18, 2),
	"high_value" numeric(18, 2),
	"low_value" numeric(18, 2),
	"standard_deviation" numeric(18, 6),
	"area_min_property_price_psf" numeric(18, 6),
	"area_max_property_price_psf" numeric(18, 6),
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_valuations_confidence_score_check" CHECK ("property_valuations"."confidence_score" IS NULL OR ("property_valuations"."confidence_score" >= 0 AND "property_valuations"."confidence_score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "sales_histories" (
	"sales_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"ownership_transfer_date" date,
	"purchase_price_amount" numeric(18, 2),
	"sale_type" text,
	"deed_book" text,
	"deed_page" text,
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
CREATE TABLE "structures" (
	"structure_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"architectural_style_type" text,
	"attachment_type" text,
	"exterior_wall_material_primary" text,
	"exterior_wall_material_secondary" text,
	"exterior_wall_condition" text,
	"exterior_wall_condition_primary" text,
	"exterior_wall_condition_secondary" text,
	"exterior_wall_insulation_type" text,
	"exterior_wall_insulation_type_primary" text,
	"exterior_wall_insulation_type_secondary" text,
	"roof_covering_material" text,
	"roof_material_type" text,
	"roof_design_type" text,
	"roof_condition" text,
	"roof_age_years" integer,
	"roof_date" text,
	"roof_underlayment_type" text,
	"roof_structure_material" text,
	"foundation_type" text,
	"foundation_material" text,
	"foundation_condition" text,
	"foundation_waterproofing" text,
	"flooring_material_primary" text,
	"flooring_material_secondary" text,
	"flooring_condition" text,
	"subfloor_material" text,
	"interior_wall_structure_material" text,
	"interior_wall_structure_material_primary" text,
	"interior_wall_structure_material_secondary" text,
	"interior_wall_surface_material_primary" text,
	"interior_wall_surface_material_secondary" text,
	"interior_wall_finish_primary" text,
	"interior_wall_finish_secondary" text,
	"interior_wall_condition" text,
	"gutters_material" text,
	"gutters_condition" text,
	"ceiling_structure_material" text,
	"ceiling_surface_material" text,
	"ceiling_insulation_type" text,
	"ceiling_height_average" numeric(8, 2),
	"ceiling_condition" text,
	"exterior_door_material" text,
	"interior_door_material" text,
	"window_frame_material" text,
	"window_glazing_type" text,
	"window_operation_type" text,
	"window_screen_material" text,
	"primary_framing_material" text,
	"secondary_framing_material" text,
	"structural_damage_indicators" text,
	"number_of_stories" numeric(8, 2),
	"finished_base_area" integer,
	"unfinished_base_area" integer,
	"finished_basement_area" integer,
	"unfinished_basement_area" integer,
	"finished_upper_story_area" integer,
	"unfinished_upper_story_area" integer,
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
CREATE TABLE "taxes" (
	"tax_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"request_identifier" text,
	"tax_year" integer,
	"property_assessed_value_amount" numeric(18, 2),
	"property_market_value_amount" numeric(18, 2),
	"property_building_amount" numeric(18, 2),
	"property_land_amount" numeric(18, 2),
	"property_exemption_amount" numeric(18, 2),
	"property_taxable_value_amount" numeric(18, 2),
	"city_taxable_value_amount" numeric(18, 2),
	"county_taxable_value_amount" numeric(18, 2),
	"college_taxable_value_amount" numeric(18, 2),
	"hospital_taxable_value_amount" numeric(18, 2),
	"school_taxable_value_amount" numeric(18, 2),
	"special_district_taxable_value_amount" numeric(18, 2),
	"agricultural_valuation_amount" numeric(18, 2),
	"homestead_cap_loss_amount" numeric(18, 2),
	"building_replacement_cost_amount" numeric(18, 2),
	"building_depreciated_value_amount" numeric(18, 2),
	"millage_rate" numeric(12, 6),
	"monthly_tax_amount" numeric(18, 2),
	"yearly_tax_amount" numeric(18, 2),
	"period_start_date" date,
	"period_end_date" date,
	"first_year_on_tax_roll" integer,
	"first_year_building_on_tax_roll" integer,
	"source_http_request" jsonb,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "taxes_property_id_tax_year_unique" UNIQUE("property_id","tax_year")
);
--> statement-breakpoint
CREATE TABLE "utilities" (
	"utility_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"layout_id" uuid,
	"request_identifier" text,
	"cooling_system_type" text,
	"heating_system_type" text,
	"heating_fuel_type" text,
	"public_utility_type" text,
	"sewer_type" text,
	"water_source_type" text,
	"plumbing_system_type" text,
	"plumbing_system_type_other_description" text,
	"electrical_panel_capacity" text,
	"electrical_wiring_type" text,
	"electrical_wiring_type_other_description" text,
	"hvac_condensing_unit_present" boolean,
	"hvac_unit_condition" text,
	"hvac_unit_issues" text,
	"hvac_capacity_kw" numeric(12, 4),
	"hvac_capacity_tons" numeric(12, 4),
	"hvac_seer_rating" numeric(12, 4),
	"hvac_system_configuration" text,
	"hvac_equipment_component" text,
	"hvac_equipment_manufacturer" text,
	"hvac_equipment_model" text,
	"hvac_installation_date" date,
	"solar_panel_present" boolean,
	"solar_panel_type" text,
	"solar_panel_type_other_description" text,
	"solar_installation_date" date,
	"solar_inverter_visible" boolean,
	"solar_inverter_manufacturer" text,
	"solar_inverter_model" text,
	"solar_inverter_installation_date" date,
	"smart_home_features" text,
	"smart_home_features_other_description" text,
	"plumbing_fixture_count" integer,
	"plumbing_fixture_quality" text,
	"plumbing_fixture_type_primary" text,
	"plumbing_system_installation_date" date,
	"electrical_panel_installation_date" date,
	"electrical_rewire_date" date,
	"sewer_connection_date" date,
	"water_connection_date" date,
	"water_heater_manufacturer" text,
	"water_heater_model" text,
	"water_heater_installation_date" date,
	"well_installation_date" date,
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
CREATE TABLE "inspections" (
	"inspection_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_improvement_id" uuid,
	"inspection_number" text,
	"inspection_status" text,
	"permit_number" text,
	"requested_date" date,
	"scheduled_date" date,
	"completed_date" date,
	"completed_time" text,
	"result" text,
	"inspection_code" text,
	"inspection_type" text,
	"inspection_identifier" text,
	"inspector_name" text,
	"resulted_date" text,
	"result_comment" text,
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
CREATE TABLE "permit_contacts" (
	"permit_contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_improvement_id" uuid NOT NULL,
	"contact_role" text NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"address_id" uuid,
	"raw_name" text,
	"raw_block_text" text,
	"phone" text,
	"email" text,
	"license_number" text,
	"license_type" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_custom_fields" (
	"permit_custom_field_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_improvement_id" uuid NOT NULL,
	"field_group" text,
	"field_name" text NOT NULL,
	"field_value" text,
	"field_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_events" (
	"permit_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_improvement_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_status" text,
	"event_date" timestamp with time zone,
	"actor_name" text,
	"comment_text" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_fees" (
	"permit_fee_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_improvement_id" uuid NOT NULL,
	"fee_code" text,
	"fee_description" text,
	"fee_status" text,
	"assessed_amount" numeric(18, 2),
	"paid_amount" numeric(18, 2),
	"balance_amount" numeric(18, 2),
	"assessed_date" date,
	"paid_date" date,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_links" (
	"permit_link_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_improvement_id" uuid NOT NULL,
	"link_kind" text NOT NULL,
	"text" text,
	"url" text NOT NULL,
	"title" text,
	"storage_uri" text,
	"content_sha256" text,
	"uploaded_at" timestamp with time zone,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_list_windows" (
	"permit_list_window_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"window_key" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"portal_url" text,
	"reported_total" integer,
	"discovered_permit_count" integer,
	"no_results" boolean,
	"truncated_for_split" boolean,
	"page_count" integer,
	"summary_storage_uri" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_improvements" (
	"property_improvement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"parcel_id" uuid,
	"address_id" uuid,
	"contractor_company_id" uuid,
	"request_identifier" text,
	"permit_number" text,
	"improvement_type" text,
	"improvement_status" text,
	"improvement_action" text,
	"contractor_type" text,
	"permit_required" boolean,
	"application_received_date" date,
	"permit_issue_date" date,
	"final_inspection_date" date,
	"permit_close_date" date,
	"completion_date" date,
	"is_owner_builder" boolean,
	"is_disaster_recovery" boolean,
	"private_provider_plan_review" boolean,
	"private_provider_inspections" boolean,
	"fee" numeric(18, 2),
	"estimated_job_value" numeric(18, 2),
	"estimated_sq_ft" numeric(18, 2),
	"schema_version" text,
	"source" text,
	"source_url" text,
	"retrieved_at" timestamp with time zone,
	"accela_record_id" text,
	"accela_alt_id" text,
	"source_module" text,
	"source_record_type" text,
	"record_type" text,
	"source_status" text,
	"record_status" text,
	"opened_date" date,
	"expiration_date" date,
	"work_location" text,
	"parcel_identifier" text,
	"applicant" text,
	"licensed_professional" text,
	"project_description" text,
	"description" text,
	"comm_res" text,
	"volts" text,
	"block" text,
	"lot" text,
	"subdivision" text,
	"planning_community" text,
	"municipal_code" text,
	"historic" text,
	"fire_district" text,
	"more_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"more_details_raw_text" text,
	"inspections_raw_text" text,
	"processing_status_raw_text" text,
	"raw_text" text,
	"source_search_result" jsonb,
	"idempotency_key" text,
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
CREATE TABLE "business_registration_addresses" (
	"business_registration_address_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_registration_id" uuid NOT NULL,
	"address_id" uuid,
	"request_identifier" text NOT NULL,
	"document_number" text NOT NULL,
	"address_role" text NOT NULL,
	"line_1" text,
	"line_2" text,
	"city" text,
	"state" text,
	"zip" text,
	"country" text,
	"single_line" text,
	"normalized" text,
	"matched_zip_prefixes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_registration_addresses_source_record_unique" UNIQUE("source_system","source_record_key"),
	CONSTRAINT "business_registration_addresses_role_unique" UNIQUE("business_registration_id","address_role")
);
--> statement-breakpoint
CREATE TABLE "business_registration_annual_reports" (
	"business_registration_annual_report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_registration_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"report_ordinal" integer NOT NULL,
	"report_year" text,
	"report_date" date,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_registration_reports_source_record_unique" UNIQUE("source_system","source_record_key"),
	CONSTRAINT "business_registration_reports_unique" UNIQUE("business_registration_id","report_ordinal")
);
--> statement-breakpoint
CREATE TABLE "business_registration_events" (
	"business_registration_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_registration_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"event_code" text,
	"event_type" text,
	"event_date" date,
	"event_description" text,
	"source_file_name" text,
	"source_line_number" integer,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_registration_events_source_record_unique" UNIQUE("source_system","source_record_key")
);
--> statement-breakpoint
CREATE TABLE "business_registration_parties" (
	"business_registration_party_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_registration_id" uuid NOT NULL,
	"party_person_id" uuid,
	"party_company_id" uuid,
	"address_id" uuid,
	"request_identifier" text NOT NULL,
	"document_number" text NOT NULL,
	"party_role" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text,
	"party_type_code" text,
	"title" text,
	"officer_ordinal" integer,
	"address_line_1" text,
	"address_line_2" text,
	"address_city" text,
	"address_state" text,
	"address_zip" text,
	"address_country" text,
	"address_single_line" text,
	"address_normalized" text,
	"matched_zip_prefixes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_registration_parties_source_record_unique" UNIQUE("source_system","source_record_key")
);
--> statement-breakpoint
CREATE TABLE "business_registrations" (
	"business_registration_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"request_identifier" text NOT NULL,
	"source_data_uri" text,
	"source_file_name" text,
	"source_line_number" integer,
	"schema_version" text,
	"parser_source" text,
	"document_number" text NOT NULL,
	"entity_name" text,
	"status_code" text,
	"status" text,
	"filing_type_code" text,
	"filing_type" text,
	"filed_date" date,
	"fei_number" text,
	"last_transaction_date" date,
	"state_country" text,
	"annual_report_1_year" text,
	"annual_report_1_date" date,
	"annual_report_2_year" text,
	"annual_report_2_date" date,
	"annual_report_3_year" text,
	"annual_report_3_date" date,
	"more_than_six_officers" boolean,
	"raw_record_length" integer,
	"matched_address_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"matched_zip_prefixes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_registrations_source_record_unique" UNIQUE("source_system","source_record_key"),
	CONSTRAINT "business_registrations_source_system_document_number_unique" UNIQUE("source_system","document_number")
);
--> statement-breakpoint
CREATE TABLE "sunbiz_extraction_chunks" (
	"sunbiz_extraction_chunk_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extract_key" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"record_count" integer NOT NULL,
	"uri" text NOT NULL,
	"source_data_uri" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_record_key" text NOT NULL,
	"source_record_hash" text,
	"source_artifact_uri" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sunbiz_extraction_chunks_source_record_unique" UNIQUE("source_system","source_record_key"),
	CONSTRAINT "sunbiz_extraction_chunks_key_chunk_unique" UNIQUE("extract_key","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "flood_storm_information" ADD CONSTRAINT "flood_storm_information_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_structure_id_structures_structure_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."structures"("structure_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_parent_layout_fk" FOREIGN KEY ("parent_layout_id") REFERENCES "public"."layouts"("layout_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_owner_person_id_people_person_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("person_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_owner_company_id_companies_company_id_fk" FOREIGN KEY ("owner_company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_parcel_id_parcels_parcel_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("parcel_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_valuations" ADD CONSTRAINT "property_valuations_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_histories" ADD CONSTRAINT "sales_histories_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structures" ADD CONSTRAINT "structures_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxes" ADD CONSTRAINT "taxes_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utilities" ADD CONSTRAINT "utilities_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utilities" ADD CONSTRAINT "utilities_layout_id_layouts_layout_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."layouts"("layout_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_contacts" ADD CONSTRAINT "permit_contacts_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_contacts" ADD CONSTRAINT "permit_contacts_person_id_people_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("person_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_contacts" ADD CONSTRAINT "permit_contacts_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_contacts" ADD CONSTRAINT "permit_contacts_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_custom_fields" ADD CONSTRAINT "permit_custom_fields_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_events" ADD CONSTRAINT "permit_events_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_fees" ADD CONSTRAINT "permit_fees_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_links" ADD CONSTRAINT "permit_links_property_improvement_id_property_improvements_property_improvement_id_fk" FOREIGN KEY ("property_improvement_id") REFERENCES "public"."property_improvements"("property_improvement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_improvements" ADD CONSTRAINT "property_improvements_property_id_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("property_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_improvements" ADD CONSTRAINT "property_improvements_parcel_id_parcels_parcel_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("parcel_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_improvements" ADD CONSTRAINT "property_improvements_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_improvements" ADD CONSTRAINT "property_improvements_contractor_company_id_companies_company_id_fk" FOREIGN KEY ("contractor_company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_addresses" ADD CONSTRAINT "business_registration_addresses_business_registration_id_business_registrations_business_registration_id_fk" FOREIGN KEY ("business_registration_id") REFERENCES "public"."business_registrations"("business_registration_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_addresses" ADD CONSTRAINT "business_registration_addresses_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_annual_reports" ADD CONSTRAINT "business_registration_annual_reports_business_registration_id_business_registrations_business_registration_id_fk" FOREIGN KEY ("business_registration_id") REFERENCES "public"."business_registrations"("business_registration_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_events" ADD CONSTRAINT "business_registration_events_business_registration_id_business_registrations_business_registration_id_fk" FOREIGN KEY ("business_registration_id") REFERENCES "public"."business_registrations"("business_registration_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_parties" ADD CONSTRAINT "business_registration_parties_business_registration_id_business_registrations_business_registration_id_fk" FOREIGN KEY ("business_registration_id") REFERENCES "public"."business_registrations"("business_registration_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_parties" ADD CONSTRAINT "business_registration_parties_party_person_id_people_person_id_fk" FOREIGN KEY ("party_person_id") REFERENCES "public"."people"("person_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_parties" ADD CONSTRAINT "business_registration_parties_party_company_id_companies_company_id_fk" FOREIGN KEY ("party_company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registration_parties" ADD CONSTRAINT "business_registration_parties_address_id_addresses_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("address_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_registrations" ADD CONSTRAINT "business_registrations_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_source_record_idx" ON "addresses" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "addresses_postal_code_idx" ON "addresses" USING btree ("postal_code");--> statement-breakpoint
CREATE INDEX "addresses_city_street_idx" ON "addresses" USING btree ("city_name","street_name","street_number");--> statement-breakpoint
CREATE INDEX "addresses_normalized_key_idx" ON "addresses" USING btree ("normalized_address_key");--> statement-breakpoint
CREATE INDEX "addresses_unnormalized_idx" ON "addresses" USING btree ("unnormalized_address");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_source_record_idx" ON "companies" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "companies_normalized_name_idx" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "companies_name_idx" ON "companies" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "people_source_record_idx" ON "people" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "people_normalized_name_idx" ON "people" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "people_full_name_idx" ON "people" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "unnormalized_addresses_source_record_idx" ON "unnormalized_addresses" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "unnormalized_addresses_full_address_idx" ON "unnormalized_addresses" USING btree ("full_address");--> statement-breakpoint
CREATE UNIQUE INDEX "flood_storm_information_source_record_idx" ON "flood_storm_information" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "flood_storm_information_property_idx" ON "flood_storm_information" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "layouts_source_record_idx" ON "layouts" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "layouts_property_idx" ON "layouts" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "layouts_parent_idx" ON "layouts" USING btree ("parent_layout_id");--> statement-breakpoint
CREATE INDEX "layouts_structure_idx" ON "layouts" USING btree ("structure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_source_record_idx" ON "lots" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "lots_property_idx" ON "lots" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownerships_source_record_idx" ON "ownerships" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "ownerships_property_idx" ON "ownerships" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "ownerships_owner_person_idx" ON "ownerships" USING btree ("owner_person_id");--> statement-breakpoint
CREATE INDEX "ownerships_owner_company_idx" ON "ownerships" USING btree ("owner_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parcels_source_record_idx" ON "parcels" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "parcels_identifier_idx" ON "parcels" USING btree ("parcel_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_source_record_idx" ON "properties" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "properties_parcel_identifier_idx" ON "properties" USING btree ("parcel_identifier");--> statement-breakpoint
CREATE INDEX "properties_parcel_idx" ON "properties" USING btree ("parcel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_valuations_source_record_idx" ON "property_valuations" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "property_valuations_property_date_idx" ON "property_valuations" USING btree ("property_id","valuation_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_histories_source_record_idx" ON "sales_histories" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "sales_histories_property_date_idx" ON "sales_histories" USING btree ("property_id","ownership_transfer_date");--> statement-breakpoint
CREATE UNIQUE INDEX "structures_source_record_idx" ON "structures" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "structures_property_idx" ON "structures" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "taxes_source_record_idx" ON "taxes" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "taxes_tax_year_idx" ON "taxes" USING btree ("tax_year");--> statement-breakpoint
CREATE UNIQUE INDEX "utilities_source_record_idx" ON "utilities" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "utilities_property_idx" ON "utilities" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "utilities_layout_idx" ON "utilities" USING btree ("layout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_source_record_idx" ON "inspections" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "inspections_permit_date_idx" ON "inspections" USING btree ("permit_number","completed_date");--> statement-breakpoint
CREATE INDEX "inspections_identifier_idx" ON "inspections" USING btree ("inspection_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_contacts_source_record_idx" ON "permit_contacts" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "permit_contacts_permit_role_idx" ON "permit_contacts" USING btree ("property_improvement_id","contact_role");--> statement-breakpoint
CREATE INDEX "permit_contacts_raw_name_idx" ON "permit_contacts" USING btree ("raw_name");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_custom_fields_source_record_idx" ON "permit_custom_fields" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_custom_fields_unique_idx" ON "permit_custom_fields" USING btree ("property_improvement_id","field_group","field_name");--> statement-breakpoint
CREATE INDEX "permit_custom_fields_name_value_idx" ON "permit_custom_fields" USING btree ("field_name","field_value");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_events_source_record_idx" ON "permit_events" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "permit_events_permit_date_idx" ON "permit_events" USING btree ("property_improvement_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_fees_source_record_idx" ON "permit_fees" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "permit_fees_permit_idx" ON "permit_fees" USING btree ("property_improvement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_links_source_record_idx" ON "permit_links" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "permit_links_permit_idx" ON "permit_links" USING btree ("property_improvement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_links_permit_url_idx" ON "permit_links" USING btree ("property_improvement_id","link_kind","url");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_list_windows_source_record_idx" ON "permit_list_windows" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_list_windows_job_window_idx" ON "permit_list_windows" USING btree ("job_id","window_key");--> statement-breakpoint
CREATE UNIQUE INDEX "property_improvements_source_record_idx" ON "property_improvements" USING btree ("source_system","source_record_key");--> statement-breakpoint
CREATE INDEX "property_improvements_permit_number_idx" ON "property_improvements" USING btree ("source_system","permit_number") WHERE "property_improvements"."permit_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "property_improvements_dates_idx" ON "property_improvements" USING btree ("application_received_date","permit_issue_date","permit_close_date");--> statement-breakpoint
CREATE INDEX "property_improvements_status_idx" ON "property_improvements" USING btree ("improvement_status","source_status","record_status");--> statement-breakpoint
CREATE INDEX "property_improvements_parcel_idx" ON "property_improvements" USING btree ("parcel_id");--> statement-breakpoint
CREATE INDEX "property_improvements_parcel_identifier_idx" ON "property_improvements" USING btree ("parcel_identifier");--> statement-breakpoint
CREATE INDEX "property_improvements_project_description_idx" ON "property_improvements" USING btree ("project_description");--> statement-breakpoint
CREATE INDEX "business_registration_addresses_address_idx" ON "business_registration_addresses" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "business_registration_addresses_zip_idx" ON "business_registration_addresses" USING btree ("zip");--> statement-breakpoint
CREATE INDEX "business_registration_events_registration_date_idx" ON "business_registration_events" USING btree ("business_registration_id","event_date");--> statement-breakpoint
CREATE INDEX "business_registration_parties_registration_idx" ON "business_registration_parties" USING btree ("business_registration_id");--> statement-breakpoint
CREATE INDEX "business_registration_parties_name_idx" ON "business_registration_parties" USING btree ("name");--> statement-breakpoint
CREATE INDEX "business_registration_parties_address_zip_idx" ON "business_registration_parties" USING btree ("address_zip");--> statement-breakpoint
CREATE INDEX "business_registrations_company_idx" ON "business_registrations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "business_registrations_entity_name_idx" ON "business_registrations" USING btree ("entity_name");--> statement-breakpoint
CREATE INDEX "business_registrations_fei_idx" ON "business_registrations" USING btree ("fei_number");--> statement-breakpoint
CREATE INDEX "business_registrations_zip_prefixes_idx" ON "business_registrations" USING gin ("matched_zip_prefixes");--> statement-breakpoint
CREATE VIEW "public"."address_profile_view" AS (
  select
    "addresses"."address_id" as address_id,
    "addresses"."normalized_address_key" as normalized_address_key,
    "addresses"."unnormalized_address" as unnormalized_address,
    "addresses"."street_number" as street_number,
    "addresses"."street_name" as street_name,
    "addresses"."street_suffix_type" as street_suffix_type,
    "addresses"."unit_identifier" as unit_identifier,
    "addresses"."city_name" as city_name,
    "addresses"."state_code" as state_code,
    "addresses"."postal_code" as postal_code,
    "addresses"."latitude" as latitude,
    "addresses"."longitude" as longitude
  from "addresses"
);--> statement-breakpoint
CREATE VIEW "public"."company_profile_view" AS (
  select
    "companies"."company_id" as company_id,
    "companies"."name" as name,
    "companies"."normalized_name" as normalized_name,
    "business_registrations"."business_registration_id" as business_registration_id,
    "business_registrations"."document_number" as document_number,
    "business_registrations"."status" as status,
    "business_registrations"."filing_type" as filing_type,
    "business_registrations"."filed_date" as filed_date,
    "business_registrations"."fei_number" as fei_number
  from "companies"
  left join "business_registrations" on "business_registrations"."company_id" = "companies"."company_id"
);--> statement-breakpoint
CREATE VIEW "public"."permit_search_view" AS (
  select
    "property_improvements"."property_improvement_id" as property_improvement_id,
    "property_improvements"."permit_number" as permit_number,
    "property_improvements"."improvement_type" as improvement_type,
    "property_improvements"."improvement_status" as improvement_status,
    "property_improvements"."source_status" as source_status,
    "property_improvements"."record_status" as record_status,
    "property_improvements"."application_received_date" as application_received_date,
    "property_improvements"."permit_issue_date" as permit_issue_date,
    "property_improvements"."permit_close_date" as permit_close_date,
    "property_improvements"."parcel_id" as parcel_id,
    coalesce("parcels"."parcel_identifier", "property_improvements"."parcel_identifier") as parcel_identifier,
    "property_improvements"."address_id" as address_id,
    coalesce("addresses"."unnormalized_address", "property_improvements"."work_location") as unnormalized_address,
    "addresses"."city_name" as city_name,
    "addresses"."postal_code" as postal_code,
    "property_improvements"."contractor_company_id" as contractor_company_id,
    "companies"."name" as contractor_name
  from "property_improvements"
  left join "parcels" on "parcels"."parcel_id" = "property_improvements"."parcel_id"
  left join "addresses" on "addresses"."address_id" = "property_improvements"."address_id"
  left join "companies" on "companies"."company_id" = "property_improvements"."contractor_company_id"
);--> statement-breakpoint
CREATE VIEW "public"."property_profile_view" AS (
  select
    "properties"."property_id" as property_id,
    "properties"."parcel_identifier" as parcel_identifier,
    "properties"."property_type" as property_type,
    "properties"."property_usage_type" as property_usage_type,
    "properties"."property_legal_description_text" as property_legal_description_text,
    "properties"."property_structure_built_year" as property_structure_built_year,
    "properties"."subdivision" as subdivision,
    "properties"."zoning" as zoning,
    "parcels"."parcel_id" as parcel_id,
    "parcels"."jurisdiction_key" as jurisdiction_key
  from "properties"
  left join "parcels" on "parcels"."parcel_id" = "properties"."parcel_id"
);
