-- D1 per-PR preview pipeline records (label-gated PR previews). Durable so the
-- status polled by the hub Tekton dispatch Task reads the SAME record from ANY
-- BFF replica, and a Deployment rollout mid-run leaves a resumable record
-- instead of a silently forever-pending commit status. One row per PR; deleted
-- on teardown; a stale non-terminal row is atomically claimed for resume.
CREATE TABLE IF NOT EXISTS "pr_previews" (
	"pr_number" integer PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"url" text,
	"state" text NOT NULL,
	"head_sha" text,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"verify" jsonb,
	"owner_gen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
