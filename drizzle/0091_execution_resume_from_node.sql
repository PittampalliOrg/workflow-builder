-- Forks first-class: persist the fork point on the execution row.
-- A resume/fork run is started with `resumeFromNode` (the top-level node it forks
-- FROM, skipping the prefix). Previously that was only passed to the orchestrator and
-- never stored, so the UI couldn't show where a branch diverged. This column records it
-- so the fork-lineage tree can label each branch "fork @<node>". Additive + nullable —
-- NULL for normal (non-fork) runs, no backfill, no behavior change for existing rows.
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "resume_from_node" text;
