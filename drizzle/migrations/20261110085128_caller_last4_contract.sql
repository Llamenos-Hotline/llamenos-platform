-- #2400: the contract phase of #2262 / #2399 (docs/runbooks/migrations.md).
--
-- 20261031214240_scrub_caller_last4.sql was the forget release: the code and
-- the drizzle schema stopped declaring `active_calls.caller_last4` and
-- `call_records.caller_last4`, every stored digit was erased, and a trigger on
-- each table kept the column NULL against a previous-release pod's writes
-- during the rollout. That release is the one being replaced now, so the
-- columns, both triggers and the trigger function go.
--
-- Order matters: the triggers reference the function, so they drop first; the
-- function references NEW.caller_last4, so it drops before the columns. Every
-- statement is re-runnable (IF EXISTS), so the runner's retry of a failed file
-- from its first statement repeats nothing harmful.
DROP TRIGGER IF EXISTS "active_calls_discard_caller_last4" ON "active_calls";--> statement-breakpoint
DROP TRIGGER IF EXISTS "call_records_discard_caller_last4" ON "call_records";--> statement-breakpoint
DROP FUNCTION IF EXISTS "discard_caller_last4"();--> statement-breakpoint
-- migration-safety: allow column public.active_calls.caller_last4 because 20261031214240_scrub_caller_last4 (#2399) stopped the code declaring it, erased every stored value, and nulled any rollout-window write
ALTER TABLE "active_calls" DROP COLUMN IF EXISTS "caller_last4";--> statement-breakpoint
-- migration-safety: allow column public.call_records.caller_last4 because 20261031214240_scrub_caller_last4 (#2399) stopped the code declaring it, erased every stored value, and nulled any rollout-window write
ALTER TABLE "call_records" DROP COLUMN IF EXISTS "caller_last4";
