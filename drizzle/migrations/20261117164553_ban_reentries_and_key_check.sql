-- #2829: the ban digest is a keyed OPRF the server can neither recompute nor carry across
-- a scheme or key change, so bans that stop enforcing are MOVED to `ban_reentries` (the
-- admin's ban list shows them) instead of left in `bans` looking enforced. `ban_key_check`
-- remembers which BAN_HASH_KEY the stored digests belong to, so a replaced key is caught at
-- boot. The move itself runs at server start (RecordsService.reconcileBanKey), where the
-- key is, not here.
CREATE TABLE "ban_key_check" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ban_reentries" (
	"id" text PRIMARY KEY NOT NULL,
	"hub_id" text,
	"reason" text,
	"banned_by" text,
	"banned_at" timestamp with time zone NOT NULL,
	"cause" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ban_reentries_hub_id_idx" ON "ban_reentries" USING btree ("hub_id");