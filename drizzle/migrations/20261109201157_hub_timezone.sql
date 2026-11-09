-- #1054: a hub carries the IANA time zone its shift schedules are written in.
--
-- Added NOT NULL with DEFAULT 'UTC' in one statement: Postgres fills every
-- existing row with the default as it adds the column (no table rewrite, no NULL
-- window), and the previous release's INSERT INTO hubs, which names no timezone,
-- takes the same default. UTC is also the zone every existing hub's schedule was
-- implicitly evaluated in before this column existed, so adding it moves no
-- hub's roster. An admin sets the real zone afterwards.
ALTER TABLE "hubs" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;
