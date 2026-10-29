CREATE TABLE "provider_recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"hub_id" text DEFAULT '' NOT NULL,
	"call_id" text NOT NULL,
	"recording_sid" text NOT NULL,
	"provider_account" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_recordings_hub_recording_idx" ON "provider_recordings" USING btree ("hub_id","recording_sid");--> statement-breakpoint
CREATE INDEX "provider_recordings_call_idx" ON "provider_recordings" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "provider_recordings_kind_created_idx" ON "provider_recordings" USING btree ("kind","created_at");