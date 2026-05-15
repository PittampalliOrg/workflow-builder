UPDATE "sessions"
SET "mlflow_session_id" = "id"
WHERE "mlflow_session_id" IS NULL;

UPDATE "mlflow_lineage_links"
SET "mlflow_session_id" = "entity_id"
WHERE "entity_type" = 'session'
	AND "mlflow_session_id" IS NULL;
