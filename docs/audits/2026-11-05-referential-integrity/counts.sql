-- #2510: generate the existing-violation COUNT queries for every edge in edges.sql.
--
-- This file only GENERATES SQL; it reads nothing but the catalog of the
-- database it runs on (use the scratch database from probe.sql). Run the
-- generated statements against the database to be measured in a READ-ONLY
-- session, so the measurement cannot write:
--
--   psql "$SCRATCH_URL" -X -At -f counts.sql > /tmp/counts-generated.sql
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$TARGET_URL" -X -At -F '|' -f /tmp/counts-generated.sql
--
-- Each line printed is: probe | rows that would violate the constraint.
-- A statement that errors (an older schema lacking the column) prints an
-- error and the run continues, so one missing column hides only its own line.

\set QUIET 1
\ir edges.sql

CREATE FUNCTION pg_temp.pkey(tbl text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE tbl WHEN 'users' THEN 'pubkey' WHEN 'call_records' THEN 'call_id' WHEN 'active_calls' THEN 'call_id'
                  WHEN 'recovery_sessions' THEN 'session_id' WHEN 'hub_recovery_groups' THEN 'hub_id' ELSE 'id' END $$;
CREATE FUNCTION pg_temp.has_hub(tbl text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tbl::regclass AND attname = 'hub_id' AND NOT attisdropped) $$;
CREATE FUNCTION pg_temp.is_arr(tbl text, col text) RETURNS boolean LANGUAGE sql AS $$
  SELECT format_type(atttypid, atttypmod) LIKE '%[]' FROM pg_attribute WHERE attrelid = tbl::regclass AND attname = col $$;

\pset tuples_only on
\pset format unaligned
SELECT stmt FROM (
  -- orphans: the edge names a parent that does not exist ('' counted separately)
  SELECT e.child, e.col, 1 AS ord, format(
    $q$SELECT %L, count(*) FROM %I c%s WHERE %s IS NOT NULL AND %s <> '' AND NOT EXISTS (SELECT 1 FROM %I p WHERE p.%I = %s);$q$,
    e.child || '.' || e.col || ' orphan', e.child,
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN format(' CROSS JOIN LATERAL unnest(c.%I) AS v(x)', e.col) ELSE '' END,
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN 'v.x' ELSE format('c.%I', e.col) END,
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN 'v.x' ELSE format('c.%I', e.col) END,
    e.parent, pg_temp.pkey(e.parent),
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN 'v.x' ELSE format('c.%I', e.col) END) AS stmt
  FROM edges e
  UNION ALL
  -- the '' sentinel used as a parent id
  SELECT e.child, e.col, 2, format($q$SELECT %L, count(*) FROM %I c WHERE c.%I = '';$q$,
    e.child || '.' || e.col || ' empty-string', e.child, e.col)
  FROM edges e WHERE NOT pg_temp.is_arr(e.child, e.col)
  UNION ALL
  -- cross-hub, direct: the child carries a hub_id that differs from its parent's
  SELECT e.child, e.col, 3, format(
    $q$SELECT %L, count(*) FROM %I c%s JOIN %I p ON p.%I = %s WHERE p.hub_id IS DISTINCT FROM c.hub_id;$q$,
    e.child || '.' || e.col || ' cross-hub', e.child,
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN format(' CROSS JOIN LATERAL unnest(c.%I) AS v(x)', e.col) ELSE '' END,
    e.parent, pg_temp.pkey(e.parent),
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN 'v.x' ELSE format('c.%I', e.col) END)
  FROM edges e
  WHERE e.parent NOT IN ('hubs', 'users') AND e.col <> 'hub_id' AND pg_temp.has_hub(e.child) AND pg_temp.has_hub(e.parent)
  UNION ALL
  -- cross-hub, anchored: a hub-less child whose two parents sit in different hubs
  SELECT e.child, e.col, 4, format(
    $q$SELECT %L, count(*) FROM %I c%s JOIN %I p ON p.%I = %s JOIN %I a ON a.%I = c.%I WHERE p.hub_id IS DISTINCT FROM a.hub_id;$q$,
    e.child || '.' || e.col || ' cross-hub (vs ' || k.key || ')', e.child,
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN format(' CROSS JOIN LATERAL unnest(c.%I) AS v(x)', e.col) ELSE '' END,
    e.parent, pg_temp.pkey(e.parent),
    CASE WHEN pg_temp.is_arr(e.child, e.col) THEN 'v.x' ELSE format('c.%I', e.col) END,
    ae.parent, pg_temp.pkey(ae.parent), k.key)
  FROM edges e
  CROSS JOIN LATERAL jsonb_object_keys(e.anchor) AS k(key)
  JOIN edges ae ON ae.child = e.child AND ae.col = k.key
  WHERE NOT pg_temp.has_hub(e.child) AND e.parent NOT IN ('hubs', 'users')
    AND pg_temp.has_hub(e.parent) AND pg_temp.has_hub(ae.parent)
) s ORDER BY child, col, ord;

-- case_interactions.source_id: parent table chosen by interaction_type.
SELECT $q$SELECT 'case_interactions.source_id orphan (note/call/message/report_conversion)', count(*) FROM case_interactions c WHERE c.source_id IS NOT NULL AND c.source_id <> '' AND NOT CASE c.interaction_type WHEN 'note' THEN EXISTS (SELECT 1 FROM notes p WHERE p.id = c.source_id) WHEN 'call' THEN EXISTS (SELECT 1 FROM call_records p WHERE p.call_id = c.source_id) WHEN 'message' THEN EXISTS (SELECT 1 FROM conversations p WHERE p.id = c.source_id) OR EXISTS (SELECT 1 FROM messages p WHERE p.id = c.source_id) WHEN 'report_conversion' THEN EXISTS (SELECT 1 FROM conversations p WHERE p.id = c.source_id) ELSE true END;$q$;
SELECT $q$SELECT 'case_interactions.source_id cross-hub (vs case_id)', count(*) FROM case_interactions c JOIN case_records r ON r.id = c.case_id LEFT JOIN notes n ON c.interaction_type = 'note' AND n.id = c.source_id LEFT JOIN call_records k ON c.interaction_type = 'call' AND k.call_id = c.source_id LEFT JOIN conversations v ON c.interaction_type IN ('message', 'report_conversion') AND v.id = c.source_id WHERE coalesce(n.hub_id, k.hub_id, v.hub_id) IS NOT NULL AND coalesce(n.hub_id, k.hub_id, v.hub_id) IS DISTINCT FROM r.hub_id;$q$;
SELECT $q$SELECT 'case_interactions.interaction_type outside protocol enum', count(*) FROM case_interactions c WHERE c.interaction_type NOT IN ('note','call','message','status_change','referral','assessment','file_upload','comment');$q$;
-- files: rows the #2486 contract phase would refuse.
SELECT $q$SELECT 'files hub_id NULL', count(*) FROM files WHERE hub_id IS NULL;$q$;
SELECT $q$SELECT 'files owner_kind NULL', count(*) FROM files WHERE owner_kind IS NULL;$q$;
SELECT $q$SELECT 'files case_record_id orphan', count(*) FROM files c WHERE c.case_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM case_records p WHERE p.id = c.case_record_id);$q$;
