-- Generic per-execution artifacts surface for the run-detail UI.
--
-- Any workflow node can persist a typed, named output that renders
-- coherently in the UI without inventing a new table + tab per shape.
-- See src/lib/server/db/schema.ts:workflowArtifacts for the full doc.
--
-- Producer paths:
--   - SW 1.0 spec `artifacts:` block on any task — orchestrator persists each
--     entry via the persist_workflow_artifact activity (Dapr-durable;
--     deterministic id makes the activity idempotent under retry).
--   - POST /api/internal/workflows/executions/[id]/artifacts (internal-token).
--
-- Existing browser/plan artifact tables are unchanged — they have working
-- type-specific renderers; this is the long tail.

CREATE TABLE IF NOT EXISTS "workflow_artifacts" (
    "id"                       text                    PRIMARY KEY,
    "workflow_execution_id"    text        NOT NULL    REFERENCES "workflow_executions" ("id") ON DELETE CASCADE,
    "node_id"                  text        NULL,
    "slot"                     text        NULL,
    "kind"                     text        NOT NULL,
    "title"                    text        NOT NULL,
    "description"              text        NULL,
    "inline_payload"           jsonb       NULL,
    "file_id"                  text        NULL        REFERENCES "files" ("id") ON DELETE SET NULL,
    "content_type"             text        NULL,
    "size_bytes"               integer     NULL,
    "metadata"                 jsonb       NULL,
    "created_at"               timestamp   NOT NULL    DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_workflow_artifacts_execution_created"
    ON "workflow_artifacts" ("workflow_execution_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_workflow_artifacts_execution_kind"
    ON "workflow_artifacts" ("workflow_execution_id", "kind");

CREATE INDEX IF NOT EXISTS "idx_workflow_artifacts_execution_slot"
    ON "workflow_artifacts" ("workflow_execution_id", "slot");
