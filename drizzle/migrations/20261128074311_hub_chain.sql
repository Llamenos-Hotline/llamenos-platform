-- hub-id-profile (wire spec §2.1, §6.3): no hubs.id CHECK here. hubs.id is a
-- column the previous release writes, so a CHECK added here could reject its
-- rows during a rollout (docs/runbooks/migrations.md). The crate's canonical
-- form refuses an id outside the profile; the database CHECK is #3136, after
-- this release is deployed.
CREATE TABLE "hub_chain_links" (
	"hub_id" text NOT NULL,
	"seq" integer NOT NULL,
	"prev_hash" text,
	"entry_hash" text NOT NULL,
	"link_json" jsonb NOT NULL,
	"appended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_chain_links_hub_id_seq_pk" PRIMARY KEY("hub_id","seq"),
	CONSTRAINT "hub_chain_links_seq_positive" CHECK ("hub_chain_links"."seq" >= 1),
	CONSTRAINT "hub_chain_links_prev_hash_at_genesis" CHECK (("hub_chain_links"."seq" = 1) = ("hub_chain_links"."prev_hash" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "hub_chain_links" ADD CONSTRAINT "hub_chain_links_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;
