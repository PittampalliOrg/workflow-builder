-- Workflow-as-code support: distinguish single-function code_functions from
-- workflow-shaped ones (emitted via the visual→code exporter), and cache a
-- flat composition graph so callers can see which activity slugs a workflow
-- touches without re-parsing source.
--
-- role: 'function' (default, covers existing rows) or 'workflow'.
-- composition_graph: { activitySlugs: string[], hasFork: boolean, hasSwitch: boolean, hasDurableAgent: boolean }
--
-- Idempotent via IF NOT EXISTS so re-running in dev is safe.

ALTER TABLE code_functions
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'function',
  ADD COLUMN IF NOT EXISTS composition_graph JSONB;

ALTER TABLE code_function_revisions
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'function',
  ADD COLUMN IF NOT EXISTS composition_graph JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'code_functions_role_check'
  ) THEN
    ALTER TABLE code_functions
      ADD CONSTRAINT code_functions_role_check CHECK (role IN ('function', 'workflow'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'code_function_revisions_role_check'
  ) THEN
    ALTER TABLE code_function_revisions
      ADD CONSTRAINT code_function_revisions_role_check CHECK (role IN ('function', 'workflow'));
  END IF;
END $$;
