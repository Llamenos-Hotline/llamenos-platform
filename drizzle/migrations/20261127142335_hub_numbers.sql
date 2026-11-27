CREATE TABLE "hub_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"hub_id" text NOT NULL,
	"number" text NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"provider_config_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_numbers_scope_check" CHECK ("hub_numbers"."scope" IN ('platform', 'hub')),
	CONSTRAINT "hub_numbers_source_check" CHECK ("hub_numbers"."source" IN ('declared', 'provisioned')),
	CONSTRAINT "hub_numbers_e164_check" CHECK ("hub_numbers"."number" ~ '^\+[0-9]{7,15}$')
);
--> statement-breakpoint
ALTER TABLE "hub_numbers" ADD CONSTRAINT "hub_numbers_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_numbers" ADD CONSTRAINT "hub_numbers_provider_config_id_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_numbers_number_unique" ON "hub_numbers" USING btree ("number");--> statement-breakpoint
CREATE INDEX "hub_numbers_hub_idx" ON "hub_numbers" USING btree ("hub_id");--> statement-breakpoint
-- Forget phase (docs/runbooks/migrations.md): hubs.phone_number, hub_settings.phone_number
-- and provider_configs.phone_numbers are no longer declared by the schema. The release being
-- replaced still reads and writes them while it drains, so the DROP COLUMNs generated for them
-- are deliberately absent here; the contract migration drops them one release later.
--
-- Backfill: the numbers inbound routing resolved a hub from until now. Only
-- hubs.phone_number was ever read by routing, so only it is carried over —
-- provider_configs.phone_numbers also held a mirror of every number on a hosted
-- account, and copying that would start routing calls for numbers that never were.
-- Only instance authority could set hubs.phone_number, hence scope 'platform'.
-- A value that does not read as E.164 once separators are stripped never matched
-- an inbound call either, so it is left behind rather than guessed at.
INSERT INTO "hub_numbers" ("id", "hub_id", "number", "source", "scope")
SELECT gen_random_uuid()::text, "id", "normalized", 'declared', 'platform'
FROM (
	SELECT "id", regexp_replace("phone_number", '[^0-9+]', '', 'g') AS "normalized", "created_at"
	FROM "hubs"
	WHERE "phone_number" IS NOT NULL
) AS "h"
WHERE "normalized" ~ '^\+[0-9]{7,15}$'
ORDER BY "created_at"
ON CONFLICT ("number") DO NOTHING;
