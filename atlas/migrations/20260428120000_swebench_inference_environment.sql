ALTER TABLE benchmark_run_instances
	ADD COLUMN IF NOT EXISTS inference_environment jsonb NOT NULL DEFAULT '{}'::jsonb;
