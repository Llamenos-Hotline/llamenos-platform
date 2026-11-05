-- #2462: every file names its hub and a typed parent inside it.
--
-- Expand phase. hub_id and owner_kind arrive nullable because the release this
-- one replaces never names them on INSERT; this release writes both on every
-- insert (routes/uploads.ts, mounted only under /hubs/:hubId), and the next
-- release tightens both to NOT NULL with a `constrain` annotation.
ALTER TABLE "files" ADD COLUMN "hub_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "owner_kind" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "case_record_id" text;--> statement-breakpoint
-- Backfill: before this migration the only parent a file could name was a
-- conversation, and the conversation's hub is the file's hub.
UPDATE "files" AS f SET "hub_id" = c."hub_id", "owner_kind" = 'conversation'
  FROM "conversations" AS c
  WHERE f."conversation_id" = c."id" AND c."hub_id" IS NOT NULL AND f."hub_id" IS NULL;--> statement-breakpoint
-- Dual write for the expand phase, by the database: an INSERT from the
-- previous release (rollout window or rollback) names a conversation but no
-- hub. Fill hub_id and owner_kind from that conversation, so the hub shred —
-- which reaches files by hub_id — still reaches the row. A row whose
-- conversation has no hub stays hubless and is removed by the contract
-- release, which also drops this trigger.
CREATE FUNCTION "files_fill_hub_from_conversation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hub_id IS NULL AND NEW.owner_kind IS NULL AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.hub_id INTO NEW.hub_id FROM conversations c WHERE c.id = NEW.conversation_id;
    IF NEW.hub_id IS NOT NULL THEN
      NEW.owner_kind := 'conversation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "files_fill_hub" BEFORE INSERT ON "files" FOR EACH ROW EXECUTE FUNCTION "files_fill_hub_from_conversation"();--> statement-breakpoint
-- A file follows its parent (D7a A-D7A-5). The original conversation FK was
-- NO ACTION, which refused deleting a conversation that has files before the
-- cascade below could run; recreate it as ON DELETE CASCADE.
ALTER TABLE "files" DROP CONSTRAINT "files_conversation_id_conversations_id_fk";--> statement-breakpoint
-- migration-safety: constrain column public.files.conversation_id because it is the same reference the replaced constraint already enforced on every previous-release write
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-safety: constrain column public.conversations.id because id is already the primary key, so no two rows can share an (id, hub_id) pair
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_id_hub_id_unique" UNIQUE("id","hub_id");--> statement-breakpoint
-- migration-safety: constrain column public.case_records.id because id is already the primary key, so no two rows can share an (id, hub_id) pair
ALTER TABLE "case_records" ADD CONSTRAINT "case_records_id_hub_id_unique" UNIQUE("id","hub_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-safety: constrain column public.files.conversation_id because the previous release never writes hub_id, and files_fill_hub copies it from the very conversation the row names, so the pair matches (or stays NULL, which MATCH SIMPLE skips)
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_hub_fk" FOREIGN KEY ("conversation_id","hub_id") REFERENCES "public"."conversations"("id","hub_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_case_record_hub_fk" FOREIGN KEY ("case_record_id","hub_id") REFERENCES "public"."case_records"("id","hub_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-safety: constrain column public.files.conversation_id because the previous release writes only conversation_id, which files_fill_hub turns into owner_kind 'conversation' (or leaves owner_kind NULL, which a CHECK admits)
ALTER TABLE "files" ADD CONSTRAINT "files_owner_check" CHECK ((owner_kind = 'conversation' AND conversation_id IS NOT NULL AND case_record_id IS NULL)
       OR (owner_kind = 'case_record' AND case_record_id IS NOT NULL AND conversation_id IS NULL)
       OR (owner_kind = 'entity_field' AND conversation_id IS NULL AND case_record_id IS NULL));--> statement-breakpoint
-- NOT VALID: enforced on every new evidence row, without judging rows written
-- before the route checked that the file exists (the old test fixture posted a
-- file id that was never uploaded). The contract release validates it after
-- removing those rows.
-- migration-safety: constrain column public.evidence.file_id because no client can post evidence before its upload completes, and the previous release's uploads to a case record always failed
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "files_hub_id_idx" ON "files" USING btree ("hub_id");--> statement-breakpoint
CREATE INDEX "files_case_record_id_idx" ON "files" USING btree ("case_record_id");
