ALTER TABLE "notes" ALTER COLUMN "author_envelope" DROP NOT NULL;--> statement-breakpoint
-- `{}` was the stand-in for "no author envelope" while the column was NOT NULL.
UPDATE "notes" SET "author_envelope" = NULL WHERE "author_envelope" = '{}'::jsonb;
