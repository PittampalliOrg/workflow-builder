-- Heal agents whose current-version `config.runtime` diverged from the agent-row
-- `runtime`. A UI "New agent" template path set the row runtime (e.g.
-- "claude-code-cli") but left config.runtime at the default "dapr-agent-py".
-- Spawn-time resolution reads config.runtime (resolveAgentRuntimeRoute + the
-- swap-safety gate), so the divergence dispatched CLI agents to the wrong
-- runtime and tripped the interaction-model reject. The write path is fixed in
-- registry.ts (config.runtime is now stamped from the row runtime on create +
-- update); this backfills already-persisted rows.
--
-- Idempotent: a no-op once runtimes match. Scoped to the CURRENT version (what
-- spawn dispatches by default); historical versions are left as authored.
UPDATE "agent_versions" AS av
SET "config" = jsonb_set(av."config", '{runtime}', to_jsonb(a."runtime"))
FROM "agents" AS a
WHERE av."id" = a."current_version_id"
  AND av."config" ->> 'runtime' IS DISTINCT FROM a."runtime";
