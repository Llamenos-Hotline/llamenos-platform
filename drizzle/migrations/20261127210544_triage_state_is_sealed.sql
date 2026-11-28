-- #2779, #3114: a case's status, severity and category, an event's status, and a
-- contact's type and status are sealed in their summaries and filtered on the
-- client. The server holds none of them, so these columns were the plaintext
-- value under a "hash" name, and the indexes over them served a filter no
-- client can satisfy. Every stored value is erased, and a trigger on each table
-- keeps the columns NULL against a previous-release pod that is still writing
-- during the rollout.
--
-- This is the release that stops declaring them (docs/runbooks/migrations.md).
-- The generated DROP COLUMN statements are deliberately absent: the gate
-- refuses a drop while the release being replaced still declares the column.
-- case_records.status_hash and events.status_hash were NOT NULL, and a column
-- may only be forgotten once it is nullable, so those two are relaxed here and
-- stay declared (as `retiredStatus`, never read or written) for one more
-- release. The contract release drops every column, the triggers and the
-- functions below.
--
-- Every statement is re-runnable (IF EXISTS, OR REPLACE): the runner retries an interrupted file
-- from its first statement.
--
-- The four indexes go now: nothing queries by them, and an index over a column
-- that is always NULL only costs writes.
DROP INDEX IF EXISTS "case_records_hub_id_status_hash_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "case_records_hub_id_severity_hash_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "case_records_hub_id_category_hash_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "events_hub_id_status_hash_idx";--> statement-breakpoint
ALTER TABLE "case_records" ALTER COLUMN "status_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "status_hash" DROP NOT NULL;--> statement-breakpoint
UPDATE "case_records" SET "status_hash" = NULL, "severity_hash" = NULL, "category_hash" = NULL
WHERE "status_hash" IS NOT NULL OR "severity_hash" IS NOT NULL OR "category_hash" IS NOT NULL;--> statement-breakpoint
UPDATE "events" SET "status_hash" = NULL WHERE "status_hash" IS NOT NULL;--> statement-breakpoint
UPDATE "contacts" SET "contact_type_hash" = NULL, "status_hash" = NULL
WHERE "contact_type_hash" IS NOT NULL OR "status_hash" IS NOT NULL;--> statement-breakpoint
UPDATE "case_interactions" SET "previous_status_hash" = NULL, "new_status_hash" = NULL
WHERE "previous_status_hash" IS NOT NULL OR "new_status_hash" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "discard_case_record_triage_hashes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW."status_hash" := NULL;
	NEW."severity_hash" := NULL;
	NEW."category_hash" := NULL;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "case_records_discard_triage_hashes" BEFORE INSERT OR UPDATE ON "case_records"
FOR EACH ROW EXECUTE FUNCTION "discard_case_record_triage_hashes"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "discard_event_status_hash"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW."status_hash" := NULL;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "events_discard_status_hash" BEFORE INSERT OR UPDATE ON "events"
FOR EACH ROW EXECUTE FUNCTION "discard_event_status_hash"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "discard_contact_triage_hashes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW."contact_type_hash" := NULL;
	NEW."status_hash" := NULL;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "contacts_discard_triage_hashes" BEFORE INSERT OR UPDATE ON "contacts"
FOR EACH ROW EXECUTE FUNCTION "discard_contact_triage_hashes"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "discard_interaction_status_hashes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW."previous_status_hash" := NULL;
	NEW."new_status_hash" := NULL;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "case_interactions_discard_status_hashes" BEFORE INSERT OR UPDATE ON "case_interactions"
FOR EACH ROW EXECUTE FUNCTION "discard_interaction_status_hashes"();
