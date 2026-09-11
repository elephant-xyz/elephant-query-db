ALTER TABLE "addresses" ADD COLUMN "elephant_uuid" uuid;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "elephant_token" text;--> statement-breakpoint
CREATE INDEX "addresses_elephant_uuid_idx" ON "addresses" USING btree ("elephant_uuid");--> statement-breakpoint
CREATE INDEX "addresses_elephant_token_idx" ON "addresses" USING btree ("elephant_token");