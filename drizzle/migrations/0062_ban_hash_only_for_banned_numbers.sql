-- The server keeps a hash of a number only if that number is banned (#2182, D2).
--
-- Every existing ban hash is HMAC(HMAC_SECRET, number): one key shared by all
-- hubs, kept beside the data, so the hash is reversible by anyone holding a dump
-- and that secret. Ban hashes are now HMAC(HKDF(BAN_HASH_KEY, hub | 'platform'),
-- number), a different key per scope, so an old row can never match a new
-- caller, and its number cannot be recovered to re-hash it. The app is
-- pre-production, so the rows are discarded rather than kept as dead weight that
-- still carries the old, reversible hash. Re-ban any number that matters.
DELETE FROM "bans";--> statement-breakpoint
ALTER TABLE "bans" DROP COLUMN "phone_display";--> statement-breakpoint
-- A live call holds its caller's number sealed with SERVER_KEK, for the call's life
-- only, instead of a hash of it. Calls in flight at migration time lose
-- ban-from-call; they end within minutes.
ALTER TABLE "active_calls" ADD COLUMN "caller_number_sealed" text;--> statement-breakpoint
ALTER TABLE "active_calls" DROP COLUMN "caller_number_hash";
