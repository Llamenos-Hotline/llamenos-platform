ALTER TABLE "shift_overrides" ADD COLUMN "note_envelopes" jsonb;--> statement-breakpoint
ALTER TABLE "user_availability_blocks" ADD COLUMN "reason_envelopes" jsonb;--> statement-breakpoint
-- #2777 / #2778: both columns were named encrypted_* and held the typed text
-- (iOS sent the string; the schema accepted any string). No row written before
-- this migration has envelopes, so every non-NULL value is plaintext. Scrub it
-- rather than delete the rows: the blocks and overrides keep governing routing,
-- only the free text goes. Pre-production, so there is no sealed copy to restore.
UPDATE "user_availability_blocks" SET "encrypted_reason" = NULL WHERE "reason_envelopes" IS NULL;--> statement-breakpoint
UPDATE "shift_overrides" SET "encrypted_note" = NULL WHERE "note_envelopes" IS NULL;
