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
-- cannot wait is the data: every digit already stored is erased now, so a dump taken
-- after this migration holds none. The previous release reads NULL as "no digits".
UPDATE "active_calls" SET "caller_last4" = NULL WHERE "caller_last4" IS NOT NULL;--> statement-breakpoint
UPDATE "call_records" SET "caller_last4" = NULL WHERE "caller_last4" IS NOT NULL;
