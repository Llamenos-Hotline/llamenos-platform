ALTER TABLE "active_calls" ADD COLUMN "push_ref" text;--> statement-breakpoint
ALTER TABLE "active_calls" ADD CONSTRAINT "active_calls_push_ref_unique" UNIQUE("push_ref");