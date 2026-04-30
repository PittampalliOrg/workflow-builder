-- Phase G — scorer layer for benchmark runs.
-- Each row = one scorer × one benchmark_run_instances row.
-- Idempotency: (run_instance_id, scorer_name, scorer_version) is unique;
-- the score-runner skips if a row already exists.
CREATE TABLE IF NOT EXISTS benchmark_run_instance_scores (
	id text PRIMARY KEY,
	run_instance_id text NOT NULL REFERENCES benchmark_run_instances(id) ON DELETE CASCADE,
	scorer_name text NOT NULL,
	scorer_version integer NOT NULL DEFAULT 1,
	score double precision NOT NULL,
	reasoning text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT NOW(),
	updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_benchmark_run_instance_scores_unique
	ON benchmark_run_instance_scores (run_instance_id, scorer_name, scorer_version);

CREATE INDEX IF NOT EXISTS idx_benchmark_run_instance_scores_scorer
	ON benchmark_run_instance_scores (scorer_name, scorer_version);

CREATE INDEX IF NOT EXISTS idx_benchmark_run_instance_scores_run_instance
	ON benchmark_run_instance_scores (run_instance_id);
