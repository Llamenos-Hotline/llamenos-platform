-- #2118: messages.attachment_ids is what the drizzle schema has declared for a
-- long time (224130177) — text[] NOT NULL DEFAULT '{}' — and what every
-- snapshot since records, but no migration ever applied it. The column stayed
-- nullable with no default, so every message stored without attachments held
-- NULL, and GET /conversations/:id/messages served `attachmentIds: null`
-- against messageResponseSchema's array. The drift check compares the schema
-- with the snapshots, never with what the SQL builds, so nothing noticed.
--
-- Default first, so an INSERT from the previous release that omits the column
-- (its only writer, ConversationsService.addMessage, passes it only when set)
-- gets '{}' rather than NULL during the rollout window; then backfill; then
-- tighten.
ALTER TABLE "messages" ALTER COLUMN "attachment_ids" SET DEFAULT '{}'::text[];--> statement-breakpoint
UPDATE "messages" SET "attachment_ids" = '{}'::text[] WHERE "attachment_ids" IS NULL;--> statement-breakpoint
-- migration-safety: constrain column public.messages.attachment_ids because the previous release never writes NULL here — its one INSERT names the column only with an array and otherwise takes the DEFAULT '{}' set above — and the NULLs it left were backfilled by the statement before this one
ALTER TABLE "messages" ALTER COLUMN "attachment_ids" SET NOT NULL;
