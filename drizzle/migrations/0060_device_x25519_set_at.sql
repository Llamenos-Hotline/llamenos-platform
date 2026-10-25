-- Existing rows take the migration time: when each key was really set is not
-- recorded anywhere, and the safe answer for an unknown is "recent". A device's
-- key therefore counts as newer than every message that predates this migration
-- until it is confirmed (#2143). Pre-production: no backfill from registered_at,
-- which would understate the age of any key that was overwritten.
ALTER TABLE "devices" ADD COLUMN "x25519_set_at" timestamp with time zone DEFAULT now() NOT NULL;
