-- IVR recordings become per hub (#2239).
--
-- ivr_audio was keyed (prompt_type, language), so one hub's admin could
-- overwrite or delete the greeting every other hub's callers hear. The key is
-- now (hub_id, prompt_type, language); hub_id '' is the PLATFORM DEFAULT and a
-- call in hub H plays H's own recording, else the default, else generated speech.
--
-- Every existing row becomes a platform default (the column default). That is
-- deliberate: before this migration every recording was heard by every hub, and
-- after it every hub still resolves to exactly the same recording until it
-- records its own. Assigning the rows to one hub instead would silently take
-- the greeting away from every other hub -- callers hearing silence -- and
-- nothing records which hub uploaded a row, so no assignment would be honest.
ALTER TABLE "ivr_audio" ADD COLUMN "hub_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ivr_audio" DROP CONSTRAINT "ivr_audio_prompt_type_language_pk";--> statement-breakpoint
ALTER TABLE "ivr_audio" ADD CONSTRAINT "ivr_audio_hub_id_prompt_type_language_pk" PRIMARY KEY("hub_id","prompt_type","language");
