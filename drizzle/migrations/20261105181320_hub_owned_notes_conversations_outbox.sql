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
-- names what stops the previous release writing a row the constraint rejects. Rows
-- already stored are checked by Postgres when each statement runs. A violating row
-- fails the migration, which leaves the previous release serving. Hubless notes and
-- conversations are unreachable through every route (#2381, #2395), but they are
-- caller data, so this migration does not delete them. An operator who hits the
-- failure decides what to do with them. Outbox rows are only a delivery queue: a
-- hubless or dangling one can never be delivered (the drain refused it), so those
-- are deleted first.
DELETE FROM "event_outbox" WHERE "hub_id" IS NULL OR "hub_id" NOT IN (SELECT "id" FROM "hubs");--> statement-breakpoint
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
