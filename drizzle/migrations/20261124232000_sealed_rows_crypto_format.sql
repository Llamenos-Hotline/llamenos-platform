-- #2964: every sealed-row table records the crypto format that wrote it, and
-- case_records.hub_id becomes NOT NULL, before the pilot writes real data.
--
-- crypto_format: NOT NULL with DEFAULT 1, so every existing row is stamped 1
-- (the only format that has ever existed) and the previous release's INSERTs,
-- which do not name the column, keep working. Each table's
-- <table>_crypto_format_known CHECK admits only the formats listed in
-- packages/protocol/crypto-formats.json; it constrains a column this file
-- creates, so no earlier write can violate it. The next format widens every
-- CHECK through `bun run db:generate` (apps/worker/db/crypto-format.ts).
ALTER TABLE "shift_overrides" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_type_templates" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_user_keys" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_role_envelopes" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "active_calls" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "affinity_groups" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "case_interactions" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "case_records" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_identifiers" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "firehose_connections" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "firehose_message_buffer" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "firehose_window_keys" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_recovery_group_shares" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_storage_credentials" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "note_replies" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "puk_envelopes" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_session_contributions" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "report_cases" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ring_groups" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_message_queue" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_availability_blocks" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_recovery_envelopes" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_role_envelopes" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_signal_contacts" ADD COLUMN "crypto_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_overrides" ADD CONSTRAINT "shift_overrides_crypto_format_known" CHECK ("shift_overrides"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "entity_type_templates" ADD CONSTRAINT "entity_type_templates_crypto_format_known" CHECK ("entity_type_templates"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_crypto_format_known" CHECK ("shifts"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "audit_user_keys" ADD CONSTRAINT "audit_user_keys_crypto_format_known" CHECK ("audit_user_keys"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_crypto_format_known" CHECK ("subscribers"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "hub_keys" ADD CONSTRAINT "hub_keys_crypto_format_known" CHECK ("hub_keys"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "hubs" ADD CONSTRAINT "hubs_crypto_format_known" CHECK ("hubs"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "platform_role_envelopes" ADD CONSTRAINT "platform_role_envelopes_crypto_format_known" CHECK ("platform_role_envelopes"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_crypto_format_known" CHECK ("roles"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "active_calls" ADD CONSTRAINT "active_calls_crypto_format_known" CHECK ("active_calls"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "affinity_groups" ADD CONSTRAINT "affinity_groups_crypto_format_known" CHECK ("affinity_groups"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_crypto_format_known" CHECK ("call_records"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "case_interactions" ADD CONSTRAINT "case_interactions_crypto_format_known" CHECK ("case_interactions"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "case_records" ADD CONSTRAINT "case_records_crypto_format_known" CHECK ("case_records"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "contact_identifiers" ADD CONSTRAINT "contact_identifiers_crypto_format_known" CHECK ("contact_identifiers"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_crypto_format_known" CHECK ("contact_relationships"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_crypto_format_known" CHECK ("contacts"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_crypto_format_known" CHECK ("events"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_crypto_format_known" CHECK ("evidence"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_crypto_format_known" CHECK ("files"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "firehose_connections" ADD CONSTRAINT "firehose_connections_crypto_format_known" CHECK ("firehose_connections"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "firehose_message_buffer" ADD CONSTRAINT "firehose_message_buffer_crypto_format_known" CHECK ("firehose_message_buffer"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "firehose_window_keys" ADD CONSTRAINT "firehose_window_keys_crypto_format_known" CHECK ("firehose_window_keys"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "hub_recovery_group_shares" ADD CONSTRAINT "hub_recovery_group_shares_crypto_format_known" CHECK ("hub_recovery_group_shares"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "hub_storage_credentials" ADD CONSTRAINT "hub_storage_credentials_crypto_format_known" CHECK ("hub_storage_credentials"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_crypto_format_known" CHECK ("messages"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "note_replies" ADD CONSTRAINT "note_replies_crypto_format_known" CHECK ("note_replies"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_crypto_format_known" CHECK ("notes"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_crypto_format_known" CHECK ("provider_configs"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "puk_envelopes" ADD CONSTRAINT "puk_envelopes_crypto_format_known" CHECK ("puk_envelopes"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "recovery_session_contributions" ADD CONSTRAINT "recovery_session_contributions_crypto_format_known" CHECK ("recovery_session_contributions"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_crypto_format_known" CHECK ("report_cases"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "ring_groups" ADD CONSTRAINT "ring_groups_crypto_format_known" CHECK ("ring_groups"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "signal_message_queue" ADD CONSTRAINT "signal_message_queue_crypto_format_known" CHECK ("signal_message_queue"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_crypto_format_known" CHECK ("tags"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_crypto_format_known" CHECK ("teams"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "user_availability_blocks" ADD CONSTRAINT "user_availability_blocks_crypto_format_known" CHECK ("user_availability_blocks"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "user_recovery_envelopes" ADD CONSTRAINT "user_recovery_envelopes_crypto_format_known" CHECK ("user_recovery_envelopes"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "user_role_envelopes" ADD CONSTRAINT "user_role_envelopes_crypto_format_known" CHECK ("user_role_envelopes"."crypto_format" IN (1));--> statement-breakpoint
ALTER TABLE "user_signal_contacts" ADD CONSTRAINT "user_signal_contacts_crypto_format_known" CHECK ("user_signal_contacts"."crypto_format" IN (1));--> statement-breakpoint
-- case_records.hub_id NOT NULL (#2964, #2510). Rows written before hubId was
-- required take the hub of their entity type, which is always hub-scoped.
UPDATE "case_records" AS cr
SET "hub_id" = etd."hub_id"
FROM "entity_type_definitions" AS etd
WHERE cr."hub_id" IS NULL
  AND cr."entity_type_id" = etd."id"
  AND etd."hub_id" <> '';--> statement-breakpoint
-- A record with neither a hub nor a hub-scoped entity type cannot be placed,
-- and deleting it would destroy data. Stop here with a message that says so;
-- the migration stays unapplied and the previous release keeps serving.
DO $$
DECLARE
  hubless bigint;
BEGIN
  SELECT count(*) INTO hubless FROM "case_records" WHERE "hub_id" IS NULL;
  IF hubless > 0 THEN
    RAISE EXCEPTION 'case_records: % row(s) have no hub_id and no hub-scoped entity type to take one from. Assign each a hub (UPDATE case_records SET hub_id = ... WHERE hub_id IS NULL) and re-run the migration (#2964).', hubless;
  END IF;
END $$;--> statement-breakpoint
-- migration-safety: constrain column public.case_records.hub_id because CasesService.create and convertFromReport, the only writers of case_records, have required a non-null hubId string on every insert since before this release, and the backfill above fills every older row
ALTER TABLE "case_records" ALTER COLUMN "hub_id" SET NOT NULL;
