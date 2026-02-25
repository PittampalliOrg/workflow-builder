-- Update workflow plan artifact default type for Claude Code planner output.
ALTER TABLE "workflow_plan_artifacts"
  ALTER COLUMN "artifact_type" SET DEFAULT 'claude_task_graph_v1';
