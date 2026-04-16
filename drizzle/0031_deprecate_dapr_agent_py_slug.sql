-- Hard-deprecate dapr-agent-py/* action slugs.
-- Rewrites workflows.nodes[*].data.actionType from 'dapr-agent-py/*' to 'durable/run'.
-- Idempotent: the WHERE clause filters on substring, so a second run is a no-op.
-- workflow_executions.execution_ir is intentionally NOT rewritten (historical audit snapshot; rerun reloads from workflows.nodes).

BEGIN;

WITH rewritten AS (
  SELECT
    w.id,
    jsonb_agg(
      CASE
        WHEN node->'data'->>'actionType' LIKE 'dapr-agent-py/%'
          THEN jsonb_set(node, '{data,actionType}', '"durable/run"'::jsonb)
        ELSE node
      END
      ORDER BY ordinality
    ) AS new_nodes
  FROM workflows AS w,
       jsonb_array_elements(w.nodes) WITH ORDINALITY AS t(node, ordinality)
  WHERE jsonb_typeof(w.nodes) = 'array'
    AND w.nodes::text LIKE '%dapr-agent-py/%'
  GROUP BY w.id
)
UPDATE workflows
SET nodes = rewritten.new_nodes,
    updated_at = now()
FROM rewritten
WHERE workflows.id = rewritten.id;

-- Sanity check: fail the migration if any rewritable records remain after UPDATE.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM workflows AS w,
       jsonb_array_elements(w.nodes) AS node
  WHERE jsonb_typeof(w.nodes) = 'array'
    AND node->'data'->>'actionType' LIKE 'dapr-agent-py/%';

  IF remaining > 0 THEN
    RAISE EXCEPTION 'dapr-agent-py/* slug still present in % node(s) after rewrite', remaining;
  END IF;
END $$;

COMMIT;
