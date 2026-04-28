CREATE TABLE IF NOT EXISTS environment_image_builds (
	id text PRIMARY KEY NOT NULL,
	dataset text NOT NULL,
	suite text,
	repo text NOT NULL,
	version text,
	environment_setup_commit text,
	base_commit text,
	environment_key text NOT NULL,
	env_spec_hash text NOT NULL,
	build_strategy text NOT NULL DEFAULT 'swebench-harness',
	status text NOT NULL DEFAULT 'queued',
	sandbox_template text NOT NULL DEFAULT 'dapr-agent',
	sandbox_image text,
	digest text,
	image_name text,
	image_tag text,
	dockerfile_path text,
	validation_command text,
	validation_status text,
	validation_log_ref text,
	build_log_ref text,
	pipeline_run_name text,
	pipeline_run_namespace text DEFAULT 'tekton-pipelines',
	spec jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	error text,
	requested_at timestamp NOT NULL DEFAULT now(),
	started_at timestamp,
	completed_at timestamp,
	built_at timestamp,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_environment_image_builds_spec_hash
	ON environment_image_builds (env_spec_hash);
CREATE INDEX IF NOT EXISTS idx_environment_image_builds_status
	ON environment_image_builds (status);
CREATE INDEX IF NOT EXISTS idx_environment_image_builds_key
	ON environment_image_builds (environment_key);
CREATE INDEX IF NOT EXISTS idx_environment_image_builds_repo
	ON environment_image_builds (repo);
CREATE INDEX IF NOT EXISTS idx_environment_image_builds_pipeline_run
	ON environment_image_builds (pipeline_run_namespace, pipeline_run_name);
