-- Agent Teams (Phase 1): lead + peer teammates, shared claimable task list.
-- Additive + idempotent, hand-authored to match the 0097 style (IF NOT EXISTS +
-- DO $$ duplicate_object guards; the repo's meta snapshots are curated). Messages
-- reuse session_events (type=user.message, origin=teammate-message|team-broadcast|
-- team-idle) with a deterministic source_event_id, so no message table is added.
--
--   teams:        one row per team, scoped to a lead session (+ optional execution).
--   team_members: addressable teammates (lead|member) with live status.
--   team_tasks:   shared work items; claimed via the FOR UPDATE SKIP LOCKED
--                 atomic claim in src/lib/server/teams/team-tasks.ts.

CREATE TABLE IF NOT EXISTS "teams" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_execution_id" text,
  "project_id" text NOT NULL,
  "name" text NOT NULL,
  "lead_session_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "token_budget" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL,
  "session_id" text NOT NULL,
  "agent_slug" text,
  "name" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "model" text,
  "status" text DEFAULT 'working' NOT NULL,
  "plan_mode_required" boolean DEFAULT false NOT NULL,
  "joined_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "team_members_team_id_name_uq" UNIQUE ("team_id","name"),
  CONSTRAINT "team_members_session_uq" UNIQUE ("session_id")
);

CREATE TABLE IF NOT EXISTS "team_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "assignee_session_id" text,
  "depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_session_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" ("team_id");
CREATE INDEX IF NOT EXISTS "teams_lead_session_idx" ON "teams" ("lead_session_id");
CREATE INDEX IF NOT EXISTS "team_tasks_team_status_idx" ON "team_tasks" ("team_id","status");

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_workflow_execution_id_workflow_executions_id_fk"
    FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_team_id_teams_id_fk"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
