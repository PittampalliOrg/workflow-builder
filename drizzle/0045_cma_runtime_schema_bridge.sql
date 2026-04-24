-- Production bridge for CMA runtime schema that originally landed through
-- Atlas-only migrations. The GitOps db-migrate hook runs Drizzle, so this
-- file keeps dev/staging schema convergence inside the normal rollout path.

BEGIN;

CREATE TABLE IF NOT EXISTS sandbox_profiles (
	id text PRIMARY KEY,
	slug text NOT NULL,
	name text NOT NULL,
	description text,
	base_profile_slug text,
	packages jsonb NOT NULL DEFAULT '{}'::jsonb,
	capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
	dockerfile_path text,
	image_tag text,
	last_build_sha text,
	last_build_at timestamp,
	last_build_status text,
	last_build_error text,
	is_archived boolean NOT NULL DEFAULT false,
	is_builtin boolean NOT NULL DEFAULT false,
	created_by text,
	project_id text,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT sandbox_profiles_slug_unique UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_profiles_archived ON sandbox_profiles (is_archived);
CREATE INDEX IF NOT EXISTS idx_sandbox_profiles_project ON sandbox_profiles (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sandbox_profiles_base ON sandbox_profiles (base_profile_slug);

CREATE TABLE IF NOT EXISTS environments (
	id text PRIMARY KEY,
	slug text NOT NULL,
	name text NOT NULL,
	description text,
	avatar text,
	tags jsonb NOT NULL DEFAULT '[]'::jsonb,
	runtime text NOT NULL DEFAULT 'cloud',
	current_version_id text,
	created_by text,
	project_id text,
	is_archived boolean NOT NULL DEFAULT false,
	is_builtin boolean NOT NULL DEFAULT false,
	base_env_slug text,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_environments_slug UNIQUE (slug)
);

ALTER TABLE environments ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS base_env_slug text;

CREATE INDEX IF NOT EXISTS idx_environments_archived ON environments (is_archived);
CREATE INDEX IF NOT EXISTS idx_environments_project ON environments (project_id);
CREATE INDEX IF NOT EXISTS idx_environments_builtin ON environments (is_builtin);
CREATE INDEX IF NOT EXISTS idx_environments_base ON environments (base_env_slug);

CREATE TABLE IF NOT EXISTS environment_versions (
	id text PRIMARY KEY,
	environment_id text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
	version integer NOT NULL,
	config jsonb NOT NULL,
	config_hash text NOT NULL,
	changelog text,
	published_at timestamp,
	published_by text,
	image_tag text,
	dockerfile_path text,
	last_build_sha text,
	last_build_at timestamp,
	last_build_status text,
	last_build_error text,
	created_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_environment_version UNIQUE (environment_id, version)
);

ALTER TABLE environment_versions ADD COLUMN IF NOT EXISTS image_tag text;
ALTER TABLE environment_versions ADD COLUMN IF NOT EXISTS dockerfile_path text;
ALTER TABLE environment_versions ADD COLUMN IF NOT EXISTS last_build_sha text;
ALTER TABLE environment_versions ADD COLUMN IF NOT EXISTS last_build_at timestamp;
ALTER TABLE environment_versions ADD COLUMN IF NOT EXISTS last_build_status text;
ALTER TABLE environment_versions ADD COLUMN IF NOT EXISTS last_build_error text;

CREATE INDEX IF NOT EXISTS idx_environment_versions_hash ON environment_versions (config_hash);
CREATE INDEX IF NOT EXISTS idx_environment_versions_environment ON environment_versions (environment_id);

CREATE TABLE IF NOT EXISTS vaults (
	id text PRIMARY KEY,
	name text NOT NULL,
	description text,
	project_id text,
	created_by text,
	is_archived boolean NOT NULL DEFAULT false,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_vaults_project_name UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_vaults_project ON vaults (project_id);
CREATE INDEX IF NOT EXISTS idx_vaults_archived ON vaults (is_archived);

CREATE TABLE IF NOT EXISTS vault_credentials (
	id text PRIMARY KEY,
	vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
	display_name text NOT NULL,
	auth_type text NOT NULL,
	value jsonb NOT NULL,
	mcp_server_url text,
	refresh_metadata jsonb,
	expires_at timestamp,
	last_refreshed_at timestamp,
	last_used_at timestamp,
	is_archived boolean NOT NULL DEFAULT false,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_credentials_vault ON vault_credentials (vault_id);
CREATE INDEX IF NOT EXISTS idx_vault_credentials_mcp_url ON vault_credentials (mcp_server_url);
CREATE INDEX IF NOT EXISTS idx_vault_credentials_expires ON vault_credentials (expires_at);

CREATE TABLE IF NOT EXISTS vault_credential_refresh_log (
	id text PRIMARY KEY,
	credential_id text NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
	status text NOT NULL,
	error_message text,
	response_status integer,
	attempted_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_refresh_log_credential ON vault_credential_refresh_log (credential_id);
CREATE INDEX IF NOT EXISTS idx_vault_refresh_log_attempted ON vault_credential_refresh_log (attempted_at);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'dapr-agent-py';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_version_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS source_template_slug text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS source_template_version integer;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'agents'
		  AND column_name = 'user_id'
	) THEN
		UPDATE agents
		SET created_by = user_id
		WHERE created_by IS NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'agents'
		  AND column_name = 'instructions'
	) THEN
		ALTER TABLE agents ALTER COLUMN instructions DROP NOT NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'agents'
		  AND column_name = 'model'
	) THEN
		ALTER TABLE agents ALTER COLUMN model DROP NOT NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'agents'
		  AND column_name = 'user_id'
	) THEN
		ALTER TABLE agents ALTER COLUMN user_id DROP NOT NULL;
	END IF;
END $$;

UPDATE agents
SET slug = 'agent-' || substring(md5(id) from 1 for 12)
WHERE slug IS NULL;

ALTER TABLE agents ALTER COLUMN slug SET NOT NULL;

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_agents_slug') THEN
		ALTER TABLE agents ADD CONSTRAINT uq_agents_slug UNIQUE (slug);
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agents_archived ON agents (is_archived);

CREATE TABLE IF NOT EXISTS agent_versions (
	id text PRIMARY KEY,
	agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	version integer NOT NULL,
	config jsonb NOT NULL,
	config_hash text NOT NULL,
	changelog text,
	published_at timestamp,
	published_by text REFERENCES users(id) ON DELETE SET NULL,
	created_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_agent_version UNIQUE (agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_hash ON agent_versions (config_hash);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions (agent_id);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_app_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_status text NOT NULL DEFAULT 'pending';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_status_synced_at timestamp with time zone;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment_version integer;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_vault_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS project_id text;

UPDATE agents
SET runtime_app_id = 'agent-runtime-' || slug
WHERE runtime_app_id IS NULL
  AND COALESCE(is_archived, false) = false;

UPDATE agents a
SET project_id = u.project_id_fallback
FROM (
	SELECT u.id AS user_id,
	       COALESCE(
		       (SELECT pm.project_id FROM project_members pm
		         WHERE pm.user_id = u.id ORDER BY pm.created_at ASC LIMIT 1),
		       (SELECT p.id FROM projects p
		         WHERE p.platform_id = u.platform_id ORDER BY p.created_at ASC LIMIT 1)
	       ) AS project_id_fallback
	FROM users u
) u
WHERE a.created_by = u.user_id
  AND a.project_id IS NULL;

UPDATE agents
SET project_id = (SELECT id FROM projects ORDER BY created_at ASC LIMIT 1)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_runtime_app_id ON agents (runtime_app_id) WHERE runtime_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_environment ON agents (environment_id);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id);

CREATE TABLE IF NOT EXISTS sessions (
	id text PRIMARY KEY,
	title text,
	status text NOT NULL DEFAULT 'rescheduling',
	stop_reason jsonb,
	agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
	agent_version integer,
	environment_id text REFERENCES environments(id) ON DELETE RESTRICT,
	environment_version integer,
	vault_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	dapr_instance_id text,
	nats_subject text,
	sandbox_name text,
	workspace_sandbox_name text,
	workflow_execution_id text,
	parent_execution_id text,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	project_id text REFERENCES projects(id) ON DELETE CASCADE,
	usage jsonb NOT NULL DEFAULT '{}'::jsonb,
	error_message text,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now(),
	completed_at timestamp,
	archived_at timestamp
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_name text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_sandbox_name text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_execution_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id text;

UPDATE sessions
SET sandbox_name = 'dapr-agent-py'
WHERE sandbox_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_workflow_execution ON sessions (workflow_execution_id);
CREATE INDEX IF NOT EXISTS idx_sessions_sandbox_name ON sessions (sandbox_name) WHERE sandbox_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_sandbox ON sessions (workspace_sandbox_name) WHERE workspace_sandbox_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sessions (project_id, created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS session_events (
	id text PRIMARY KEY,
	session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	sequence integer NOT NULL,
	type text NOT NULL,
	data jsonb NOT NULL DEFAULT '{}'::jsonb,
	processed_at timestamp,
	source_event_id text,
	producer_id text,
	producer_epoch text,
	created_at timestamp NOT NULL DEFAULT now(),
	CONSTRAINT uq_session_event_sequence UNIQUE (session_id, sequence)
);

ALTER TABLE session_events ADD COLUMN IF NOT EXISTS source_event_id text;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS producer_id text;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS producer_epoch text;

CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events (type);
CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_events_source ON session_events (session_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_events_producer ON session_events (producer_id, producer_epoch);

CREATE TABLE IF NOT EXISTS session_resources (
	id text PRIMARY KEY,
	session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	type text NOT NULL,
	file_id text,
	mount_path text,
	repo_url text,
	checkout_ref text,
	auth_token_credential_id text REFERENCES vault_credentials(id) ON DELETE SET NULL,
	mounted_at timestamp,
	removed_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_session_resources_session ON session_resources (session_id);

CREATE TABLE IF NOT EXISTS files (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	project_id text REFERENCES projects(id) ON DELETE CASCADE,
	name text NOT NULL,
	purpose text NOT NULL,
	scope_id text,
	content_type text,
	size_bytes integer NOT NULL DEFAULT 0,
	storage_ref text NOT NULL,
	sha1 text,
	created_at timestamp NOT NULL DEFAULT now(),
	archived_at timestamp,
	CONSTRAINT files_purpose_chk CHECK (purpose IN ('agent', 'output'))
);

ALTER TABLE files ADD COLUMN IF NOT EXISTS sha1 text;

CREATE INDEX IF NOT EXISTS idx_files_user ON files (user_id);
CREATE INDEX IF NOT EXISTS idx_files_scope ON files (scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_purpose ON files (purpose);
CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_scope_name_sha1 ON files (scope_id, name, sha1)
	WHERE scope_id IS NOT NULL AND sha1 IS NOT NULL;

CREATE TABLE IF NOT EXISTS file_payloads (
	storage_ref text PRIMARY KEY,
	payload_bytes bytea NOT NULL,
	created_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS agent_skill_registry ADD COLUMN IF NOT EXISTS project_id text;

DO $$
BEGIN
	IF to_regclass('public.agent_skill_registry') IS NOT NULL THEN
		CREATE INDEX IF NOT EXISTS idx_agent_skill_registry_project ON agent_skill_registry (project_id)
			WHERE project_id IS NOT NULL;
	END IF;
END $$;

DO $$
BEGIN
	IF to_regclass('public.workflow_workspace_sessions') IS NOT NULL
	   AND EXISTS (
		   SELECT 1
		   FROM information_schema.columns
		   WHERE table_schema = 'public'
		     AND table_name = 'workflow_workspace_sessions'
		     AND column_name = 'workflow_execution_id'
	   ) THEN
		ALTER TABLE workflow_workspace_sessions
			ALTER COLUMN workflow_execution_id DROP NOT NULL;
	END IF;
END $$;

ALTER TABLE IF EXISTS workflow_code_checkpoints
	DROP COLUMN IF EXISTS workflow_agent_event_id;

ALTER TABLE IF EXISTS workflow_executions
	DROP COLUMN IF EXISTS last_agent_event_id;

DROP TABLE IF EXISTS workflow_agent_events;

ALTER TABLE IF EXISTS code_functions
	ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'function',
	ADD COLUMN IF NOT EXISTS composition_graph jsonb;

ALTER TABLE IF EXISTS code_function_revisions
	ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'function',
	ADD COLUMN IF NOT EXISTS composition_graph jsonb;

DO $$
BEGIN
	IF to_regclass('public.code_functions') IS NOT NULL
	   AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_functions_role_check') THEN
		ALTER TABLE code_functions
			ADD CONSTRAINT code_functions_role_check CHECK (role IN ('function', 'workflow'));
	END IF;

	IF to_regclass('public.code_function_revisions') IS NOT NULL
	   AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_function_revisions_role_check') THEN
		ALTER TABLE code_function_revisions
			ADD CONSTRAINT code_function_revisions_role_check CHECK (role IN ('function', 'workflow'));
	END IF;
END $$;

CREATE OR REPLACE FUNCTION notify_session_event() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify(
		'session_events',
		json_build_object(
			'sessionId', NEW.session_id,
			'sequence', NEW.sequence,
			'id', NEW.id
		)::text
	);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_events_notify ON session_events;

CREATE TRIGGER trg_session_events_notify
	AFTER INSERT ON session_events
	FOR EACH ROW
	EXECUTE FUNCTION notify_session_event();

COMMIT;
