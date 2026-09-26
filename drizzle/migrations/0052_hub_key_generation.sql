ALTER TABLE "hubs" ADD COLUMN "hub_key_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hubs that already hold envelopes are on their first key generation.
UPDATE "hubs" SET "hub_key_generation" = 1
  WHERE "hub_key_generation" = 0
    AND EXISTS (SELECT 1 FROM "hub_keys" WHERE "hub_keys"."hub_id" = "hubs"."id");
