ALTER TABLE "integrations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "integrations" CASCADE;--> statement-breakpoint
ALTER TABLE "app_connection" ALTER COLUMN "value" SET DATA TYPE jsonb USING value::jsonb;