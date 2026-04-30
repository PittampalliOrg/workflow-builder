-- Add free-form tags to benchmark_runs for grouping experiments and
-- driving the "auto-pick by tag" affordance on the runs index + compare page.
ALTER TABLE benchmark_runs
	ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

-- GIN index supports `tags @> '["x"]'::jsonb` containment queries that the
-- compare page uses to expand a tag into the list of runs that share it.
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_tags
	ON benchmark_runs USING gin (tags);
