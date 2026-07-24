-- Resume/fork seed provenance. Records the workspace a forked/resumed run was
-- seeded from so the run page can badge a snapshot-seeded fork ("forked from
-- snapshot @<node>"). A `.snapshots/<key>/<node>` value = a node-boundary
-- snapshot seed (durability phase 3); a bare workspace/instance key = an
-- end-state seed. NULL for normal (non-fork) runs.
ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "seed_workspace_from" text;
