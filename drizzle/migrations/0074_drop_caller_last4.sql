-- No part of a caller's number is stored beside a call record (#2262, D2).
--
-- `active_calls` and `call_records` carried the last four digits of the caller's
-- number in the clear. Four digits kept beside a per-call record narrow a database
-- dump to a handful of candidate callers, and no client needs them: the incoming card
-- names the hub, a call row names its time, duration, outcome and (to an admin) the
-- volunteer who answered, and the full number lives only in the admin envelope
-- sealed when the call ended. The columns are dropped outright; the app is
-- pre-production and the digits cannot be recovered from anything that remains.
ALTER TABLE "active_calls" DROP COLUMN "caller_last4";--> statement-breakpoint
ALTER TABLE "call_records" DROP COLUMN "caller_last4";
