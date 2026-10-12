ALTER TABLE "erasure_requests" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "re_encryption_jobs" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "erasure_config" ADD COLUMN "hub_shred_delay_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "scope" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "hub_id" text;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "previous_status" text;--> statement-breakpoint
ALTER TABLE "re_encryption_jobs" ADD COLUMN "scope" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN "hub_key_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "erasure_requests_hub_id_idx" ON "erasure_requests" USING btree ("hub_id");--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_scope_subject" CHECK ((scope = 'user' AND user_id IS NOT NULL AND hub_id IS NULL)
       OR (scope = 'hub'  AND hub_id  IS NOT NULL AND user_id IS NULL));