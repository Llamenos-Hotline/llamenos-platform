ALTER TABLE "active_calls" ADD COLUMN "ring_leg_sids" text[];--> statement-breakpoint
ALTER TABLE "active_calls" ADD COLUMN "ring_set" jsonb;