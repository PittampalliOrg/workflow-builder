-- Phase 3 of the CMA-mirror refactor: sessions + session_events +
-- session_resources. A session is one agent run — multi-turn, long-lived,
-- event-streamed. Pinned to an agent version and an environment version at
-- create time. Events flow user→agent via Dapr external events and
-- agent→user via NATS → SSE; everything persists here for replay +
-- reconnect-without-loss.

CREATE TABLE "sessions" (
  "id" text NOT NULL,
  "title" text NULL,
  "status" text NOT NULL DEFAULT 'rescheduling',
  "stop_reason" jsonb NULL,
  "agent_id" text NOT NULL,
  "agent_version" integer NULL,
  "environment_id" text NULL,
  "environment_version" integer NULL,
  "vault_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "dapr_instance_id" text NULL,
  "nats_subject" text NULL,
  "workflow_execution_id" text NULL,
  "parent_execution_id" text NULL,
  "user_id" text NOT NULL,
  "project_id" text NULL,
  "usage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error_message" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp NULL,
  "archived_at" timestamp NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id")
    REFERENCES "agents" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT "sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id")
    REFERENCES "environments" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX "idx_sessions_agent" ON "sessions" ("agent_id");
CREATE INDEX "idx_sessions_user" ON "sessions" ("user_id");
CREATE INDEX "idx_sessions_status" ON "sessions" ("status");
CREATE INDEX "idx_sessions_created" ON "sessions" ("created_at");
CREATE INDEX "idx_sessions_workflow_execution" ON "sessions" ("workflow_execution_id");

CREATE TABLE "session_events" (
  "id" text NOT NULL,
  "session_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "processed_at" timestamp NULL,
  "source_event_id" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_session_event_sequence" UNIQUE ("session_id", "sequence"),
  CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id")
    REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX "idx_session_events_session" ON "session_events" ("session_id");
CREATE INDEX "idx_session_events_type" ON "session_events" ("type");
CREATE INDEX "idx_session_events_created" ON "session_events" ("created_at");

CREATE TABLE "session_resources" (
  "id" text NOT NULL,
  "session_id" text NOT NULL,
  "type" text NOT NULL,
  "file_id" text NULL,
  "mount_path" text NULL,
  "repo_url" text NULL,
  "checkout_ref" text NULL,
  "auth_token_credential_id" text NULL,
  "mounted_at" timestamp NULL,
  "removed_at" timestamp NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "session_resources_session_id_sessions_id_fk" FOREIGN KEY ("session_id")
    REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "session_resources_auth_token_credential_id_vault_credentials_id_fk"
    FOREIGN KEY ("auth_token_credential_id")
    REFERENCES "vault_credentials" ("id")
    ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX "idx_session_resources_session" ON "session_resources" ("session_id");
