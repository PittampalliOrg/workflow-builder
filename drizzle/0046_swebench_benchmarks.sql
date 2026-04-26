BEGIN;

CREATE TABLE IF NOT EXISTS benchmark_suites (
	id text PRIMARY KEY,
	slug text NOT NULL,
	name text NOT NULL,
	description text,
	dataset_name text NOT NULL,
	dataset_split text NOT NULL DEFAULT 'test',
	source_url text,
	default_instance_limit integer,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_benchmark_suites_slug UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_suites_dataset
	ON benchmark_suites (dataset_name, dataset_split);

CREATE TABLE IF NOT EXISTS benchmark_instances (
	id text PRIMARY KEY,
	suite_id text NOT NULL REFERENCES benchmark_suites(id) ON DELETE CASCADE,
	instance_id text NOT NULL,
	repo text,
	base_commit text,
	problem_statement text,
	hints_text text,
	test_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	gold_patch text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_benchmark_instances_suite_instance UNIQUE (suite_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_instances_suite
	ON benchmark_instances (suite_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_instances_instance
	ON benchmark_instances (instance_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_instances_repo
	ON benchmark_instances (repo);

CREATE TABLE IF NOT EXISTS benchmark_runs (
	id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	suite_id text NOT NULL REFERENCES benchmark_suites(id) ON DELETE RESTRICT,
	agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
	agent_version integer NOT NULL,
	agent_runtime text NOT NULL,
	agent_runtime_app_id text NOT NULL,
	status text NOT NULL DEFAULT 'queued',
	model_name_or_path text NOT NULL,
	model_config_label text,
	selected_instance_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	concurrency integer NOT NULL DEFAULT 1,
	timeout_seconds integer NOT NULL DEFAULT 7200,
	max_turns integer,
	evaluator_resource_class text NOT NULL DEFAULT 'standard',
	coordinator_execution_id text,
	evaluator_job_name text,
	predictions_path text,
	summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	error text,
	cancel_requested_at timestamp,
	started_at timestamp,
	completed_at timestamp,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_project_created
	ON benchmark_runs (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status
	ON benchmark_runs (status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_suite
	ON benchmark_runs (suite_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_agent
	ON benchmark_runs (agent_id);

CREATE TABLE IF NOT EXISTS benchmark_run_instances (
	id text PRIMARY KEY,
	run_id text NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
	benchmark_instance_id text REFERENCES benchmark_instances(id) ON DELETE SET NULL,
	instance_id text NOT NULL,
	status text NOT NULL DEFAULT 'queued',
	session_id text REFERENCES sessions(id) ON DELETE SET NULL,
	workflow_execution_id text REFERENCES workflow_executions(id) ON DELETE SET NULL,
	dapr_instance_id text,
	sandbox_name text,
	workspace_ref text,
	model_patch text,
	patch_sha256 text,
	patch_bytes integer,
	usage jsonb NOT NULL DEFAULT '{}'::jsonb,
	timings jsonb NOT NULL DEFAULT '{}'::jsonb,
	trace_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	error text,
	logs_path text,
	test_output_summary text,
	harness_result jsonb,
	started_at timestamp,
	inference_completed_at timestamp,
	evaluated_at timestamp,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_benchmark_run_instances_run_instance UNIQUE (run_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_run
	ON benchmark_run_instances (run_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_status
	ON benchmark_run_instances (status);
CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_session
	ON benchmark_run_instances (session_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_run_instances_workflow_execution
	ON benchmark_run_instances (workflow_execution_id);

CREATE TABLE IF NOT EXISTS benchmark_artifacts (
	id text PRIMARY KEY,
	run_id text NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
	run_instance_id text REFERENCES benchmark_run_instances(id) ON DELETE CASCADE,
	kind text NOT NULL,
	path text NOT NULL,
	content_type text,
	size_bytes integer,
	sha256 text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_artifacts_run
	ON benchmark_artifacts (run_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_artifacts_instance
	ON benchmark_artifacts (run_instance_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_artifacts_kind
	ON benchmark_artifacts (kind);

INSERT INTO benchmark_suites (
	id,
	slug,
	name,
	description,
	dataset_name,
	dataset_split,
	source_url,
	default_instance_limit,
	metadata
)
VALUES
	(
		'bsuite_swebench_verified',
		'SWE-bench_Verified',
		'SWE-bench Verified',
		'Human-validated SWE-bench subset for software issue resolution.',
		'princeton-nlp/SWE-bench_Verified',
		'test',
		'https://www.swebench.com/',
		500,
		'{"family":"swebench","official":true}'::jsonb
	),
	(
		'bsuite_swebench_lite',
		'SWE-bench_Lite',
		'SWE-bench Lite',
		'Smaller SWE-bench subset commonly used for faster evaluation.',
		'princeton-nlp/SWE-bench_Lite',
		'test',
		'https://www.swebench.com/',
		300,
		'{"family":"swebench","official":true}'::jsonb
	)
ON CONFLICT (slug) DO UPDATE SET
	name = EXCLUDED.name,
	description = EXCLUDED.description,
	dataset_name = EXCLUDED.dataset_name,
	dataset_split = EXCLUDED.dataset_split,
	source_url = EXCLUDED.source_url,
	default_instance_limit = EXCLUDED.default_instance_limit,
	metadata = benchmark_suites.metadata || EXCLUDED.metadata,
	updated_at = now();

COMMIT;
