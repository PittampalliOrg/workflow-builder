CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);

CREATE TABLE "app_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"platform_id" text,
	"piece_name" text NOT NULL,
	"owner_id" text,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" text DEFAULT 'PROJECT' NOT NULL,
	"value" jsonb NOT NULL,
	"metadata" jsonb,
	"piece_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "credential_access_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"integration_type" text NOT NULL,
	"credential_keys" jsonb NOT NULL,
	"source" text NOT NULL,
	"fallback_attempted" boolean DEFAULT false,
	"fallback_reason" text,
	"accessed_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "function_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"function_id" text,
	"workflow_execution_id" text,
	"node_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"job_name" text,
	"pod_name" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"attempt_number" integer DEFAULT 1,
	"last_error" text
);

CREATE TABLE "functions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"plugin_id" text NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"execution_type" text DEFAULT 'builtin' NOT NULL,
	"image_ref" text,
	"command" text,
	"working_dir" text,
	"container_env" jsonb,
	"webhook_url" text,
	"webhook_method" text DEFAULT 'POST',
	"webhook_headers" jsonb,
	"webhook_timeout_seconds" integer DEFAULT 30,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"timeout_seconds" integer DEFAULT 300,
	"retry_policy" jsonb,
	"max_concurrency" integer DEFAULT 0,
	"integration_type" text,
	"is_builtin" boolean DEFAULT false,
	"is_enabled" boolean DEFAULT true,
	"is_deprecated" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "functions_slug_unique" UNIQUE("slug")
);

CREATE TABLE "piece_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"authors" text[] DEFAULT '{}' NOT NULL,
	"display_name" text NOT NULL,
	"logo_url" text NOT NULL,
	"description" text,
	"platform_id" text,
	"version" text NOT NULL,
	"minimum_supported_release" text NOT NULL,
	"maximum_supported_release" text NOT NULL,
	"auth" jsonb,
	"actions" jsonb NOT NULL,
	"triggers" jsonb NOT NULL,
	"piece_type" text NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"package_type" text NOT NULL,
	"i18n" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "platform_oauth_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"platform_id" text NOT NULL,
	"piece_name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_platform_oauth_apps_platform_piece" UNIQUE("platform_id","piece_name")
);

CREATE TABLE "platforms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'ADMIN' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_members_project_user" UNIQUE("project_id","user_id")
);

CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"platform_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_external_id_unique" UNIQUE("external_id")
);

CREATE TABLE "signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"platform_id" text NOT NULL,
	"public_key" text NOT NULL,
	"algorithm" text DEFAULT 'RS256' NOT NULL,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"password" text,
	"provider" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"token_version" integer DEFAULT 0 NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"platform_id" text,
	"platform_role" text DEFAULT 'MEMBER',
	"status" text DEFAULT 'ACTIVE',
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE "workflow_connection_ref" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"connection_external_id" text NOT NULL,
	"piece_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "workflow_execution_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_name" text NOT NULL,
	"node_type" text NOT NULL,
	"activity_name" text,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"credential_fetch_ms" integer,
	"routing_ms" integer,
	"cold_start_ms" integer,
	"execution_ms" integer,
	"routed_to" text,
	"was_cold_start" boolean
);

CREATE TABLE "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"dapr_instance_id" text,
	"phase" text,
	"progress" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration" text
);

CREATE TABLE "workflow_external_events" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"event_name" text NOT NULL,
	"event_type" text NOT NULL,
	"requested_at" timestamp,
	"timeout_seconds" integer,
	"expires_at" timestamp,
	"responded_at" timestamp,
	"approved" boolean,
	"reason" text,
	"responded_by" text,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"user_id" text NOT NULL,
	"nodes" jsonb NOT NULL,
	"edges" jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"engine_type" text DEFAULT 'dapr',
	"dapr_workflow_name" text,
	"dapr_orchestrator_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "credential_access_logs" ADD CONSTRAINT "credential_access_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "function_executions" ADD CONSTRAINT "function_executions_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "function_executions" ADD CONSTRAINT "function_executions_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "functions" ADD CONSTRAINT "functions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "platform_oauth_apps" ADD CONSTRAINT "platform_oauth_apps_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "signing_keys" ADD CONSTRAINT "signing_keys_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "users" ADD CONSTRAINT "users_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_connection_ref" ADD CONSTRAINT "workflow_connection_ref_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workflow_execution_logs" ADD CONSTRAINT "workflow_execution_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflow_external_events" ADD CONSTRAINT "workflow_external_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "idx_app_connection_platform_id_and_external_id" ON "app_connection" USING btree ("platform_id","external_id");
CREATE INDEX "idx_app_connection_owner_id" ON "app_connection" USING btree ("owner_id");
CREATE INDEX "idx_piece_metadata_name_platform_id_version" ON "piece_metadata" USING btree ("name","version","platform_id");
CREATE INDEX "idx_workflow_connection_ref_workflow_node" ON "workflow_connection_ref" USING btree ("workflow_id","node_id");
CREATE INDEX "idx_workflow_connection_ref_workflow_external_id" ON "workflow_connection_ref" USING btree ("workflow_id","connection_external_id");
