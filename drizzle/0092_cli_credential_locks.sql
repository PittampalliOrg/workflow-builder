-- Boot-serialization lease for single-use-refresh CLI credentials (codex/openai).
-- codex rotates its OAuth refresh token on every boot-refresh; two concurrent
-- pods that both seed the SAME token both refresh it → the loser gets
-- "refresh token already used". This table serializes per-(user,provider) codex
-- boots: a session claims the lease at spawn (held across the spawn→capture gap)
-- and releases it when its capture lands (or it is stolen after a stale TTL).
CREATE TABLE IF NOT EXISTS "cli_credential_locks" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"holder_session_id" text NOT NULL,
	"acquired_at" timestamp NOT NULL DEFAULT now(),
	CONSTRAINT "cli_credential_locks_pkey" PRIMARY KEY ("user_id", "provider")
);
