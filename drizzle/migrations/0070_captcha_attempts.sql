ALTER TABLE "captchas" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "captchas" ADD COLUMN "repeats" integer DEFAULT 0 NOT NULL;