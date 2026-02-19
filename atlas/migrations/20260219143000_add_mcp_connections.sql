-- Create "mcp_connection" table
CREATE TABLE "mcp_connection" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "source_type" text NOT NULL,
  "piece_name" text,
  "display_name" text NOT NULL,
  "registry_ref" text,
  "server_url" text,
  "status" text NOT NULL DEFAULT 'DISABLED',
  "last_sync_at" timestamp,
  "last_error" text,
  "metadata" jsonb,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_connection_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "mcp_connection_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "mcp_connection_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "uq_mcp_connection_project_source_piece" UNIQUE ("project_id", "source_type", "piece_name")
);
-- Create index "idx_mcp_connection_project_id" to table: "mcp_connection"
CREATE INDEX "idx_mcp_connection_project_id" ON "mcp_connection" ("project_id");
-- Create index "idx_mcp_connection_project_status" to table: "mcp_connection"
CREATE INDEX "idx_mcp_connection_project_status" ON "mcp_connection" ("project_id", "status");

