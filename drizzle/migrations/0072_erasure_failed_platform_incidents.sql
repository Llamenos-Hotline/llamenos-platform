ALTER TABLE "hub_incidents" ALTER COLUMN "hub_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "abandoned_by" text;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "abandon_justification" text;