ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "runtime_app_id" text,
	ADD COLUMN IF NOT EXISTS "runtime_sandbox_name" text;

CREATE INDEX IF NOT EXISTS "idx_sessions_runtime_app_id"
	ON "sessions" ("runtime_app_id");

CREATE INDEX IF NOT EXISTS "idx_sessions_runtime_sandbox_name"
	ON "sessions" ("runtime_sandbox_name");
