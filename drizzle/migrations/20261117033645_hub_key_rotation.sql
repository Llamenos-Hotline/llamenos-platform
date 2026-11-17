ALTER TABLE "hubs" ADD COLUMN "hub_key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN "hub_key_rotation" text;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN "hub_key_rotation_due" boolean DEFAULT false NOT NULL;