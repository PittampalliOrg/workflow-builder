ALTER TABLE "benchmark_runs"
ADD COLUMN IF NOT EXISTS "evaluation_concurrency" integer NOT NULL DEFAULT 24;
