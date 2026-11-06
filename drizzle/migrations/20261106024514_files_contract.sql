-- #2486: the contract phase of #2462 / #2484. Every file has a hub and an owner.
--
-- 20261105220703_files_hub_owner.sql gave files a composite (parent id, hub_id)
-- foreign key to each parent's (id, hub_id), but left hub_id and owner_kind
-- nullable for its rollout window. That made the composites decorative: Postgres
-- FKs are MATCH SIMPLE, so a NULL hub_id skips the whole check, and a NULL
-- owner_kind makes files_owner_check evaluate to NULL, which a CHECK admits. The
-- #2510 audit's probe.sql inserted a case-owned file naming an orphan record, a
-- case-owned file naming another hub's record, and a file with no owner, parent
-- or hub; all three were accepted. SET NOT NULL below is what makes the
-- composites refuse them.
--
-- Every statement is idempotent, so the runner's retry of a failed file from its
-- first statement repeats nothing harmful.
--
-- 1. The expand phase's dual write goes first. While files_fill_hub exists, an
--    INSERT that forgets the hub still succeeds whenever it names a
--    conversation: the trigger supplies the hub, and nothing surfaces the bug.
--    Every insert since #2484 names hub_id and owner_kind itself
--    (ConversationsService.createFile, the only producer), so the trigger has
--    nothing left to fill.
DROP TRIGGER IF EXISTS "files_fill_hub" ON "files";--> statement-breakpoint
DROP FUNCTION IF EXISTS "files_fill_hub_from_conversation"();--> statement-breakpoint
-- 2. Rows the constraints below reject. Pre-production, so they are deleted, not
--    re-filed (the #2486 PR body counts them per database). A hubless file is
--    one the backfill could not place: it names no conversation, so no hub
--    shred and no hub-scoped read reaches it. An evidence row whose file is
--    hubless or was never uploaded is an entry whose subject is absent (#2462;
--    the old fixture posted `file_${Date.now()}`). Its custody entries describe
--    only that entry, so they go with it; custody_entries.evidence_id has no FK
--    to cascade them, and leaving them would mint new orphans.
DELETE FROM "custody_entries" WHERE "evidence_id" IN (
  SELECT "id" FROM "evidence" WHERE "file_id" NOT IN (
    SELECT "id" FROM "files" WHERE "hub_id" IS NOT NULL AND "owner_kind" IS NOT NULL
  )
);--> statement-breakpoint
DELETE FROM "evidence" WHERE "file_id" NOT IN (
  SELECT "id" FROM "files" WHERE "hub_id" IS NOT NULL AND "owner_kind" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "files" WHERE "hub_id" IS NULL OR "owner_kind" IS NULL;--> statement-breakpoint
-- 3. The tightening.
-- migration-safety: constrain column public.files.hub_id because ConversationsService.createFile names the path hub on every insert since #2484, the fill trigger is dropped above, and hubless rows were deleted above
ALTER TABLE "files" ALTER COLUMN "hub_id" SET NOT NULL;--> statement-breakpoint
-- migration-safety: constrain column public.files.owner_kind because ConversationsService.createFile names the owner kind on every insert since #2484, and rows without one were deleted above
ALTER TABLE "files" ALTER COLUMN "owner_kind" SET NOT NULL;--> statement-breakpoint
-- 4. evidence.file_id has refused a new orphan since #2484 (NOT VALID exempts
--    only rows already stored); the orphans were deleted above, so the stored
--    rows now satisfy it as well.
ALTER TABLE "evidence" VALIDATE CONSTRAINT "evidence_file_id_files_id_fk";
