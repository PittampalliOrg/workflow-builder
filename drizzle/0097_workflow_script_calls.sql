-- Dynamic-script (engineType `dynamic-script`) call journal
-- (docs/dynamic-script-workflows). Additive + idempotent (hand-authored to match
-- the 0090 style; drizzle-kit generate needs a TTY for its conflict prompt and
-- this repo's meta snapshots are curated, not full-schema).
--
--   workflow_script_calls: one row per agent()/workflow() call issued by a
--     dynamic-script execution, keyed on (workflow_execution_id, call_id) so the
--     orchestrator's record_script_call_result activity UPSERTs idempotently
--     across Dapr replays. This is the resume-after-edit store — a fresh run
--     imports the `done` rows of a source run so unchanged calls resolve without
--     re-dispatching a session.
--   status: running | done | null | error | skipped.

CREATE TABLE IF NOT EXISTS "workflow_script_calls" (
  "workflow_execution_id" text NOT NULL,
  "call_id" text NOT NULL,
  "seq" integer NOT NULL,
  "kind" text DEFAULT 'agent' NOT NULL,
  "base_hash" text,
  "occurrence" integer DEFAULT 0 NOT NULL,
  "label" text,
  "phase" text,
  "prompt_sha256" text,
  "status" text NOT NULL,
  "session_id" text,
  "result" jsonb,
  "error_code" text,
  "retries" integer DEFAULT 0 NOT NULL,
  "tokens_used" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_script_calls_workflow_execution_id_call_id_pk" PRIMARY KEY ("workflow_execution_id", "call_id")
);

DO $$ BEGIN
  ALTER TABLE "workflow_script_calls" ADD CONSTRAINT "workflow_script_calls_workflow_execution_id_workflow_executions_id_fk"
    FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
