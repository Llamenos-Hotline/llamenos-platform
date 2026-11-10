-- #1518: the shipped `role-volunteer` was created with `shifts:set-availability`
-- but without `shifts:request-join`, so a plain volunteer got 403 from
-- `POST /hubs/:hubId/shifts/requests`
-- (requirePermission('shifts:request-join'), apps/worker/routes/shifts.ts) —
-- the EP07 self-service flow ("request to join or leave a shift") that role
-- exists to use. Same bug class as #1342, one namespace over.
--
-- The source list was corrected in packages/shared/permissions.ts, but
-- `SettingsService.ensureInit` seeds DEFAULT_ROLES only when the roles table is
-- EMPTY, so a database created before this fix never picks it up. A fresh
-- install is already correct; this is only for one that already exists.
-- (Same reasoning as 0052_volunteer_can_set_availability.sql.)
--
-- Deliberately narrow, and purely ADDITIVE:
--
--   * Only `role-volunteer` — the shipped default, matching exactly what the
--     source change grants. Other roles are NOT touched: "answers calls but
--     may not request shift membership" is a coherent policy for an
--     operator's own role (an admin-controlled roster), and this migration
--     must not overrule it. Hub TEMPLATE roles are a separate list
--     (packages/protocol/templates/*.json) and are not rewritten here either.
--   * Only when the permission is absent, so it is idempotent.
--   * Only when the role can actually answer calls, so a role an operator has
--     repurposed into something non-call-facing is left alone.
--   * Nothing is ever removed.
UPDATE "roles"
   SET "permissions" = "permissions" || ARRAY['shifts:request-join'],
       "updated_at"  = now()
 WHERE "id" = 'role-volunteer'
   AND NOT ('shifts:request-join' = ANY("permissions"))
   AND NOT ('shifts:*' = ANY("permissions"))
   AND NOT ('*' = ANY("permissions"))
   AND (
         'calls:answer' = ANY("permissions")
      OR 'calls:*'      = ANY("permissions")
   );
--> statement-breakpoint
