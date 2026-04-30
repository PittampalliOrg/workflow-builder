ALTER TABLE "benchmark_runs" ADD COLUMN "mlflow_experiment_id" text;
ALTER TABLE "benchmark_runs" ADD COLUMN "mlflow_run_id" text;
ALTER TABLE "benchmark_run_instances" ADD COLUMN "mlflow_run_id" text;

CREATE INDEX "idx_benchmark_runs_mlflow_run" ON "benchmark_runs" ("mlflow_run_id");
CREATE INDEX "idx_benchmark_run_instances_mlflow_run" ON "benchmark_run_instances" ("mlflow_run_id");
