-- Messaging threads are named by a per-hub keyed hash, and nothing about the
-- contact's number is displayed or stored in the clear (#2182, D2).
--
-- A conversation's contact hash was HMAC(HMAC_SECRET, identifier): one key shared
-- by every hub, kept beside the data, so a database dump plus that secret
-- confirmed whether a given number had written to the hotline, in any hub. It is
-- now HMAC(HKDF(MESSAGING_HASH_KEY, hub), identifier), a key held only as a file.
-- An old hash can never equal a new one, and the identifier behind it cannot be
-- recovered to re-hash it (the reply address is sealed, but opening every one
-- would put every contact in memory at once). The app is pre-production, so the
-- hash is blanked rather than kept as a dead identifier under the old, reversible
-- key: that contact's next message opens a new thread. Existing threads keep their
-- messages and reply address. 'web' conversations (reports) and firehose agent
-- conversations are keyed by a pubkey, not by this hash, and are left alone.
UPDATE "conversations" SET "contact_identifier_hash" = ''
  WHERE "channel_type" IN ('sms', 'whatsapp', 'signal', 'rcs', 'telegram');--> statement-breakpoint
-- The last four digits of the contact's number, stored beside the hash. Gone with it.
ALTER TABLE "conversations" DROP COLUMN "contact_last4";
