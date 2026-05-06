CREATE TABLE IF NOT EXISTS "mcp_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source_type" text NOT NULL,
	"piece_name" text,
	"display_name" text NOT NULL,
	"registry_ref" text,
	"server_url" text,
	"status" text DEFAULT 'DISABLED' NOT NULL,
	"last_sync_at" timestamp,
	"last_error" text,
	"metadata" jsonb,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "mcp_connection_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "mcp_connection_updated_by_users_id_fk"
		FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_connection_project_id"
ON "mcp_connection" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_connection_project_status"
ON "mcp_connection" ("project_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mcp_connection_project_source_piece"
ON "mcp_connection" ("project_id","source_type","piece_name");
--> statement-breakpoint
ALTER TABLE "mcp_connection" ADD COLUMN "server_key" text;--> statement-breakpoint
ALTER TABLE "mcp_connection" ADD CONSTRAINT "uq_mcp_connection_project_source_server_key" UNIQUE("project_id","source_type","server_key");
