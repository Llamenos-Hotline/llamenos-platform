-- #1146: the sigchain can fork because (user_pubkey, seq_no) was only a plain
-- index, not a unique constraint. Nothing at the database layer prevented two
-- concurrent appends from landing at the same seqNo.
--
-- This migration will fail with a unique-constraint violation if any
-- duplicate (user_pubkey, seq_no) rows already exist. That failure is
-- information, not an obstacle: the DO block below runs first and raises a
-- clear, actionable exception naming the affected users and seqNos, instead
-- of letting the CREATE UNIQUE INDEX fail with a generic constraint-violation
-- error that doesn't say which rows are the problem. Operators must resolve
-- (deduplicate/rename) any reported rows before re-running this migration.
DO $$
DECLARE
  dup_count integer;
  dup_summary text;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT user_pubkey, seq_no
    FROM sigchain_links
    GROUP BY user_pubkey, seq_no
    HAVING count(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    SELECT string_agg(format('user_pubkey=%s seq_no=%s (count=%s)', user_pubkey, seq_no, cnt), E'\n')
      INTO dup_summary
    FROM (
      SELECT user_pubkey, seq_no, count(*) AS cnt
      FROM sigchain_links
      GROUP BY user_pubkey, seq_no
      HAVING count(*) > 1
      ORDER BY user_pubkey, seq_no
      LIMIT 50
    ) dupes;

    RAISE EXCEPTION
      E'#1146: % duplicate (user_pubkey, seq_no) pair(s) already exist in sigchain_links — the sigchain for these users has forked. Resolve the duplicates before re-running this migration (first 50 shown):\n%',
      dup_count, dup_summary;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX "sigchain_links_user_seq_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sigchain_links_user_seq_idx" ON "sigchain_links" USING btree ("user_pubkey","seq_no");
