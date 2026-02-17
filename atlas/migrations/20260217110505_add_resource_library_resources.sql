-- Extend "agents" table for preset references
ALTER TABLE "agents" ADD COLUMN "instructions_preset_id" text NULL;
ALTER TABLE "agents" ADD COLUMN "instructions_preset_version" integer NULL;
ALTER TABLE "agents" ADD COLUMN "schema_preset_id" text NULL;
ALTER TABLE "agents" ADD COLUMN "schema_preset_version" integer NULL;
ALTER TABLE "agents" ADD COLUMN "model_profile_id" text NULL;
ALTER TABLE "agents" ADD COLUMN "model_profile_version" integer NULL;
-- Create "resource_model_profiles" table
CREATE TABLE "resource_model_profiles" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "model" jsonb NOT NULL,
  "default_options" jsonb NULL,
  "max_turns" integer NULL,
  "timeout_minutes" integer NULL,
  "metadata" jsonb NULL,
  "version" integer NOT NULL DEFAULT 1,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "user_id" text NOT NULL,
  "project_id" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_resource_model_profiles_user_project_name" UNIQUE ("user_id", "project_id", "name"),
  CONSTRAINT "resource_model_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "resource_model_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_resource_model_profiles_enabled" to table: "resource_model_profiles"
CREATE INDEX "idx_resource_model_profiles_enabled" ON "resource_model_profiles" ("is_enabled");
-- Create index "idx_resource_model_profiles_user_project" to table: "resource_model_profiles"
CREATE INDEX "idx_resource_model_profiles_user_project" ON "resource_model_profiles" ("user_id", "project_id");
-- Create "resource_prompts" table
CREATE TABLE "resource_prompts" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "system_prompt" text NOT NULL,
  "user_prompt" text NULL,
  "prompt_mode" text NOT NULL DEFAULT 'system',
  "metadata" jsonb NULL,
  "version" integer NOT NULL DEFAULT 1,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "user_id" text NOT NULL,
  "project_id" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_resource_prompts_user_project_name" UNIQUE ("user_id", "project_id", "name"),
  CONSTRAINT "resource_prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "resource_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_resource_prompts_enabled" to table: "resource_prompts"
CREATE INDEX "idx_resource_prompts_enabled" ON "resource_prompts" ("is_enabled");
-- Create index "idx_resource_prompts_user_project" to table: "resource_prompts"
CREATE INDEX "idx_resource_prompts_user_project" ON "resource_prompts" ("user_id", "project_id");
-- Create "resource_schemas" table
CREATE TABLE "resource_schemas" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "schema_type" text NOT NULL DEFAULT 'json-schema',
  "schema" jsonb NOT NULL,
  "metadata" jsonb NULL,
  "version" integer NOT NULL DEFAULT 1,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "user_id" text NOT NULL,
  "project_id" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_resource_schemas_user_project_name" UNIQUE ("user_id", "project_id", "name"),
  CONSTRAINT "resource_schemas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "resource_schemas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_resource_schemas_enabled" to table: "resource_schemas"
CREATE INDEX "idx_resource_schemas_enabled" ON "resource_schemas" ("is_enabled");
-- Create index "idx_resource_schemas_user_project" to table: "resource_schemas"
CREATE INDEX "idx_resource_schemas_user_project" ON "resource_schemas" ("user_id", "project_id");
-- Create "workflow_resource_refs" table
CREATE TABLE "workflow_resource_refs" (
  "id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "node_id" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "resource_version" integer NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_resource_refs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_workflow_resource_refs_resource_lookup" to table: "workflow_resource_refs"
CREATE INDEX "idx_workflow_resource_refs_resource_lookup" ON "workflow_resource_refs" ("resource_type", "resource_id");
-- Create index "idx_workflow_resource_refs_workflow_node" to table: "workflow_resource_refs"
CREATE INDEX "idx_workflow_resource_refs_workflow_node" ON "workflow_resource_refs" ("workflow_id", "node_id");
