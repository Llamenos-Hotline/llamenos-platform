-- #1175: audit_log.seq — per-chain append order, so created_at stops carrying it.
--
-- Until now append order was recoverable only from (created_at, id), and
-- AuditService.log kept that order total by stamping each entry 1 ms past the
-- tip whenever clocks tied or disagreed — a knowingly false timestamp that was
-- then hashed into the entry. seq takes over: AuditService.log assigns it as
-- the locked tip's seq + 1 under the per-chain pg_advisory_xact_lock, so the
-- number is the lock's output rather than a second source of truth.
--
-- The column is NOT NULL, which the expand/contract gate only admits with a
-- default the previous release's INSERT can take: its AuditService.log does
-- not name seq. The audit_log_seq_default_seq sequence provides that default.
-- Its values start at 2^32 — far above any per-chain counter — so a row
-- written by the previous release during a rolling upgrade never collides
-- with a per-chain value, and sorts after every real append (it was, in fact,
-- appended later).
--
-- The other direction needs the new code's help, and has it: once a chain's
-- tip is in this sequence's space (>= 2^32), AuditService.log draws its seq
-- from the same sequence instead of using tip + 1 (#2634). tip + 1 would be
-- a value the sequence has yet to issue, and the previous release's next
-- INSERT would take it and abort on the (hub_id, seq) unique index. Both
-- writers drawing from one sequence cannot issue a value twice, and appends
-- to one chain are serialised by the per-chain advisory lock, so within a
-- chain each draw lands past the tip.
-- IF NOT EXISTS: the ledger runner replays this file when reconciling a
-- pre-ledger database whose schema already has the sequence.
CREATE SEQUENCE IF NOT EXISTS "audit_log_seq_default_seq" START WITH 4294967296;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "seq" bigint;
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "seq" SET DEFAULT nextval('audit_log_seq_default_seq');
--> statement-breakpoint
-- Backfill existing rows in the order the old code defined as append order —
-- (created_at, id) per chain — so chain reads ordered by seq return exactly
-- what they returned ordered by (created_at, id). hub_id IS NULL is the
-- platform chain; COALESCE keeps it one partition, as chainCondition() treats
-- it in app code.
UPDATE "audit_log" AS "a" SET "seq" = "s"."rn" FROM (
  SELECT "id",
         row_number() OVER (
           PARTITION BY COALESCE("hub_id", '')
           ORDER BY "created_at", "id"
         ) AS "rn"
  FROM "audit_log"
) AS "s" WHERE "a"."id" = "s"."id";
--> statement-breakpoint
-- migration-safety: constrain column public.audit_log.seq because the previous release's only INSERT (AuditService.log) does not name seq, so it takes this column's DEFAULT nextval('audit_log_seq_default_seq') and can never write NULL
ALTER TABLE "audit_log" ALTER COLUMN "seq" SET NOT NULL;
--> statement-breakpoint
-- migration-safety: constrain column public.audit_log.hub_id because the previous release's INSERT names hub_id but not seq, so seq takes the sequence default, and this release's AuditService.log draws from that same sequence whenever the chain tip is in its space, so the two never issue the same (hub_id, seq)
CREATE UNIQUE INDEX "audit_log_hub_id_seq_idx" ON "audit_log" ("hub_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_platform_seq_idx" ON "audit_log" ("seq") WHERE "hub_id" IS NULL;

