-- Migration: Add observability enhancements
-- Phase 1: Database schema extensions for workflow observability

-- 1. Extend workflow_execution_logs with timing breakdown columns
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "credential_fetch_ms" integer;
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "routing_ms" integer;
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "cold_start_ms" integer;
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "execution_ms" integer;
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "routed_to" text;
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "was_cold_start" boolean;

-- 2. Create credential_access_logs table for compliance/debugging
CREATE TABLE IF NOT EXISTS "credential_access_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"integration_type" text NOT NULL,
	"credential_keys" jsonb NOT NULL,
	"source" text NOT NULL,
	"fallback_attempted" boolean DEFAULT false,
	"fallback_reason" text,
	"accessed_at" timestamp DEFAULT now() NOT NULL
);

-- Add foreign key constraint for credential_access_logs
DO $$ BEGIN
	ALTER TABLE "credential_access_logs" ADD CONSTRAINT "credential_access_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

-- 3. Create workflow_external_events table for approval audit trail
CREATE TABLE IF NOT EXISTS "workflow_external_events" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"event_name" text NOT NULL,
	"event_type" text NOT NULL,
	"requested_at" timestamp,
	"timeout_seconds" integer,
	"expires_at" timestamp,
	"responded_at" timestamp,
	"approved" boolean,
	"reason" text,
	"responded_by" text,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Add foreign key constraint for workflow_external_events
DO $$ BEGIN
	ALTER TABLE "workflow_external_events" ADD CONSTRAINT "workflow_external_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS "credential_access_logs_execution_id_idx" ON "credential_access_logs" ("execution_id");
CREATE INDEX IF NOT EXISTS "credential_access_logs_accessed_at_idx" ON "credential_access_logs" ("accessed_at");

CREATE INDEX IF NOT EXISTS "workflow_external_events_execution_id_idx" ON "workflow_external_events" ("execution_id");
CREATE INDEX IF NOT EXISTS "workflow_external_events_event_name_idx" ON "workflow_external_events" ("event_name");
CREATE INDEX IF NOT EXISTS "workflow_external_events_created_at_idx" ON "workflow_external_events" ("created_at");
