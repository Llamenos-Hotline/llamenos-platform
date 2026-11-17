-- #1342 (D3): a volunteer reads the calls THEY answered, inside the hub's
-- access window, as a system of record.
--
-- 1. `call_records.answered_at` — the window is measured from the answer time,
--    server-side, in the same query as `answered_by = self`. Rows written
--    before this column existed keep NULL: they were never sealed to the
--    answering volunteer's device, so serving them would only hand the client
--    records it cannot open. They stay readable by every holder of
--    `calls:read-history`, exactly as before. Nothing is deleted.
ALTER TABLE "call_records" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "call_records_hub_answered_by_answered_at_idx" ON "call_records" USING btree ("hub_id","answered_by","answered_at" DESC NULLS LAST);--> statement-breakpoint
-- 2. `calls:read-own-history` for the shipped `role-volunteer`.
--
-- The source list was extended in packages/shared/permissions.ts, but
-- `SettingsService.ensureInit` seeds DEFAULT_ROLES only into an EMPTY roles
-- table, so a database created before this change never picks it up. Same
-- shape and reasoning as 20261110050530_volunteer_can_request_shift_join.sql:
--
--   * Only `role-volunteer`. Other roles are NOT touched — an operator's own
--     call-answering role without history access is a coherent policy this
--     migration must not overrule. Hub TEMPLATE roles are a separate list
--     (packages/protocol/templates/*.json) and are not rewritten here.
--   * Only when absent (idempotent), and only when the role can answer calls.
--   * Nothing is ever removed.
UPDATE "roles"
   SET "permissions" = "permissions" || ARRAY['calls:read-own-history'],
       "updated_at"  = now()
 WHERE "id" = 'role-volunteer'
   AND NOT ('calls:read-own-history' = ANY("permissions"))
   AND NOT ('calls:*' = ANY("permissions"))
   AND NOT ('*' = ANY("permissions"))
   AND (
         'calls:answer' = ANY("permissions")
      OR 'calls:*'      = ANY("permissions")
   );
--> statement-breakpoint
