CREATE TABLE IF NOT EXISTS "resource_schemas" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "schema_type" text NOT NULL DEFAULT 'json-schema',
  "schema" jsonb NOT NULL,
  "metadata" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" text REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_resource_schemas_user_project"
  ON "resource_schemas" ("user_id", "project_id");

CREATE INDEX IF NOT EXISTS "idx_resource_schemas_enabled"
  ON "resource_schemas" ("is_enabled");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_resource_schemas_user_project_name"
  ON "resource_schemas" ("user_id", "project_id", "name");

CREATE TABLE IF NOT EXISTS "resource_model_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "model" jsonb NOT NULL,
  "default_options" jsonb,
  "max_turns" integer,
  "timeout_minutes" integer,
  "metadata" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" text REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_resource_model_profiles_user_project"
  ON "resource_model_profiles" ("user_id", "project_id");

CREATE INDEX IF NOT EXISTS "idx_resource_model_profiles_enabled"
  ON "resource_model_profiles" ("is_enabled");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_resource_model_profiles_user_project_name"
  ON "resource_model_profiles" ("user_id", "project_id", "name");

CREATE TABLE IF NOT EXISTS "workflow_resource_refs" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "node_id" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "resource_version" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_workflow_resource_refs_workflow_node"
  ON "workflow_resource_refs" ("workflow_id", "node_id");

CREATE INDEX IF NOT EXISTS "idx_workflow_resource_refs_resource_lookup"
  ON "workflow_resource_refs" ("resource_type", "resource_id");
