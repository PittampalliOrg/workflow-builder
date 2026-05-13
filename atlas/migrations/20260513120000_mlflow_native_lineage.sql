ALTER TABLE "agent_versions"
	ADD COLUMN IF NOT EXISTS "mlflow_uri" text,
	ADD COLUMN IF NOT EXISTS "mlflow_model_name" text,
	ADD COLUMN IF NOT EXISTS "mlflow_model_version" text;

ALTER TABLE "benchmark_instances"
	ADD COLUMN IF NOT EXISTS "mlflow_dataset_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_dataset_record_id" text;

ALTER TABLE "benchmark_runs"
	ADD COLUMN IF NOT EXISTS "mlflow_dataset_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_eval_run_id" text;

ALTER TABLE "benchmark_run_instances"
	ADD COLUMN IF NOT EXISTS "mlflow_trace_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_dataset_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_dataset_record_id" text;

ALTER TABLE "workflow_executions"
	ADD COLUMN IF NOT EXISTS "mlflow_experiment_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_run_id" text;

ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "mlflow_experiment_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_run_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_parent_run_id" text;

CREATE TABLE IF NOT EXISTS "mlflow_lineage_links" (
	"id" text PRIMARY KEY,
	"source_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_version" text,
	"project_id" text REFERENCES "projects" ("id") ON DELETE SET NULL,
	"mlflow_entity_type" text NOT NULL,
	"mlflow_experiment_id" text,
	"mlflow_run_id" text,
	"mlflow_trace_id" text,
	"mlflow_dataset_id" text,
	"mlflow_dataset_record_id" text,
	"mlflow_logged_model_id" text,
	"mlflow_logged_model_name" text,
	"mlflow_logged_model_uri" text,
	"mlflow_model_version" text,
	"mlflow_prompt_uri" text,
	"mlflow_prompt_name" text,
	"mlflow_prompt_version" text,
	"mlflow_public_url" text,
	"tags" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp NOT NULL DEFAULT now(),
	"updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_agent_versions_mlflow_uri"
	ON "agent_versions" ("mlflow_uri")
	WHERE "mlflow_uri" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_mlflow_lineage_links_source_key"
	ON "mlflow_lineage_links" ("source_key");

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_local_entity"
	ON "mlflow_lineage_links" ("entity_type", "entity_id", "entity_version");

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_project"
	ON "mlflow_lineage_links" ("project_id");

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_mlflow_run"
	ON "mlflow_lineage_links" ("mlflow_run_id")
	WHERE "mlflow_run_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_mlflow_trace"
	ON "mlflow_lineage_links" ("mlflow_trace_id")
	WHERE "mlflow_trace_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_mlflow_dataset"
	ON "mlflow_lineage_links" ("mlflow_dataset_id")
	WHERE "mlflow_dataset_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_mlflow_logged_model"
	ON "mlflow_lineage_links" ("mlflow_logged_model_uri")
	WHERE "mlflow_logged_model_uri" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_mlflow_prompt"
	ON "mlflow_lineage_links" ("mlflow_prompt_uri")
	WHERE "mlflow_prompt_uri" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_instances_mlflow_dataset"
	ON "benchmark_instances" ("mlflow_dataset_id")
	WHERE "mlflow_dataset_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_instances_mlflow_record"
	ON "benchmark_instances" ("mlflow_dataset_record_id")
	WHERE "mlflow_dataset_record_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_runs_mlflow_dataset"
	ON "benchmark_runs" ("mlflow_dataset_id")
	WHERE "mlflow_dataset_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_runs_mlflow_eval_run"
	ON "benchmark_runs" ("mlflow_eval_run_id")
	WHERE "mlflow_eval_run_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instances_mlflow_trace"
	ON "benchmark_run_instances" ("mlflow_trace_id")
	WHERE "mlflow_trace_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instances_mlflow_dataset"
	ON "benchmark_run_instances" ("mlflow_dataset_id")
	WHERE "mlflow_dataset_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instances_mlflow_record"
	ON "benchmark_run_instances" ("mlflow_dataset_record_id")
	WHERE "mlflow_dataset_record_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_mlflow_run"
	ON "workflow_executions" ("mlflow_run_id")
	WHERE "mlflow_run_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_sessions_mlflow_run"
	ON "sessions" ("mlflow_run_id")
	WHERE "mlflow_run_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_sessions_mlflow_parent_run"
	ON "sessions" ("mlflow_parent_run_id")
	WHERE "mlflow_parent_run_id" IS NOT NULL;
