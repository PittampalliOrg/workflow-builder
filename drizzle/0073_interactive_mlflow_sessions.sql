ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "mlflow_session_id" text;

UPDATE "sessions"
SET "mlflow_session_id" = "id"
WHERE "mlflow_session_id" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_sessions_mlflow_session"
	ON "sessions" ("mlflow_session_id");

ALTER TABLE "mlflow_lineage_links"
	ADD COLUMN IF NOT EXISTS "mlflow_session_id" text;

CREATE INDEX IF NOT EXISTS "idx_mlflow_lineage_links_mlflow_session"
	ON "mlflow_lineage_links" ("mlflow_session_id");
