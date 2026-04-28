ALTER TABLE benchmark_run_instances
	ADD COLUMN IF NOT EXISTS inference_status text NOT NULL DEFAULT 'queued',
	ADD COLUMN IF NOT EXISTS evaluation_status text NOT NULL DEFAULT 'pending',
	ADD COLUMN IF NOT EXISTS inference_error text,
	ADD COLUMN IF NOT EXISTS evaluation_error text;

UPDATE benchmark_run_instances
SET
	inference_status = CASE
		WHEN inference_completed_at IS NULL AND status IN ('queued', 'inferencing') THEN status
		WHEN status = 'inferred' THEN 'inferred'
		WHEN status IN ('resolved', 'failed', 'evaluating') THEN 'inferred'
		WHEN status IN ('error', 'timeout', 'cancelled') THEN status
		ELSE inference_status
	END,
	evaluation_status = CASE
		WHEN evaluated_at IS NOT NULL AND status = 'resolved' THEN 'resolved'
		WHEN evaluated_at IS NOT NULL AND status = 'failed' AND coalesce(model_patch, '') = '' THEN 'empty_patch'
		WHEN evaluated_at IS NOT NULL AND status = 'failed' THEN 'unresolved'
		WHEN evaluated_at IS NOT NULL AND status IN ('error', 'timeout', 'cancelled') THEN status
		WHEN status = 'evaluating' THEN 'evaluating'
		WHEN status = 'cancelled' THEN 'cancelled'
		ELSE evaluation_status
	END,
	inference_error = CASE
		WHEN inference_error IS NULL AND inference_completed_at IS NOT NULL AND status IN ('error', 'timeout', 'cancelled') THEN error
		ELSE inference_error
	END,
	evaluation_error = CASE
		WHEN evaluation_error IS NULL AND evaluated_at IS NOT NULL THEN error
		ELSE evaluation_error
	END
WHERE true;

CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_inference_status
	ON benchmark_run_instances (inference_status);

CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_evaluation_status
	ON benchmark_run_instances (evaluation_status);
