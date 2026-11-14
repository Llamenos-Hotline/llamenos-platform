ALTER TABLE "roles" ADD COLUMN "hub_id" text;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roles_hub_id_idx" ON "roles" USING btree ("hub_id");--> statement-breakpoint
-- #2780: a custom role's name, description and name-derived slug were stored in
-- the clear. Scrub them rather than delete the rows: the permissions and every
-- assignment stay intact, and only the plaintext vocabulary goes. Pre-production,
-- so there is no sealed copy to restore from; an admin re-names the role.
UPDATE "roles" SET "name" = NULL, "description" = '', "slug" = "id" WHERE "is_default" IS NOT TRUE;--> statement-breakpoint
-- migration-safety: constrain column public.roles.encrypted_name because the previous release never writes hub_id, a column it does not declare, so every row it inserts has hub_id NULL and passes
ALTER TABLE "roles" ADD CONSTRAINT "roles_hub_role_is_sealed" CHECK ("roles"."hub_id" IS NULL OR "roles"."encrypted_name" IS NOT NULL);
