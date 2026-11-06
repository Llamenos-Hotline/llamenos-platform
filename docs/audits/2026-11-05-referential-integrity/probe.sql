-- #2510 referential-integrity probe.
--
-- Run against a FRESHLY MIGRATED scratch database (never a shared one):
--   createdb audit2510 && DATABASE_URL=postgres://.../audit2510 bun run db:migrate
--   psql "$URL" -f docs/audits/2026-11-05-referential-integrity/probe.sql
--
-- Everything runs inside one transaction that is ROLLED BACK at the end, and
-- every attempted INSERT runs in its own sub-transaction that is rolled back
-- whether it succeeds or not. The database is unchanged afterwards.
--
-- Verdicts:
--   ACCEPTED  the database stored the violating row: the violation is REPRESENTABLE
--   REJECTED  the database refused it; the detail names the constraint that did
--
-- Seeds: two hubs, 'hub-A' and 'hub-B', and one parent row of each hub-owned
-- kind in each hub, named '<prefix>-A' / '<prefix>-B'. A "cross-hub" probe writes
-- a child claiming hub-A (directly, or through its other parent) that references
-- the hub-B parent. An "orphan" probe references an id that exists nowhere.

\set ON_ERROR_STOP 1
\pset pager off
BEGIN;

CREATE TEMP TABLE results (seq serial, probe text, verdict text, detail text);
CREATE TEMP TABLE seeds (tbl text, hub text, id text);

-- INSERT a row into tbl. Columns named in vals get that value (a JSON null is
-- SQL NULL; anything else is cast from its text form, so arrays are passed as
-- Postgres array literals like '{a,b}'). Every other NOT NULL column without a
-- default is filled: with a real parent row when it carries a single-column FK
-- (same hub as vals.hub_id where the parent has one), else a typed dummy.
CREATE FUNCTION pg_temp.ins(tbl text, vals jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  r record; cols text[] := '{}'; exprs text[] := '{}'; e text; fk record; parent_has_hub boolean;
BEGIN
  FOR r IN
    SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS nn, a.atthasdef AS hasdef
    FROM pg_attribute a WHERE a.attrelid = tbl::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
  LOOP
    e := NULL;
    IF vals ? r.attname THEN
      e := CASE WHEN jsonb_typeof(vals -> r.attname) = 'null' THEN 'NULL'
                ELSE format('%L::%s', vals ->> r.attname, r.typ) END;
    ELSIF r.nn AND NOT r.hasdef THEN
      SELECT c.confrelid::regclass::text AS ptbl, pa.attname AS pcol INTO fk
        FROM pg_constraint c JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
       WHERE c.conrelid = tbl::regclass AND c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.conkey[1] = r.attnum
       LIMIT 1;
      IF FOUND THEN
        SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = fk.ptbl::regclass AND attname = 'hub_id') INTO parent_has_hub;
        IF parent_has_hub AND vals ? 'hub_id' AND fk.ptbl <> 'hubs' THEN
          e := format('(SELECT %I FROM %s ORDER BY (hub_id = %L) DESC NULLS LAST, 1 LIMIT 1)', fk.pcol, fk.ptbl, vals ->> 'hub_id');
        ELSE
          e := format('(SELECT %I FROM %s ORDER BY 1 LIMIT 1)', fk.pcol, fk.ptbl);
        END IF;
      ELSE
        e := CASE
          WHEN r.typ = 'text' THEN quote_literal('probe-' || substr(md5(random()::text), 1, 10))
          WHEN r.typ = 'jsonb' THEN '''{}''::jsonb'
          WHEN r.typ LIKE '%[]' THEN format('''{}''::%s', r.typ)
          WHEN r.typ = 'integer' THEN '0'
          WHEN r.typ = 'boolean' THEN 'false'
          WHEN r.typ LIKE 'timestamp%' THEN 'now()'
          ELSE 'NULL' END;
      END IF;
    END IF;
    IF e IS NOT NULL THEN cols := cols || quote_ident(r.attname); exprs := exprs || e; END IF;
  END LOOP;
  EXECUTE format('INSERT INTO %s (%s) VALUES (%s)', tbl, array_to_string(cols, ', '), array_to_string(exprs, ', '));
END $f$;

-- Attempt one violating INSERT and roll it back either way.
CREATE FUNCTION pg_temp.probe(label text, tbl text, vals jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v text; d text;
BEGIN
  BEGIN
    PERFORM pg_temp.ins(tbl, vals);
    RAISE EXCEPTION '__probe_accepted__';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = '__probe_accepted__' THEN v := 'ACCEPTED'; d := vals::text;
    ELSE v := 'REJECTED'; d := SQLSTATE || ' ' || SQLERRM; END IF;
  END;
  INSERT INTO results (probe, verdict, detail) VALUES (label, v, d);
END $f$;

CREATE FUNCTION pg_temp.seed(tbl text, hub text, id_col text, id text, vals jsonb) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.ins(tbl, vals || jsonb_build_object(id_col, id) || CASE WHEN hub IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('hub_id', hub) END);
  INSERT INTO seeds VALUES (tbl, hub, id);
END $f$;

-- ---------------------------------------------------------------- seeds
SELECT pg_temp.seed('users', NULL, 'pubkey', 'pk-u1', '{}');
SELECT pg_temp.seed('roles', NULL, 'id', 'role-1', '{}');
SELECT pg_temp.seed('devices', NULL, 'id', 'dev-1', '{"pubkey":"pk-u1"}');
SELECT pg_temp.seed('entity_type_templates', NULL, 'id', 'tpl-1', '{}');
SELECT pg_temp.seed('messaging_suppressions', NULL, 'id', 'ms-1', '{}');
DO $$
DECLARE h text;
BEGIN
  FOREACH h IN ARRAY ARRAY['A', 'B'] LOOP
    PERFORM pg_temp.seed('hubs', NULL, 'id', 'hub-' || h, '{}');
    PERFORM pg_temp.seed('case_records', 'hub-' || h, 'id', 'rec-' || h, '{}');
    PERFORM pg_temp.seed('events', 'hub-' || h, 'id', 'ev-' || h, '{}');
    PERFORM pg_temp.seed('contacts', 'hub-' || h, 'id', 'ct-' || h, '{}');
    PERFORM pg_temp.seed('conversations', 'hub-' || h, 'id', 'cv-' || h, '{}');
    PERFORM pg_temp.seed('notes', 'hub-' || h, 'id', 'note-' || h, '{}');
    PERFORM pg_temp.seed('messages', NULL, 'id', 'msg-' || h, jsonb_build_object('conversation_id', 'cv-' || h));
    PERFORM pg_temp.seed('files', 'hub-' || h, 'id', 'file-' || h, jsonb_build_object('owner_kind', 'conversation', 'conversation_id', 'cv-' || h));
    PERFORM pg_temp.seed('evidence', NULL, 'id', 'evd-' || h, jsonb_build_object('case_id', 'rec-' || h, 'file_id', 'file-' || h));
    PERFORM pg_temp.seed('ring_groups', 'hub-' || h, 'id', 'rg-' || h, '{}');
    PERFORM pg_temp.seed('shifts', 'hub-' || h, 'id', 'sh-' || h, jsonb_build_object('ring_group_id', 'rg-' || h));
    PERFORM pg_temp.seed('teams', 'hub-' || h, 'id', 'tm-' || h, '{}');
    PERFORM pg_temp.seed('tags', 'hub-' || h, 'id', 'tag-' || h, '{}');
    PERFORM pg_temp.seed('blasts', 'hub-' || h, 'id', 'bl-' || h, '{}');
    PERFORM pg_temp.seed('subscribers', 'hub-' || h, 'id', 'sub-' || h, '{}');
    PERFORM pg_temp.seed('affinity_groups', 'hub-' || h, 'id', 'ag-' || h, '{}');
    PERFORM pg_temp.seed('call_records', 'hub-' || h, 'call_id', 'call-' || h, '{}');
    PERFORM pg_temp.seed('active_calls', 'hub-' || h, 'call_id', 'acall-' || h, '{}');
    PERFORM pg_temp.seed('entity_type_definitions', 'hub-' || h, 'id', 'etd-' || h, '{}');
    PERFORM pg_temp.seed('report_type_definitions', 'hub-' || h, 'id', 'rtd-' || h, '{}');
    PERFORM pg_temp.seed('relationship_type_definitions', 'hub-' || h, 'id', 'reltd-' || h, '{}');
    PERFORM pg_temp.seed('firehose_connections', 'hub-' || h, 'id', 'fc-' || h, jsonb_build_object('report_type_id', 'rtd-' || h));
    PERFORM pg_temp.seed('firehose_window_keys', NULL, 'id', 'fwk-' || h, jsonb_build_object('connection_id', 'fc-' || h));
    PERFORM pg_temp.seed('recovery_sessions', 'hub-' || h, 'session_id', 'rs-' || h, '{}');
    PERFORM pg_temp.seed('hub_recovery_groups', NULL, 'hub_id', 'hub-' || h, '{"threshold":2,"total_shares":3,"delay_hours":24,"emergency_floor_hours":1}');
  END LOOP;
END $$;

\ir edges.sql

-- ---------------------------------------------------------------- generic probes
DO $$
DECLARE
  e record; child_hub boolean; parent_hub boolean; is_arr boolean; base jsonb; xid text; ex record;
BEGIN
  FOR e IN SELECT * FROM edges ORDER BY child, col LOOP
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = e.child::regclass AND attname = 'hub_id') INTO child_hub;
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = e.parent::regclass AND attname = 'hub_id') INTO parent_hub;
    SELECT format_type(atttypid, atttypmod) LIKE '%[]' INTO is_arr FROM pg_attribute WHERE attrelid = e.child::regclass AND attname = e.col;
    base := e.anchor;
    IF child_hub AND e.col <> 'hub_id' THEN base := base || '{"hub_id":"hub-A"}'; END IF;
    -- erasure_requests: its scope CHECK ties user_id/hub_id to scope.
    IF e.child = 'erasure_requests' THEN
      base := base || CASE WHEN e.col = 'hub_id' THEN '{"scope":"hub"}'::jsonb ELSE '{"scope":"user","user_id":"pk-u1","hub_id":null}'::jsonb END;
    END IF;
    IF e.child = 'hub_recovery_groups' THEN
      base := base || '{"threshold":2,"total_shares":3,"delay_hours":24,"emergency_floor_hours":1}';
    END IF;
    -- files: say which parent owns it.
    IF e.child = 'files' AND NOT base ? 'owner_kind' THEN base := base || '{"owner_kind":"entity_field"}'; END IF;

    PERFORM pg_temp.probe(e.child || '.' || e.col || ' orphan', e.child,
      base || jsonb_build_object(e.col, CASE WHEN is_arr THEN '{no-such-id}' ELSE 'no-such-id' END));

    IF parent_hub AND e.parent <> 'hubs' AND e.col <> 'hub_id' AND (child_hub OR e.anchor <> '{}'::jsonb) THEN
      SELECT id INTO xid FROM seeds WHERE tbl = e.parent AND hub = 'hub-B';
      PERFORM pg_temp.probe(e.child || '.' || e.col || ' cross-hub', e.child,
        base || jsonb_build_object(e.col, CASE WHEN is_arr THEN '{' || xid || '}' ELSE xid END));
    END IF;

    IF e.parent = 'hubs' AND e.col = 'hub_id' THEN
      PERFORM pg_temp.probe(e.child || '.hub_id empty-string hub', e.child, base || '{"hub_id":""}');
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- case_interactions.source_id (polymorphic)
-- A record in hub-A linking a note / call / report that lives in hub-B, or
-- that exists nowhere. interaction_type is free text, so it is also probed.
SELECT pg_temp.probe('case_interactions.source_id note: orphan', 'case_interactions',
  '{"case_id":"rec-A","interaction_type":"note","source_id":"no-such-id"}');
SELECT pg_temp.probe('case_interactions.source_id note: hub-B note on hub-A record', 'case_interactions',
  '{"case_id":"rec-A","interaction_type":"note","source_id":"note-B"}');
SELECT pg_temp.probe('case_interactions.source_id call: hub-B call on hub-A record', 'case_interactions',
  '{"case_id":"rec-A","interaction_type":"call","source_id":"call-B"}');
SELECT pg_temp.probe('case_interactions.source_id report_conversion: hub-B report on hub-A record', 'case_interactions',
  '{"case_id":"rec-A","interaction_type":"report_conversion","source_id":"cv-B"}');
SELECT pg_temp.probe('case_interactions.source_id note type naming a call id (type confusion)', 'case_interactions',
  '{"case_id":"rec-A","interaction_type":"note","source_id":"call-A"}');
SELECT pg_temp.probe('case_interactions.interaction_type outside the protocol enum', 'case_interactions',
  '{"case_id":"rec-A","interaction_type":"no-such-type"}');

-- ---------------------------------------------------------------- files: the #2484 shape, at its edges
SELECT pg_temp.probe('files conversation-owned, hub-B conversation, hub-A', 'files',
  '{"hub_id":"hub-A","owner_kind":"conversation","conversation_id":"cv-B"}');
SELECT pg_temp.probe('files case-owned, hub-B record, hub-A', 'files',
  '{"hub_id":"hub-A","owner_kind":"case_record","case_record_id":"rec-B"}');
SELECT pg_temp.probe('files case-owned, orphan record, hub NULL', 'files',
  '{"hub_id":null,"owner_kind":"case_record","case_record_id":"no-such-id"}');
SELECT pg_temp.probe('files case-owned, hub-B record, hub NULL', 'files',
  '{"hub_id":null,"owner_kind":"case_record","case_record_id":"rec-B"}');
SELECT pg_temp.probe('files no owner, no parent, no hub', 'files',
  '{"hub_id":null,"owner_kind":null,"conversation_id":null,"case_record_id":null}');
SELECT pg_temp.probe('files owner_kind NULL, orphan case_record_id, hub NULL', 'files',
  '{"hub_id":null,"owner_kind":null,"case_record_id":"no-such-id"}');
SELECT pg_temp.probe('files entity_field owned, hub-A (names no parent at all)', 'files',
  '{"hub_id":"hub-A","owner_kind":"entity_field"}');

-- ---------------------------------------------------------------- report
\echo '==== probe results'
SELECT seq, probe, verdict, left(detail, 150) AS detail FROM results ORDER BY seq;
\echo '==== summary'
SELECT verdict, count(*) FROM results GROUP BY 1 ORDER BY 1;

ROLLBACK;
