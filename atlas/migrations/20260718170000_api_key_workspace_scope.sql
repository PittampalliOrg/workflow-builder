-- Workspace-bound API keys for Workflow MCP authoring. Existing keys remain
-- project-less with no scopes and retain their legacy owner-scoped webhook
-- behavior until explicitly replaced.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "project_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{}' NOT NULL;

UPDATE "api_keys"
SET "created_by_user_id" = "user_id"
WHERE "created_by_user_id" IS NULL;

-- Keep this nullable during the expand phase so pre-rollout pods can continue
-- inserting legacy keys while the new application version rolls out.

DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "idx_api_keys_project" ON "api_keys" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_api_keys_created_by" ON "api_keys" ("created_by_user_id");
