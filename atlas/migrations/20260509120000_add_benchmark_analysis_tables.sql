-- Mirror Drizzle migrations 0053-0059 for the Atlas startup migrator.
-- These columns/tables back the Benchmarks analyst surfaces: tagged runs,
-- patch comparison, lifecycle metrics, MLflow links, scorer rows, promoted
-- dataset origins, and human annotations.

ALTER TABLE "benchmark_runs"
	ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
	ADD COLUMN IF NOT EXISTS "mlflow_experiment_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_run_id" text;

CREATE INDEX IF NOT EXISTS "idx_benchmark_runs_tags"
	ON "benchmark_runs" USING gin ("tags");

CREATE INDEX IF NOT EXISTS "idx_benchmark_runs_mlflow_run"
	ON "benchmark_runs" ("mlflow_run_id");

ALTER TABLE "benchmark_run_instances"
	ADD COLUMN IF NOT EXISTS "patch_added_lines" integer,
	ADD COLUMN IF NOT EXISTS "patch_removed_lines" integer,
	ADD COLUMN IF NOT EXISTS "patch_files_touched" integer,
	ADD COLUMN IF NOT EXISTS "patch_files_overlap_gold" integer,
	ADD COLUMN IF NOT EXISTS "patch_well_formed" boolean,
	ADD COLUMN IF NOT EXISTS "turn_count" integer,
	ADD COLUMN IF NOT EXISTS "tool_call_count" integer,
	ADD COLUMN IF NOT EXISTS "termination_reason" text,
	ADD COLUMN IF NOT EXISTS "ttft_first_ms" integer,
	ADD COLUMN IF NOT EXISTS "ttft_first_tool_ms" integer,
	ADD COLUMN IF NOT EXISTS "tool_histogram" jsonb NOT NULL DEFAULT '{}'::jsonb,
	ADD COLUMN IF NOT EXISTS "mlflow_run_id" text;

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instances_termination"
	ON "benchmark_run_instances" ("termination_reason");

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instances_mlflow_run"
	ON "benchmark_run_instances" ("mlflow_run_id");

CREATE TABLE IF NOT EXISTS "benchmark_run_instance_scores" (
	"id" text PRIMARY KEY,
	"run_instance_id" text NOT NULL REFERENCES "benchmark_run_instances"("id") ON DELETE CASCADE,
	"scorer_name" text NOT NULL,
	"scorer_version" integer NOT NULL DEFAULT 1,
	"score" double precision NOT NULL,
	"reasoning" text,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp NOT NULL DEFAULT NOW(),
	"updated_at" timestamp NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_benchmark_run_instance_scores_unique"
	ON "benchmark_run_instance_scores" ("run_instance_id", "scorer_name", "scorer_version");

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instance_scores_scorer"
	ON "benchmark_run_instance_scores" ("scorer_name", "scorer_version");

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instance_scores_run_instance"
	ON "benchmark_run_instance_scores" ("run_instance_id");

ALTER TABLE "evaluation_dataset_rows"
	ADD COLUMN IF NOT EXISTS "origin_run_instance_id" text,
	ADD COLUMN IF NOT EXISTS "origin_session_id" text;

CREATE INDEX IF NOT EXISTS "idx_evaluation_dataset_rows_origin_run_instance"
	ON "evaluation_dataset_rows" ("origin_run_instance_id");

CREATE INDEX IF NOT EXISTS "idx_evaluation_dataset_rows_origin_session"
	ON "evaluation_dataset_rows" ("origin_session_id");

CREATE TABLE IF NOT EXISTS "benchmark_run_instance_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_instance_id" text NOT NULL REFERENCES "benchmark_run_instances"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"verdict" text NOT NULL,
	"reasoning" text,
	"created_at" timestamp NOT NULL DEFAULT NOW(),
	"updated_at" timestamp NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_benchmark_run_instance_annotations_user"
	ON "benchmark_run_instance_annotations" ("run_instance_id", "user_id");

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instance_annotations_run_instance"
	ON "benchmark_run_instance_annotations" ("run_instance_id");
