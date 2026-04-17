-- Phase 2 of the CMA-mirror refactor: vaults + vault_credentials. Vaults group
-- encrypted credentials that agents/sessions attach by id; function-router
-- injects them at tool-call time so the sandbox never sees the secret. MCP
-- credentials migrate here from `mcp_connection` (dropped below) and from
-- MCP-bound rows in `app_connections` (left intact for AP pieces; MCP rows
-- are migrated out by the Phase 2 backfill script).

CREATE TABLE "vaults" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "project_id" text NULL,
  "created_by" text NULL,
  "is_archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_vaults_project_name" UNIQUE ("project_id", "name"),
  CONSTRAINT "vaults_project_id_projects_id_fk" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "vaults_created_by_users_id_fk" FOREIGN KEY ("created_by")
    REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX "idx_vaults_project" ON "vaults" ("project_id");
CREATE INDEX "idx_vaults_archived" ON "vaults" ("is_archived");

CREATE TABLE "vault_credentials" (
  "id" text NOT NULL,
  "vault_id" text NOT NULL,
  "display_name" text NOT NULL,
  "auth_type" text NOT NULL,
  "value" jsonb NOT NULL,
  "mcp_server_url" text NULL,
  "refresh_metadata" jsonb NULL,
  "expires_at" timestamp NULL,
  "last_refreshed_at" timestamp NULL,
  "last_used_at" timestamp NULL,
  "is_archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "vault_credentials_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id")
    REFERENCES "vaults" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX "idx_vault_credentials_vault" ON "vault_credentials" ("vault_id");
CREATE INDEX "idx_vault_credentials_mcp_url" ON "vault_credentials" ("mcp_server_url");
CREATE INDEX "idx_vault_credentials_expires" ON "vault_credentials" ("expires_at");

CREATE TABLE "vault_credential_refresh_log" (
  "id" text NOT NULL,
  "credential_id" text NOT NULL,
  "status" text NOT NULL,
  "error_message" text NULL,
  "response_status" integer NULL,
  "attempted_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "vault_credential_refresh_log_credential_id_vault_credentials_id_fk"
    FOREIGN KEY ("credential_id") REFERENCES "vault_credentials" ("id")
    ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX "idx_vault_refresh_log_credential" ON "vault_credential_refresh_log" ("credential_id");
CREATE INDEX "idx_vault_refresh_log_attempted" ON "vault_credential_refresh_log" ("attempted_at");
