-- #1342: the shipped `role-volunteer` was created with `calls:answer` but
-- without `shifts:set-availability`, so the one role an ordinary volunteer
-- gets answered calls and got 403 from `POST /shifts/clock-in`
-- (requirePermission('shifts:set-availability'), apps/worker/routes/shifts.ts).
--
-- The source list was corrected in packages/shared/permissions.ts, but
-- `SettingsService.ensureInit` seeds DEFAULT_ROLES only when the roles table is
-- EMPTY, so a database created before that fix never picks it up. A fresh
-- install is already correct; this is only for one that already exists.
--
-- Deliberately narrow, and purely ADDITIVE:
--
--   * Only `role-volunteer` — the shipped default, matching exactly what the
--     source change grants. Other roles that can answer calls are NOT touched:
--     "answers calls but may not mark themselves available" is a coherent
--     policy for an operator's own role (an admin-controlled roster), and this
--     migration must not overrule it. See the PR for the SQL an operator can
--     run if their hub-template roles predate #1406.
--   * Only when the permission is absent, so it is idempotent.
--   * Only when the role can actually answer calls, so a role an operator has
--     repurposed into something non-call-facing is left alone.
--   * Nothing is ever removed.
UPDATE "roles"
   SET "permissions" = "permissions" || ARRAY['shifts:set-availability'],
       "updated_at"  = now()
 WHERE "id" = 'role-volunteer'
   AND NOT ('shifts:set-availability' = ANY("permissions"))
   AND NOT ('shifts:*' = ANY("permissions"))
   AND NOT ('*' = ANY("permissions"))
   AND (
         'calls:answer' = ANY("permissions")
      OR 'calls:*'      = ANY("permissions")
   );
