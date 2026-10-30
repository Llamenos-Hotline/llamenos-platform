CREATE TABLE "hub_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"hub_id" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_signal_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"peak_per_minute" integer DEFAULT 0 NOT NULL,
	"current_minute_start" timestamp with time zone NOT NULL,
	"current_minute_count" integer DEFAULT 0 NOT NULL,
	"oldest_age_seconds" integer,
	"last_notified_at" timestamp with time zone,
	"last_relayed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_incidents" ADD CONSTRAINT "hub_incidents_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_incidents_open_unique" ON "hub_incidents" USING btree ("hub_id","category") WHERE "hub_incidents"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "hub_incidents_hub_opened_idx" ON "hub_incidents" USING btree ("hub_id","opened_at");