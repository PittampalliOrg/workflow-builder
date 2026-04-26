CREATE TABLE IF NOT EXISTS evaluation_datasets (
	id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name text NOT NULL,
	description text,
	source_type text NOT NULL DEFAULT 'manual',
	source_url text,
	schema jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_datasets_project_created
	ON evaluation_datasets (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_datasets_project_name
	ON evaluation_datasets (project_id, name);

CREATE TABLE IF NOT EXISTS evaluation_dataset_rows (
	id text PRIMARY KEY,
	dataset_id text NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
	external_id text,
	input jsonb NOT NULL DEFAULT '{}'::jsonb,
	expected_output jsonb,
	generated_output jsonb,
	annotations jsonb NOT NULL DEFAULT '{}'::jsonb,
	rating integer,
	feedback text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_evaluation_dataset_rows_dataset_external UNIQUE (dataset_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_dataset_rows_dataset
	ON evaluation_dataset_rows (dataset_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_dataset_rows_external
	ON evaluation_dataset_rows (external_id);

CREATE TABLE IF NOT EXISTS evaluations (
	id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	dataset_id text REFERENCES evaluation_datasets(id) ON DELETE SET NULL,
	name text NOT NULL,
	description text,
	task_config jsonb NOT NULL DEFAULT '{}'::jsonb,
	data_source_config jsonb NOT NULL DEFAULT '{}'::jsonb,
	testing_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluations_project_created
	ON evaluations (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluations_dataset
	ON evaluations (dataset_id);

CREATE TABLE IF NOT EXISTS evaluation_graders (
	id text PRIMARY KEY,
	evaluation_id text NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
	name text NOT NULL,
	type text NOT NULL,
	config jsonb NOT NULL DEFAULT '{}'::jsonb,
	weight integer NOT NULL DEFAULT 1,
	pass_threshold real NOT NULL DEFAULT 1,
	order_index integer NOT NULL DEFAULT 0,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_graders_evaluation
	ON evaluation_graders (evaluation_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_graders_type
	ON evaluation_graders (type);

CREATE TABLE IF NOT EXISTS evaluation_runs (
	id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	evaluation_id text NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
	dataset_id text REFERENCES evaluation_datasets(id) ON DELETE SET NULL,
	status text NOT NULL DEFAULT 'queued',
	subject_type text NOT NULL DEFAULT 'imported_outputs',
	subject_id text,
	subject_version text,
	execution_config jsonb NOT NULL DEFAULT '{}'::jsonb,
	coordinator_execution_id text,
	summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	usage jsonb NOT NULL DEFAULT '{}'::jsonb,
	error text,
	cancel_requested_at timestamp,
	started_at timestamp,
	completed_at timestamp,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_project_created
	ON evaluation_runs (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status
	ON evaluation_runs (status);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_evaluation
	ON evaluation_runs (evaluation_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_dataset
	ON evaluation_runs (dataset_id);

CREATE TABLE IF NOT EXISTS evaluation_run_items (
	id text PRIMARY KEY,
	run_id text NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
	dataset_row_id text REFERENCES evaluation_dataset_rows(id) ON DELETE SET NULL,
	row_index integer NOT NULL DEFAULT 0,
	status text NOT NULL DEFAULT 'queued',
	input jsonb NOT NULL DEFAULT '{}'::jsonb,
	expected_output jsonb,
	generated_output jsonb,
	grader_results jsonb NOT NULL DEFAULT '{}'::jsonb,
	scores jsonb NOT NULL DEFAULT '{}'::jsonb,
	usage jsonb NOT NULL DEFAULT '{}'::jsonb,
	trace_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	session_id text REFERENCES sessions(id) ON DELETE SET NULL,
	workflow_execution_id text REFERENCES workflow_executions(id) ON DELETE SET NULL,
	dapr_instance_id text,
	error text,
	started_at timestamp,
	completed_at timestamp,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_run_items_run
	ON evaluation_run_items (run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_run_items_status
	ON evaluation_run_items (status);
CREATE INDEX IF NOT EXISTS idx_evaluation_run_items_dataset_row
	ON evaluation_run_items (dataset_row_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_run_items_workflow_execution
	ON evaluation_run_items (workflow_execution_id);

CREATE TABLE IF NOT EXISTS evaluation_artifacts (
	id text PRIMARY KEY,
	run_id text NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
	run_item_id text REFERENCES evaluation_run_items(id) ON DELETE CASCADE,
	kind text NOT NULL,
	path text,
	content jsonb,
	content_type text,
	size_bytes integer,
	sha256 text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_artifacts_run
	ON evaluation_artifacts (run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_artifacts_item
	ON evaluation_artifacts (run_item_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_artifacts_kind
	ON evaluation_artifacts (kind);
