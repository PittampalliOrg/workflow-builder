ALTER TABLE "workflows"
	ADD COLUMN IF NOT EXISTS "mlflow_experiment_id" text,
	ADD COLUMN IF NOT EXISTS "mlflow_experiment_name" text;

CREATE INDEX IF NOT EXISTS "idx_workflows_mlflow_experiment"
	ON "workflows" ("mlflow_experiment_id")
	WHERE "mlflow_experiment_id" IS NOT NULL;
