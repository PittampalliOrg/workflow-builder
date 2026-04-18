-- CMA-parity workspace scoping. Agents + environments were org-shared;
-- stamp each row with its creator's active project so the list queries
-- can filter by workspace (matches sessions + vaults which already do).
--
-- Backfill picks the row's createdBy user's JWT default project. If
-- createdBy is null (legacy import path), the row falls into the first
-- project in the same org — ensures every row has a valid FK target
-- before we add the NOT NULL constraint in a later migration.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;

-- Backfill: any row with a created_by user gets that user's current project.
UPDATE agents a
  SET project_id = u.project_id_fallback
  FROM (
    SELECT u.id AS user_id,
           COALESCE(
             (SELECT pm.project_id FROM project_members pm
               WHERE pm.user_id = u.id ORDER BY pm.created_at ASC LIMIT 1),
             (SELECT p.id FROM projects p
               WHERE p.platform_id = u.platform_id ORDER BY p.created_at ASC LIMIT 1)
           ) AS project_id_fallback
    FROM users u
  ) u
  WHERE a.created_by = u.user_id
    AND a.project_id IS NULL;

UPDATE environments e
  SET project_id = u.project_id_fallback
  FROM (
    SELECT u.id AS user_id,
           COALESCE(
             (SELECT pm.project_id FROM project_members pm
               WHERE pm.user_id = u.id ORDER BY pm.created_at ASC LIMIT 1),
             (SELECT p.id FROM projects p
               WHERE p.platform_id = u.platform_id ORDER BY p.created_at ASC LIMIT 1)
           ) AS project_id_fallback
    FROM users u
  ) u
  WHERE e.created_by = u.user_id
    AND e.project_id IS NULL;

-- Rows without createdBy or without a resolvable project: dump into the
-- oldest project overall. Prevents orphans during the transition.
UPDATE agents
  SET project_id = (SELECT id FROM projects ORDER BY created_at ASC LIMIT 1)
  WHERE project_id IS NULL;

UPDATE environments
  SET project_id = (SELECT id FROM projects ORDER BY created_at ASC LIMIT 1)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_environments_project ON environments (project_id)
  WHERE project_id IS NOT NULL;
