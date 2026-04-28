CREATE TABLE IF NOT EXISTS environment_build_activity_events (
	id text PRIMARY KEY NOT NULL,
	build_id text NOT NULL REFERENCES environment_image_builds(id) ON DELETE cascade,
	environment_key text NOT NULL,
	event_key text NOT NULL,
	event_type text NOT NULL,
	pipeline_run_name text,
	pipeline_run_namespace text,
	task_run_name text,
	phase text,
	reason text,
	message text,
	event_timestamp timestamp NOT NULL,
	raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_environment_build_activity_build_event
	ON environment_build_activity_events (build_id, event_key);
CREATE INDEX IF NOT EXISTS idx_environment_build_activity_timeline
	ON environment_build_activity_events (build_id, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_environment_build_activity_type
	ON environment_build_activity_events (build_id, event_type);
CREATE INDEX IF NOT EXISTS idx_environment_build_activity_pipeline_run
	ON environment_build_activity_events (pipeline_run_namespace, pipeline_run_name);
