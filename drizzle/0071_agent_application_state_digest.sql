ALTER TABLE "agent_versions"
	ADD COLUMN IF NOT EXISTS "application_state_digest" text;

CREATE INDEX IF NOT EXISTS "idx_agent_versions_state_digest"
	ON "agent_versions" ("application_state_digest")
	WHERE "application_state_digest" IS NOT NULL;
