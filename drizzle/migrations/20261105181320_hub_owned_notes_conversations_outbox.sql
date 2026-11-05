-- Notes, contact metadata, conversations and outbox events belong to a hub (#2459, #2464).
--
-- Each of these columns was nullable, and nothing but application code kept a
-- hubless row out. A hubless note or conversation is one no hub admin can ever
-- read, a hubless outbox event has no audience, and a hubless contact-metadata row
-- counts nobody's notes. Every hub_id is now NOT NULL with a foreign key to hubs,
-- so the database itself refuses the row, together with one that names a hub that
-- does not exist.
--
-- Tighten in place (docs/runbooks/migrations.md). Each `constrain` annotation below
-- names what stops the previous release writing a row the constraint rejects.
--
-- Rows already stored. Outbox rows are only a delivery queue, and a hubless or
-- dangling one can never be delivered (the drain refused it), so those are deleted.
-- Hubless notes and conversations are unreachable through every route (#2381,
-- #2395), but they are caller data, so this migration does not delete them. The
-- check below refuses the whole file instead, naming each table and its count, and
-- the previous release keeps serving until an operator decides what to do with the
-- rows. That check runs BEFORE any constraint is added. The runner retries a failed
-- file from its first statement, and ADD CONSTRAINT has no IF NOT EXISTS. If a
-- dangling row were found at the third FK, the first one would already exist, and
-- every later boot would stop on it.
DELETE FROM "event_outbox" WHERE "hub_id" IS NULL OR "hub_id" NOT IN (SELECT "id" FROM "hubs");--> statement-breakpoint
DO LANGUAGE plpgsql $$
DECLARE
  hubless text;
BEGIN
  SELECT string_agg(t || ': ' || n, ', ') INTO hubless FROM (
    SELECT 'notes' AS t, count(*) AS n FROM "notes" WHERE "hub_id" IS NULL OR "hub_id" NOT IN (SELECT "id" FROM "hubs")
    UNION ALL
    SELECT 'conversations', count(*) FROM "conversations" WHERE "hub_id" IS NULL OR "hub_id" NOT IN (SELECT "id" FROM "hubs")
    UNION ALL
    SELECT 'contact_metadata', count(*) FROM "contact_metadata" WHERE "hub_id" NOT IN (SELECT "id" FROM "hubs")
  ) AS counts WHERE n > 0;
  IF hubless IS NOT NULL THEN
    RAISE EXCEPTION 'rows with no hub, or a hub that does not exist (#2464): %. No route can reach them; delete or re-file them, then restart', hubless;
  END IF;
END
$$;--> statement-breakpoint
-- migration-safety: constrain column public.event_outbox.hub_id because the previous release's publishEvent drops an event naming no hub before it reaches the outbox, and the undeliverable hubless rows were deleted above
ALTER TABLE "event_outbox" ALTER COLUMN "hub_id" SET NOT NULL;--> statement-breakpoint
-- migration-safety: constrain column public.contact_metadata.hub_id because hub_id is already part of the table's primary key, so Postgres has always refused a NULL here
ALTER TABLE "contact_metadata" ALTER COLUMN "hub_id" SET NOT NULL;--> statement-breakpoint
-- migration-safety: constrain column public.conversations.hub_id because the previous release refuses a messaging webhook naming no hub or an unknown hub (#2395), its other production creators take the hub from a hub-scoped route or connection, and only the secret-gated dev simulation could omit it
ALTER TABLE "conversations" ALTER COLUMN "hub_id" SET NOT NULL;--> statement-breakpoint
-- migration-safety: constrain column public.notes.hub_id because the note routes are hub-only since #2395, and the server transcription notes that omitted the hub are filed under the call's hub by this release, so only a rollout-window transcript insert can fail, loudly and logged
ALTER TABLE "notes" ALTER COLUMN "hub_id" SET NOT NULL;--> statement-breakpoint
-- migration-safety: constrain column public.event_outbox.hub_id because every hub id the previous release publishes to is read from an existing hub row or path, and dangling outbox rows were deleted above
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-safety: constrain column public.contact_metadata.hub_id because the previous release writes contact metadata only from note creation, whose callers with a contact hash all pass a hub-scoped route's hub
ALTER TABLE "contact_metadata" ADD CONSTRAINT "contact_metadata_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-safety: constrain column public.conversations.hub_id because the previous release files a conversation only under a hub the webhook checked with getHub, a hub-scoped route's hub, or an existing connection's hub
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-safety: constrain column public.notes.hub_id because the previous release files a note only under a hub-scoped route's hub, a seeded hub, or no hub at all, which the statement above already refuses
ALTER TABLE "notes" ADD CONSTRAINT "notes_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;
