-- CMA alignment Deploy B / Tier 1: scope workflow_executions by project_id.
--
-- Adds project_id column (nullable for now), backfills from workflows.project_id,
-- and creates an index. A follow-up migration can make this NOT NULL after any
-- stragglers (pre-CMA rows with null workflows.project_id) are cleared.
--
-- Idempotent via IF NOT EXISTS on the column + CREATE INDEX IF NOT EXISTS. Safe
-- to apply more than once; backfill UPDATE is a no-op after the first run.

BEGIN;

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS project_id TEXT;

UPDATE workflow_executions we
SET project_id = w.project_id
FROM workflows w
WHERE we.workflow_id = w.id
  AND we.project_id IS NULL
  AND w.project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_executions_project_id
  ON workflow_executions(project_id)
  WHERE project_id IS NOT NULL;

DO $$
DECLARE
  total integer;
  scoped integer;
  unscoped_but_workflow_scoped integer;
BEGIN
  SELECT COUNT(*) INTO total FROM workflow_executions;
  SELECT COUNT(*) INTO scoped FROM workflow_executions WHERE project_id IS NOT NULL;
  SELECT COUNT(*) INTO unscoped_but_workflow_scoped
  FROM workflow_executions we
  JOIN workflows w ON w.id = we.workflow_id
  WHERE we.project_id IS NULL AND w.project_id IS NOT NULL;

  RAISE NOTICE 'workflow_executions: total=%, scoped=%, unscoped-but-workflow-has-project=% (should be 0 after backfill)',
    total, scoped, unscoped_but_workflow_scoped;
END $$;

COMMIT;
