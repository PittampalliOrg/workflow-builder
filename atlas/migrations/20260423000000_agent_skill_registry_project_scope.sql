-- User-created custom skills. Today every row is a curated/registry entry
-- imported by an admin; here we widen sourceType to include "custom" rows
-- that any workspace member can author. Custom rows live in a workspace
-- (project_id set) and the list endpoint merges them with the global
-- curated catalog (project_id IS NULL). No backfill needed — every
-- existing row stays null.
ALTER TABLE agent_skill_registry
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_agent_skill_registry_project ON agent_skill_registry (project_id)
  WHERE project_id IS NOT NULL;
