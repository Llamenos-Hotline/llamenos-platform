ALTER TABLE "hub_incidents" ALTER COLUMN "hub_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "abandoned_by" text;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD COLUMN "abandon_justification" text;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_incidents_open_platform_unique" ON "hub_incidents" USING btree ("category") WHERE "hub_incidents"."closed_at" IS NULL AND "hub_incidents"."hub_id" IS NULL;