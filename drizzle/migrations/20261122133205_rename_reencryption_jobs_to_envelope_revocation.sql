-- #1527: re_encryption_jobs re-encrypted nothing. Each job strips a departed
-- member's entry from the jsonb envelope arrays (revocation) and never re-seals a
-- ciphertext or rewraps a key, so the table is renamed to say what it does:
-- envelope_revocation_jobs.
--
-- Expand/contract (docs/runbooks/migrations.md): a table is never RENAMEd, because
-- the previous release still names it. This is the EXPAND + FORGET release. The new
-- table is created, every existing job is copied into it, and the code and the
-- drizzle schema stop declaring `re_encryption_jobs` (the regenerated snapshot says
-- so). The old table stays in the database for the previous release's pods; the
-- contract migration one release later drops it, its trigger and its function.
--
-- A previous-release pod still enqueues into the old table during the rollout. The
-- AFTER INSERT trigger forwards each such row to the new table, so the new release's
-- worker sees it. The previous pod's own worker may also process the old-table row;
-- revocation only removes an envelope entry and is idempotent, so doing it twice is
-- harmless.
--
-- Every statement is re-runnable: the runner applies a file statement by statement
-- and runs the whole file again if a boot dies partway through.
CREATE TABLE IF NOT EXISTS "envelope_revocation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'user' NOT NULL,
	"user_id" text,
	"hub_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_envelopes" integer DEFAULT 0 NOT NULL,
	"processed_envelopes" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "envelope_revocation_jobs_user_id_idx" ON "envelope_revocation_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "envelope_revocation_jobs_status_idx" ON "envelope_revocation_jobs" USING btree ("status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "forward_re_encryption_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "envelope_revocation_jobs"
    ("id", "scope", "user_id", "hub_id", "status", "total_envelopes", "processed_envelopes", "started_at", "completed_at", "created_at")
  VALUES
    (NEW."id", NEW."scope", NEW."user_id", NEW."hub_id", NEW."status", NEW."total_envelopes", NEW."processed_envelopes", NEW."started_at", NEW."completed_at", NEW."created_at")
  ON CONFLICT ("id") DO NOTHING;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "re_encryption_jobs_forward" AFTER INSERT ON "re_encryption_jobs"
  FOR EACH ROW EXECUTE FUNCTION "forward_re_encryption_job"();--> statement-breakpoint
INSERT INTO "envelope_revocation_jobs"
  ("id", "scope", "user_id", "hub_id", "status", "total_envelopes", "processed_envelopes", "started_at", "completed_at", "created_at")
SELECT "id", "scope", "user_id", "hub_id", "status", "total_envelopes", "processed_envelopes", "started_at", "completed_at", "created_at"
FROM "re_encryption_jobs"
ON CONFLICT ("id") DO NOTHING;
