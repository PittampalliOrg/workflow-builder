-- Rewrite `agentRuntime` from the deprecated `durable-agent` and
-- `openshell-durable-agent` aliases to the canonical `dapr-agent-py`
-- runtime on every workflow's SW 1.0 spec and the legacy nodes JSONB.
--
-- Audit (at time of writing): 11 workflows, 12 durable/run tasks — all in
-- `execute_direct` mode, which dapr-agent-py implements identically to the
-- TS durable-agent service. No plan/execute-plan/execute-plan-dag routes
-- are in the migrated set, so the runtime swap is feature-preserving.
--
-- Idempotent: re-running produces no further changes because the search
-- strings no longer exist after the first pass.
--
-- execution_ir is intentionally NOT rewritten (historical audit snapshot,
-- same precedent as 0031_deprecate_dapr_agent_py_slug.sql). A rerun loads
-- from workflows.nodes, so rerunnability is preserved.

BEGIN;

UPDATE workflows
SET spec = replace(
             replace(
               spec::text,
               '"agentRuntime": "openshell-durable-agent"',
               '"agentRuntime": "dapr-agent-py"'
             ),
             '"agentRuntime": "durable-agent"',
             '"agentRuntime": "dapr-agent-py"'
           )::jsonb,
    updated_at = now()
WHERE spec IS NOT NULL
  AND (
        spec::text LIKE '%"agentRuntime": "openshell-durable-agent"%'
     OR spec::text LIKE '%"agentRuntime": "durable-agent"%'
  );

UPDATE workflows
SET nodes = replace(
              replace(
                nodes::text,
                '"agentRuntime": "openshell-durable-agent"',
                '"agentRuntime": "dapr-agent-py"'
              ),
              '"agentRuntime": "durable-agent"',
              '"agentRuntime": "dapr-agent-py"'
            )::jsonb,
    updated_at = now()
WHERE nodes IS NOT NULL
  AND (
        nodes::text LIKE '%"agentRuntime": "openshell-durable-agent"%'
     OR nodes::text LIKE '%"agentRuntime": "durable-agent"%'
  );

-- Sanity check: fail the migration if any durable-agent routes remain.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM workflows
  WHERE (spec IS NOT NULL AND (spec::text LIKE '%"agentRuntime": "openshell-durable-agent"%' OR spec::text LIKE '%"agentRuntime": "durable-agent"%'))
     OR (nodes IS NOT NULL AND (nodes::text LIKE '%"agentRuntime": "openshell-durable-agent"%' OR nodes::text LIKE '%"agentRuntime": "durable-agent"%'));

  IF remaining > 0 THEN
    RAISE EXCEPTION 'durable-agent / openshell-durable-agent agentRuntime still present in % row(s) after rewrite', remaining;
  END IF;
END $$;

COMMIT;
