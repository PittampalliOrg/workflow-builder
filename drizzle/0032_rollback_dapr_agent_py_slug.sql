-- Counter-migration for 0031_deprecate_dapr_agent_py_slug.sql.
-- MANUAL ONLY: not registered in drizzle/meta/_journal.json, so `pnpm db:migrate`
-- will not run this. Apply by hand with psql if a revert is needed.
--
-- Limitation: a pure reverse rewrite isn't possible — we cannot tell which
-- durable/run nodes were originally dapr-agent-py/*, so blanket rewriting
-- durable/run back would corrupt rows that were always durable/run.
--
-- Safe revert path:
--   1) Restore the previous image tags for workflow-orchestrator and
--      function-router via stacks release pins.
--   2) If a specific workflow needs the legacy slug restored, rewrite its
--      single nodes[*].data.actionType value manually:
--
--      UPDATE workflows
--      SET nodes = jsonb_set(
--        nodes,
--        '{<array-index>,data,actionType}',
--        '"dapr-agent-py/run"'::jsonb
--      )
--      WHERE id = '<workflow-id>';
--
-- 0031 was a no-op at deploy time (0 rows affected), so this file is a
-- placeholder for symmetry with the forward migration.

BEGIN;

DO $$
DECLARE
  affected integer;
BEGIN
  SELECT COUNT(*) INTO affected
  FROM workflows AS w,
       jsonb_array_elements(w.nodes) AS node
  WHERE jsonb_typeof(w.nodes) = 'array'
    AND node->'data'->>'actionType' = 'durable/run';

  RAISE NOTICE 'Revert inspection: % nodes currently use durable/run. Manual selective rewrite required if a specific workflow needs dapr-agent-py/run restored.', affected;
END $$;

COMMIT;
