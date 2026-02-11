-- Create "piece_metadata" table
CREATE TABLE "piece_metadata" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "authors" text[] NOT NULL DEFAULT '{}',
  "display_name" text NOT NULL,
  "logo_url" text NOT NULL,
  "description" text NULL,
  "platform_id" text NULL,
  "version" text NOT NULL,
  "minimum_supported_release" text NOT NULL,
  "maximum_supported_release" text NOT NULL,
  "auth" jsonb NULL,
  "actions" jsonb NOT NULL,
  "triggers" jsonb NOT NULL,
  "piece_type" text NOT NULL,
  "categories" text[] NOT NULL DEFAULT '{}',
  "package_type" text NOT NULL,
  "i18n" jsonb NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "idx_piece_metadata_name_platform_id_version" to table: "piece_metadata"
CREATE INDEX "idx_piece_metadata_name_platform_id_version" ON "piece_metadata" ("name", "version", "platform_id");
-- Create "platforms" table
CREATE TABLE "platforms" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "owner_id" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create "users" table
CREATE TABLE "users" (
  "id" text NOT NULL,
  "name" text NULL,
  "email" text NULL,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text NULL,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "platform_id" text NULL,
  "platform_role" text NULL DEFAULT 'MEMBER',
  "status" text NULL DEFAULT 'ACTIVE',
  PRIMARY KEY ("id"),
  CONSTRAINT "users_email_unique" UNIQUE ("email"),
  CONSTRAINT "users_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "platforms" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "api_keys" table
CREATE TABLE "api_keys" (
  "id" text NOT NULL,
  "user_id" text NOT NULL,
  "name" text NULL,
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_used_at" timestamp NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "app_connection" table
CREATE TABLE "app_connection" (
  "id" text NOT NULL,
  "display_name" text NOT NULL,
  "external_id" text NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "platform_id" text NULL,
  "piece_name" text NOT NULL,
  "owner_id" text NULL,
  "project_ids" jsonb NOT NULL DEFAULT '[]',
  "scope" text NOT NULL DEFAULT 'PROJECT',
  "value" jsonb NOT NULL,
  "metadata" jsonb NULL,
  "piece_version" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "app_connection_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
-- Create index "idx_app_connection_owner_id" to table: "app_connection"
CREATE INDEX "idx_app_connection_owner_id" ON "app_connection" ("owner_id");
-- Create index "idx_app_connection_platform_id_and_external_id" to table: "app_connection"
CREATE INDEX "idx_app_connection_platform_id_and_external_id" ON "app_connection" ("platform_id", "external_id");
-- Create "projects" table
CREATE TABLE "projects" (
  "id" text NOT NULL,
  "platform_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "display_name" text NOT NULL,
  "external_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "projects_external_id_unique" UNIQUE ("external_id"),
  CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "projects_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "platforms" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "workflows" table
CREATE TABLE "workflows" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "user_id" text NOT NULL,
  "project_id" text NULL,
  "nodes" jsonb NOT NULL,
  "edges" jsonb NOT NULL,
  "visibility" text NOT NULL DEFAULT 'private',
  "engine_type" text NULL DEFAULT 'dapr',
  "dapr_workflow_name" text NULL,
  "dapr_orchestrator_url" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workflows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "workflow_executions" table
CREATE TABLE "workflow_executions" (
  "id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "user_id" text NOT NULL,
  "status" text NOT NULL,
  "input" jsonb NULL,
  "output" jsonb NULL,
  "error" text NULL,
  "dapr_instance_id" text NULL,
  "phase" text NULL,
  "progress" integer NULL,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp NULL,
  "duration" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "credential_access_logs" table
CREATE TABLE "credential_access_logs" (
  "id" text NOT NULL,
  "execution_id" text NOT NULL,
  "node_id" text NOT NULL,
  "integration_type" text NOT NULL,
  "credential_keys" jsonb NOT NULL,
  "source" text NOT NULL,
  "fallback_attempted" boolean NULL DEFAULT false,
  "fallback_reason" text NULL,
  "accessed_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "credential_access_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "functions" table
CREATE TABLE "functions" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text NULL,
  "plugin_id" text NOT NULL,
  "version" text NOT NULL DEFAULT '1.0.0',
  "execution_type" text NOT NULL DEFAULT 'builtin',
  "image_ref" text NULL,
  "command" text NULL,
  "working_dir" text NULL,
  "container_env" jsonb NULL,
  "webhook_url" text NULL,
  "webhook_method" text NULL DEFAULT 'POST',
  "webhook_headers" jsonb NULL,
  "webhook_timeout_seconds" integer NULL DEFAULT 30,
  "input_schema" jsonb NULL,
  "output_schema" jsonb NULL,
  "timeout_seconds" integer NULL DEFAULT 300,
  "retry_policy" jsonb NULL,
  "max_concurrency" integer NULL DEFAULT 0,
  "integration_type" text NULL,
  "is_builtin" boolean NULL DEFAULT false,
  "is_enabled" boolean NULL DEFAULT true,
  "is_deprecated" boolean NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_by" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "functions_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "functions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "function_executions" table
CREATE TABLE "function_executions" (
  "id" text NOT NULL,
  "function_id" text NULL,
  "workflow_execution_id" text NULL,
  "node_id" text NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "input" jsonb NULL,
  "output" jsonb NULL,
  "error" text NULL,
  "job_name" text NULL,
  "pod_name" text NULL,
  "started_at" timestamp NULL,
  "completed_at" timestamp NULL,
  "duration_ms" integer NULL,
  "attempt_number" integer NULL DEFAULT 1,
  "last_error" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "function_executions_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "functions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "function_executions_workflow_execution_id_workflow_executions_i" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "mcp_server" table
CREATE TABLE "mcp_server" (
  "id" text NOT NULL,
  "project_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'DISABLED',
  "token_encrypted" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_mcp_server_project_id" UNIQUE ("project_id"),
  CONSTRAINT "mcp_server_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_mcp_server_project_id" to table: "mcp_server"
CREATE INDEX "idx_mcp_server_project_id" ON "mcp_server" ("project_id");
-- Create "mcp_run" table
CREATE TABLE "mcp_run" (
  "id" text NOT NULL,
  "project_id" text NOT NULL,
  "mcp_server_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "workflow_execution_id" text NULL,
  "dapr_instance_id" text NULL,
  "tool_name" text NOT NULL,
  "input" jsonb NOT NULL,
  "response" jsonb NULL,
  "status" text NOT NULL,
  "responded_at" timestamp NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "mcp_run_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "mcp_run_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "mcp_run_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "mcp_run_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_mcp_run_mcp_server_id" to table: "mcp_run"
CREATE INDEX "idx_mcp_run_mcp_server_id" ON "mcp_run" ("mcp_server_id");
-- Create index "idx_mcp_run_project_id" to table: "mcp_run"
CREATE INDEX "idx_mcp_run_project_id" ON "mcp_run" ("project_id");
-- Create index "idx_mcp_run_workflow_execution_id" to table: "mcp_run"
CREATE INDEX "idx_mcp_run_workflow_execution_id" ON "mcp_run" ("workflow_execution_id");
-- Create index "idx_mcp_run_workflow_id" to table: "mcp_run"
CREATE INDEX "idx_mcp_run_workflow_id" ON "mcp_run" ("workflow_id");
-- Create "platform_oauth_apps" table
CREATE TABLE "platform_oauth_apps" (
  "id" text NOT NULL,
  "platform_id" text NOT NULL,
  "piece_name" text NOT NULL,
  "client_id" text NOT NULL,
  "client_secret" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_platform_oauth_apps_platform_piece" UNIQUE ("platform_id", "piece_name"),
  CONSTRAINT "platform_oauth_apps_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "platforms" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "project_members" table
CREATE TABLE "project_members" (
  "id" text NOT NULL,
  "project_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'ADMIN',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_project_members_project_user" UNIQUE ("project_id", "user_id"),
  CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "signing_keys" table
CREATE TABLE "signing_keys" (
  "id" text NOT NULL,
  "platform_id" text NOT NULL,
  "public_key" text NOT NULL,
  "algorithm" text NOT NULL DEFAULT 'RS256',
  "display_name" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "signing_keys_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "platforms" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "user_identities" table
CREATE TABLE "user_identities" (
  "id" text NOT NULL,
  "user_id" text NOT NULL,
  "email" text NOT NULL,
  "password" text NULL,
  "provider" text NOT NULL,
  "first_name" text NULL,
  "last_name" text NULL,
  "token_version" integer NOT NULL DEFAULT 0,
  "verified" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "workflow_connection_ref" table
CREATE TABLE "workflow_connection_ref" (
  "id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "node_id" text NOT NULL,
  "connection_external_id" text NOT NULL,
  "piece_name" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_connection_ref_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_workflow_connection_ref_workflow_external_id" to table: "workflow_connection_ref"
CREATE INDEX "idx_workflow_connection_ref_workflow_external_id" ON "workflow_connection_ref" ("workflow_id", "connection_external_id");
-- Create index "idx_workflow_connection_ref_workflow_node" to table: "workflow_connection_ref"
CREATE INDEX "idx_workflow_connection_ref_workflow_node" ON "workflow_connection_ref" ("workflow_id", "node_id");
-- Create "workflow_execution_logs" table
CREATE TABLE "workflow_execution_logs" (
  "id" text NOT NULL,
  "execution_id" text NOT NULL,
  "node_id" text NOT NULL,
  "node_name" text NOT NULL,
  "node_type" text NOT NULL,
  "activity_name" text NULL,
  "status" text NOT NULL,
  "input" jsonb NULL,
  "output" jsonb NULL,
  "error" text NULL,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp NULL,
  "duration" text NULL,
  "timestamp" timestamp NOT NULL DEFAULT now(),
  "credential_fetch_ms" integer NULL,
  "routing_ms" integer NULL,
  "cold_start_ms" integer NULL,
  "execution_ms" integer NULL,
  "routed_to" text NULL,
  "was_cold_start" boolean NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_execution_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "workflow_external_events" table
CREATE TABLE "workflow_external_events" (
  "id" text NOT NULL,
  "execution_id" text NOT NULL,
  "node_id" text NOT NULL,
  "event_name" text NOT NULL,
  "event_type" text NOT NULL,
  "requested_at" timestamp NULL,
  "timeout_seconds" integer NULL,
  "expires_at" timestamp NULL,
  "responded_at" timestamp NULL,
  "approved" boolean NULL,
  "reason" text NULL,
  "responded_by" text NULL,
  "payload" jsonb NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_external_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
