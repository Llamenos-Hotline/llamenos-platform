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
ALTER TABLE "hub_chain_links" ADD CONSTRAINT "hub_chain_links_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- hub-id-profile (wire spec §2.1, §6.3): refuse, naming them, any existing hub
-- ids outside the profile. They are never rewritten: a hub id is in AADs.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id) INTO bad FROM "hubs"
    WHERE NOT (id ~ '^[0-9a-z][0-9a-z-]{0,63}$' OR id ~ '^[0-9a-f]{1,128}$');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'hubs.id outside the identifier profile (wire spec 2.1): %', bad;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "hubs" ADD CONSTRAINT "hubs_id_profile" CHECK ("hubs"."id" ~ '^[0-9a-z][0-9a-z-]{0,63}$' OR "hubs"."id" ~ '^[0-9a-f]{1,128}$');