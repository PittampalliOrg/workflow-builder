-- Drop the deprecated workspace_change_artifacts* tables.
--
-- These tables were created at runtime via `CREATE TABLE IF NOT EXISTS` from
-- the TypeScript durable-agent service (services/durable-agent/src/service/change-artifacts.ts),
-- which is deprecated in favor of dapr-agent-py's git-based checkpoint system
-- (workflow_code_checkpoints + Gitea durable refs). The per-file blob-snapshot
-- approach these tables represented is superseded because git is already
-- content-addressed storage.
--
-- Safe to drop: dapr-agent-py does not read/write these tables; the only
-- writer was services/durable-agent (deleted in this cutover).
--
-- Related Atlas migration: 20260217200000_add_workspace_change_artifact_files.sql
-- covered one of these tables; this Drizzle migration supersedes it.

BEGIN;

DROP TABLE IF EXISTS "workspace_change_artifact_blob_payloads" CASCADE;
DROP TABLE IF EXISTS "workspace_change_artifact_files" CASCADE;
DROP TABLE IF EXISTS "workspace_change_artifacts" CASCADE;

COMMIT;
