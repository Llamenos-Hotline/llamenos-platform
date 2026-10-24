-- Every hub must always have at least one admin (#2126).
--
-- The application now refuses to create a hub without an admin and refuses every
-- change that would remove the last one (apps/worker/lib/hub-admin.ts). Hubs
-- created before that can already be at zero, because the old create path
-- granted the creator's admin role in a second step whose failure was only
-- logged. A note filed in such a hub cannot be read by any admin, and that is
-- unrecoverable, so the existing violations are repaired here, deliberately:
--
--   * a hub with no admin is given back the one admin the create path always
--     intended -- its creator (hubs.created_by) -- provided that user is still
--     active and not erased. The grant is `role-hub-admin`, merged into any
--     assignment the creator already holds in the hub;
--   * a hub whose creator cannot be restored (gone, deactivated, erased, or a
--     non-user such as the test harness) is NOT touched: promoting an arbitrary
--     member would be a silent privilege grant. It is reported below and has to
--     be fixed by an operator (grant a member an admin role, or delete the hub).
--
-- "Admin" here is the SQL form of lib/hub-admin.ts: an active, un-erased user
-- whose assignment in the hub holds role-hub-admin, role-super-admin, or a role
-- whose permissions grant settings:manage and notes:read-all (directly,
-- through settings:* / notes:*, or through *). An erasure request in flight is
-- not considered here; the application counts such an admin as departing.
--
-- Counts are emitted as NOTICE/WARNING so the migration log states how many
-- hubs it found and what it did with them.
DO $$
DECLARE
  hub_row RECORD;
  violating integer := 0;
  repaired integer := 0;
  touched integer;
  unrepaired text[] := ARRAY[]::text[];
BEGIN
  FOR hub_row IN
    SELECT h.id, h.created_by
    FROM hubs h
    WHERE NOT EXISTS (
      SELECT 1
      FROM users u, jsonb_array_elements(u.hub_roles) AS a
      WHERE u.active
        AND u.status = 'active'
        AND a->>'hubId' = h.id
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(a->'roleIds') AS rid
          WHERE rid IN ('role-hub-admin', 'role-super-admin')
             OR EXISTS (
               SELECT 1 FROM roles r
               WHERE r.id = rid
                 AND (
                   r.permissions @> ARRAY['*']
                   OR (
                     r.permissions && ARRAY['settings:manage', 'settings:*']
                     AND r.permissions && ARRAY['notes:read-all', 'notes:*']
                   )
                 )
             )
        )
    )
  LOOP
    violating := violating + 1;

    UPDATE users
    SET hub_roles = CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(users.hub_roles) AS a WHERE a->>'hubId' = hub_row.id
          )
          THEN (
            SELECT COALESCE(
              jsonb_agg(
                CASE
                  WHEN a.value->>'hubId' = hub_row.id
                  THEN jsonb_set(a.value, '{roleIds}', COALESCE(a.value->'roleIds', '[]'::jsonb) || '"role-hub-admin"'::jsonb)
                  ELSE a.value
                END
                ORDER BY a.ord
              ),
              '[]'::jsonb
            )
            FROM jsonb_array_elements(users.hub_roles) WITH ORDINALITY AS a(value, ord)
          )
          ELSE users.hub_roles || jsonb_build_array(
            jsonb_build_object('hubId', hub_row.id, 'roleIds', jsonb_build_array('role-hub-admin'))
          )
        END,
        updated_at = now()
    WHERE users.pubkey = hub_row.created_by
      AND users.active
      AND users.status = 'active';

    GET DIAGNOSTICS touched = ROW_COUNT;
    IF touched > 0 THEN
      repaired := repaired + 1;
    ELSE
      unrepaired := array_append(unrepaired, hub_row.id);
    END IF;
  END LOOP;

  RAISE NOTICE '[hub-admin-invariant] hubs with no admin: %, repaired by restoring the creator as hub admin: %, left for an operator: %',
    violating, repaired, cardinality(unrepaired);
  IF cardinality(unrepaired) > 0 THEN
    RAISE WARNING '[hub-admin-invariant] these hubs still have no admin and need one granted by an operator (or deleting): %',
      array_to_string(unrepaired, ', ');
  END IF;
END
$$;
