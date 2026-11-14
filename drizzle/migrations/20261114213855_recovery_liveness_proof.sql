CREATE TABLE "recovery_liveness_challenges" (
	"hub_id" text NOT NULL,
	"holder_pubkey" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_liveness_challenges_hub_id_holder_pubkey_pk" PRIMARY KEY("hub_id","holder_pubkey")
);
--> statement-breakpoint
ALTER TABLE "hub_recovery_group_shares" ADD COLUMN "liveness_public_key" text;--> statement-breakpoint
ALTER TABLE "hub_recovery_group_shares" ADD COLUMN "last_liveness_failure" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_liveness_challenges" ADD CONSTRAINT "recovery_liveness_challenges_share_fk" FOREIGN KEY ("hub_id","holder_pubkey") REFERENCES "public"."hub_recovery_group_shares"("hub_id","holder_pubkey") ON DELETE cascade ON UPDATE no action;