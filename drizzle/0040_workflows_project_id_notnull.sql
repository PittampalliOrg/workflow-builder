-- Deterministic project scoping for workflows.
--
-- 1. Backfill any remaining NULL workflows.project_id to the owner's oldest
--    project (matches auth-social.getOrCreateDefaultProject semantics).
-- 2. Cascade that backfill into workflow_executions.project_id and
--    sessions.project_id for workflow-driven rows.
-- 3. Enforce NOT NULL on workflows.project_id so no future insert path can
--    create an unscoped workflow (the POST /api/workflows handler is the only
--    live insertion path and now stamps locals.session.projectId).
--
-- Idempotent: backfill UPDATEs no-op after first run; NOT NULL is guarded
-- against double-apply by dropping only if the column is currently nullable.

BEGIN;

UPDATE workflows w
SET project_id = (
  SELECT p.id FROM projects p
  WHERE p.owner_id = w.user_id
  ORDER BY p.created_at ASC
  LIMIT 1
)
WHERE w.project_id IS NULL;

UPDATE workflow_executions we
SET project_id = w.project_id
FROM workflows w
WHERE we.workflow_id = w.id
  AND we.project_id IS NULL
  AND w.project_id IS NOT NULL;

UPDATE sessions s
SET project_id = we.project_id
FROM workflow_executions we
WHERE s.workflow_execution_id = we.id
  AND s.project_id IS NULL
  AND we.project_id IS NOT NULL;

DO $$
DECLARE
  still_null integer;
BEGIN
  SELECT COUNT(*) INTO still_null FROM workflows WHERE project_id IS NULL;
  IF still_null > 0 THEN
    RAISE EXCEPTION 'cannot enforce NOT NULL: % workflows still have project_id = NULL', still_null;
  END IF;
END $$;

ALTER TABLE workflows
  ALTER COLUMN project_id SET NOT NULL;

COMMIT;
