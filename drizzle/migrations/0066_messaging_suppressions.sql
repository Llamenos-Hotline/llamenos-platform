-- Messaging opt-out (suppression) record (#2286).
--
-- A STOP used to be recorded only as a status on an existing subscriber row, so a
-- STOP from someone with no row was discarded and a later import of that number
-- made them reachable again. An opt-out is now a fact about the identifier: one
-- record per person, reached by the keyed hash of each canonical identifier they
-- sent STOP under (HMAC(HKDF(MESSAGING_HASH_KEY, "suppression"), identifier) — no
-- plaintext, reversible or partial identifier is stored). Deployment-wide, because
-- the sender identity every hub messages from is.
--
-- No backfill. SQL cannot derive the hash (the number behind a subscriber row is
-- sealed under SERVER_KEK and the hash key is a file the database never sees), and
-- the app is pre-production. A row unsubscribed before this migration keeps its own
-- status, which a re-import into the same hub does not change; only STOPs that
-- arrive from now on are recorded here.
CREATE TABLE "messaging_suppression_identifiers" (
	"identifier_hash" text PRIMARY KEY NOT NULL,
	"suppression_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"source_hub_id" text,
	"source_external_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"last_blocked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messaging_suppression_identifiers" ADD CONSTRAINT "messaging_suppression_identifiers_suppression_id_messaging_suppressions_id_fk" FOREIGN KEY ("suppression_id") REFERENCES "public"."messaging_suppressions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messaging_suppression_identifiers_suppression_idx" ON "messaging_suppression_identifiers" USING btree ("suppression_id");