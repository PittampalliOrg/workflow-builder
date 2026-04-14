ALTER TABLE "mcp_connection"
ADD COLUMN "connection_external_id" text;

CREATE INDEX IF NOT EXISTS "idx_mcp_connection_connection_external_id"
ON "mcp_connection" ("connection_external_id");
