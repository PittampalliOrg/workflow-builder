-- Phase B — lifecycle metrics. Populated when dapr-agent-py emits
-- `instance.metrics_summary` once per agent_workflow run; ingested into
-- benchmark_run_instances by appendEvent in src/lib/server/sessions/events.ts.
ALTER TABLE benchmark_run_instances
	ADD COLUMN IF NOT EXISTS turn_count integer,
	ADD COLUMN IF NOT EXISTS tool_call_count integer,
	ADD COLUMN IF NOT EXISTS termination_reason text,
	ADD COLUMN IF NOT EXISTS ttft_first_ms integer,
	ADD COLUMN IF NOT EXISTS ttft_first_tool_ms integer,
	ADD COLUMN IF NOT EXISTS tool_histogram jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_termination
	ON benchmark_run_instances (termination_reason);
