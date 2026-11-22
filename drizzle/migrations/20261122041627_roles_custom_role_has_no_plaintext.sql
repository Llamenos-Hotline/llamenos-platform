-- #2787: the database refuses what SettingsService stopped writing in #2780. A custom role
-- (is_default not true) has name NULL, description '' and slug = id; only a seeded default
-- carries plaintext vocabulary. #2780's migration scrubbed existing rows, but the release it
-- replaced kept writing plaintext names during the rollout, so scrub again before the CHECK.
UPDATE "roles" SET "name" = NULL, "description" = '', "slug" = "id" WHERE "is_default" IS NOT TRUE;--> statement-breakpoint
-- migration-safety: constrain column public.roles.is_default because SettingsService has written every custom role with a NULL name, an empty description and slug equal to its id since the release that shipped #2780 (0.21.22), so the release being replaced writes no row this CHECK rejects
ALTER TABLE "roles" ADD CONSTRAINT "roles_custom_role_has_no_plaintext" CHECK ("roles"."is_default" IS TRUE OR ("roles"."name" IS NULL AND "roles"."description" = '' AND "roles"."slug" = "roles"."id"));
