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
	"value" text NOT NULL,
	"metadata" jsonb,
	"piece_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "workflow_connection_ref" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"connection_external_id" text NOT NULL,
	"piece_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "credential_fetch_ms" integer;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "routing_ms" integer;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "cold_start_ms" integer;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "execution_ms" integer;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "routed_to" text;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "was_cold_start" boolean;--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_logs" ADD CONSTRAINT "credential_access_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_connection_ref" ADD CONSTRAINT "workflow_connection_ref_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_external_events" ADD CONSTRAINT "workflow_external_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_connection_platform_id_and_external_id" ON "app_connection" USING btree ("platform_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_app_connection_owner_id" ON "app_connection" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_piece_metadata_name_platform_id_version" ON "piece_metadata" USING btree ("name","version","platform_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_connection_ref_workflow_node" ON "workflow_connection_ref" USING btree ("workflow_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_connection_ref_workflow_external_id" ON "workflow_connection_ref" USING btree ("workflow_id","connection_external_id");