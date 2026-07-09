-- Agent Teams: allow a lazily-formed team (derived team id) to hold tasks before
-- its `teams` row exists. A lead session derives team id `team-<sessionId>` and
-- may create_task before the first spawn_teammate calls ensureTeam. Drop the
-- team_tasks -> teams FK so create_task never FK-violates; team_members keeps its
-- FK because addMember always runs after ensureTeam. Idempotent.

DO $$ BEGIN
  ALTER TABLE "team_tasks" DROP CONSTRAINT "team_tasks_team_id_teams_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
