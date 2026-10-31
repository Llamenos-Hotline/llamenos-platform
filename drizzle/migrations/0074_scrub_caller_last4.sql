-- No part of a caller's number is kept beside a call record (#2262, D2).
--
-- `active_calls` and `call_records` carried the last four digits of the caller's
-- number in the clear. Four digits kept beside a per-call record narrow a database
-- dump to a handful of candidate callers, and no client needs them: the incoming card
-- names the hub, a call row names its time, duration, outcome and (to an admin) the
-- volunteer who answered, and the full number lives only in the admin envelope
-- sealed when the call ended.
--
-- Expand/contract (docs/runbooks/migrations.md): this is the FORGET release. The code
-- and the drizzle schema no longer declare `caller_last4`, and the regenerated
-- snapshot reflects that; the previous release still names the column in its INSERTs
-- and SELECTs, so the DROP waits for the contract migration one release later. What
-- cannot wait is the data. Every digit already stored is erased here, and a trigger
-- keeps the column NULL while it exists: during a rollout a previous-release pod can
-- still write digits, and a CHECK constraint would fail that INSERT and drop a live
-- call, so the write is accepted and the value discarded. The previous release reads
-- NULL as "no digits". The contract migration drops the column, both triggers and
-- this function.
--
-- Order matters: the trigger exists BEFORE the scrub, so a row written between the two
-- is nulled by the trigger and every row committed before it is nulled by the UPDATE.
CREATE FUNCTION "discard_caller_last4"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."caller_last4" := NULL;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "active_calls_discard_caller_last4" BEFORE INSERT OR UPDATE ON "active_calls"
  FOR EACH ROW EXECUTE FUNCTION "discard_caller_last4"();--> statement-breakpoint
CREATE TRIGGER "call_records_discard_caller_last4" BEFORE INSERT OR UPDATE ON "call_records"
  FOR EACH ROW EXECUTE FUNCTION "discard_caller_last4"();--> statement-breakpoint
UPDATE "active_calls" SET "caller_last4" = NULL WHERE "caller_last4" IS NOT NULL;--> statement-breakpoint
UPDATE "call_records" SET "caller_last4" = NULL WHERE "caller_last4" IS NOT NULL;
