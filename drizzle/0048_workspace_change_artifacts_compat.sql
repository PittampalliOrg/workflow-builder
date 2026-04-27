-- Compatibility tables for the legacy workspace-runtime image.
--
-- The deprecated durable-agent artifact path was removed from the BFF, but
-- workspace-runtime still runs the old opencode-durable-agent workspace command
-- wrapper. Until that runtime is retired, workspace commands may persist change
-- summaries through these tables. Keep this migration idempotent so clusters
-- that never dropped the tables are unaffected.

CREATE TABLE IF NOT EXISTS workspace_change_artifacts (
	change_set_id text PRIMARY KEY,
	execution_id text NOT NULL,
	workspace_ref text NOT NULL,
	durable_instance_id text,
	operation text NOT NULL,
	sequence integer NOT NULL,
	format text NOT NULL,
	sha256 text NOT NULL,
	files_changed integer NOT NULL,
	additions integer NOT NULL,
	deletions integer NOT NULL,
	bytes integer NOT NULL,
	compressed boolean NOT NULL,
	storage_ref text NOT NULL,
	created_at timestamptz NOT NULL,
	include_in_execution_patch boolean NOT NULL,
	truncated boolean NOT NULL,
	original_bytes integer NOT NULL,
	files jsonb NOT NULL,
	base_revision text,
	head_revision text
);

CREATE TABLE IF NOT EXISTS workspace_change_artifact_files (
	id text PRIMARY KEY,
	change_set_id text NOT NULL REFERENCES workspace_change_artifacts(change_set_id) ON DELETE CASCADE,
	sequence integer NOT NULL,
	path text NOT NULL,
	old_path text,
	status text NOT NULL,
	is_binary boolean NOT NULL DEFAULT false,
	language text,
	old_storage_ref text,
	new_storage_ref text,
	old_compressed boolean NOT NULL DEFAULT false,
	new_compressed boolean NOT NULL DEFAULT false,
	old_bytes integer NOT NULL DEFAULT 0,
	new_bytes integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_change_artifact_blob_payloads (
	storage_ref text PRIMARY KEY,
	payload_text text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_change_artifacts_execution
	ON workspace_change_artifacts (execution_id, sequence, created_at);

CREATE INDEX IF NOT EXISTS idx_workspace_change_artifacts_instance
	ON workspace_change_artifacts (durable_instance_id, sequence);

CREATE INDEX IF NOT EXISTS idx_workspace_change_artifact_files_change_set
	ON workspace_change_artifact_files (change_set_id);

CREATE INDEX IF NOT EXISTS idx_workspace_change_artifact_files_path_sequence
	ON workspace_change_artifact_files (path, sequence);
