-- #1050: PUK envelopes are addressed by sigchain device ID (the ID the envelope's
-- HPKE AAD binds), not by the push-registry devices.id, and carry a structured
-- HPKE v3 envelope. No client has ever written a PUK envelope (identity
-- initialisation did not exist before this change), so rows still in the old
-- text format are unopenable placeholders and cannot be converted. The type
-- change is guarded on the current column type because scripts/run-migrations.ts
-- replays every migration on each start — the purge must run exactly once.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'puk_envelopes' AND column_name = 'envelope') = 'text' THEN
    DELETE FROM "puk_envelopes";
    ALTER TABLE "puk_envelopes" ALTER COLUMN "envelope" SET DATA TYPE jsonb USING "envelope"::jsonb;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "puk_envelopes" DROP CONSTRAINT IF EXISTS "puk_envelopes_device_gen_uniq";--> statement-breakpoint
ALTER TABLE "puk_envelopes" DROP CONSTRAINT IF EXISTS "puk_envelopes_device_id_devices_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "sigchain_links_user_seq_idx";--> statement-breakpoint
ALTER TABLE "sigchain_links" ADD CONSTRAINT "sigchain_links_user_seq_uniq" UNIQUE("user_pubkey","seq_no");--> statement-breakpoint
ALTER TABLE "puk_envelopes" ADD CONSTRAINT "puk_envelopes_user_device_gen_uniq" UNIQUE("user_pubkey","device_id","generation");
