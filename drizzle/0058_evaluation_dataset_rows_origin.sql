-- Phase H — bidirectional link from evaluation dataset rows back to the
-- benchmark run instance (or session) they were captured from. Mirrors
-- Braintrust's `origin` pointer pattern: a dataset row authored by clicking
-- "Add to dataset" on a run knows exactly which trace it came from.
ALTER TABLE evaluation_dataset_rows
	ADD COLUMN IF NOT EXISTS origin_run_instance_id text,
	ADD COLUMN IF NOT EXISTS origin_session_id text;

CREATE INDEX IF NOT EXISTS idx_evaluation_dataset_rows_origin_run_instance
	ON evaluation_dataset_rows (origin_run_instance_id);

CREATE INDEX IF NOT EXISTS idx_evaluation_dataset_rows_origin_session
	ON evaluation_dataset_rows (origin_session_id);
