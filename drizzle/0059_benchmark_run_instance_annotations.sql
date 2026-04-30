-- Phase K — human annotation layer for benchmark instances. One row per
-- (run_instance, user) so a single user can revise their own verdict in place
-- (UPSERT on the unique constraint), but other users contribute additional
-- rows. Aggregated into RunStats.humanAnnotations alongside scorer signals.
CREATE TABLE IF NOT EXISTS "benchmark_run_instance_annotations" (
  "id" text PRIMARY KEY NOT NULL,
  "run_instance_id" text NOT NULL REFERENCES "benchmark_run_instances"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL,
  "reasoning" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_benchmark_run_instance_annotations_user"
  ON "benchmark_run_instance_annotations" ("run_instance_id", "user_id");

CREATE INDEX IF NOT EXISTS "idx_benchmark_run_instance_annotations_run_instance"
  ON "benchmark_run_instance_annotations" ("run_instance_id");
