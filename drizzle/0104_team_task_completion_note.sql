-- Agent Teams: the RESULTS channel for the shared task list.
--
-- Teammates deliver their work in `update_task(taskId, "completed", note)` —
-- the note is the deliverable (or a pointer to it). Persisting it closes the
-- gap where deliverables lived only in teammate transcript text that neither
-- the script-lead (team.status()/join() snapshots) nor the run Outputs tab
-- could reach. Codex parity: children return typed results to the parent.
ALTER TABLE "team_tasks" ADD COLUMN IF NOT EXISTS "completion_note" text;
