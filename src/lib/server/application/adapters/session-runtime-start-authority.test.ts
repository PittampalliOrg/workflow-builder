import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CurrentSessionRepository } from "./sessions";

describe("CurrentSessionRepository session runtime start authority", () => {
  let client: PGlite;
  let repository: CurrentSessionRepository;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
			CREATE TABLE workflow_executions (
				id text PRIMARY KEY,
				dapr_instance_id text,
				status text NOT NULL,
				stop_requested_at timestamp,
				completed_at timestamp
			);
			CREATE TABLE sessions (
				id text PRIMARY KEY,
				status text NOT NULL,
				user_id text NOT NULL,
				project_id text,
				workflow_execution_id text,
				parent_execution_id text,
				dapr_instance_id text,
				runtime_app_id text,
				runtime_provisioning_started_at timestamp,
				stop_requested_at timestamp,
				completed_at timestamp
			);
			CREATE TABLE teams (
				id text PRIMARY KEY,
				workflow_execution_id text,
				lead_session_id text NOT NULL,
				status text NOT NULL DEFAULT 'active'
			);
			CREATE TABLE team_members (
				id text PRIMARY KEY,
				team_id text NOT NULL,
				session_id text NOT NULL UNIQUE,
				role text NOT NULL,
				status text NOT NULL
			);
			INSERT INTO workflow_executions (id, status)
			VALUES ('workflow-1', 'running');
			INSERT INTO sessions (
				id, status, user_id, project_id, workflow_execution_id,
				parent_execution_id, dapr_instance_id, runtime_app_id
			) VALUES
				('parent-1', 'running', 'user-1', 'project-1', 'workflow-1',
				 null, 'parent-1', 'agent-session-parent'),
				('child-1', 'rescheduling', 'user-1', 'project-1', 'workflow-1',
				 'parent-1', 'child-1', 'agent-session-parent');
		`);
    repository = new CurrentSessionRepository(drizzle(client) as never);
  });

  afterEach(async () => {
    await client.close();
  });

  const authorize = (
    team: {
      teamId: string | null;
      teamRole: "none" | "lead" | "member";
    } = { teamId: null, teamRole: "none" },
    runtimeAppId = "agent-session-parent",
    runtimeInstanceId = "child-1",
  ) =>
    repository.authorizeSessionRuntimeStart({
      sessionId: "child-1",
      runtimeAppId,
      runtimeInstanceId,
      userId: "user-1",
      projectId: "project-1",
      ...team,
    });

	it("authorizes an exact active child with published runtime and active lineage", async () => {
		await expect(authorize()).resolves.toEqual({ status: "authorized" });
		// An HTTP/activity retry is idempotent while the same lineage remains active.
		await expect(authorize()).resolves.toEqual({ status: "authorized" });
	});

	it.each(["dsw-workflow-1", "workflow-1"])(
		"authorizes root workflow lineage through %s",
		async (parentExecutionId) => {
			await client.exec(`
				UPDATE workflow_executions
				SET dapr_instance_id = 'dsw-workflow-1'
				WHERE id = 'workflow-1';
				UPDATE sessions
				SET parent_execution_id = '${parentExecutionId}'
				WHERE id = 'child-1'
			`);

			await expect(authorize()).resolves.toEqual({ status: "authorized" });
		},
	);

	it("fails closed for unknown parent lineage", async () => {
		await client.exec(`
			UPDATE workflow_executions
			SET dapr_instance_id = 'dsw-workflow-1'
			WHERE id = 'workflow-1';
			UPDATE sessions
			SET parent_execution_id = 'unknown-parent'
			WHERE id = 'child-1'
		`);

		await expect(authorize()).resolves.toEqual({ status: "parent_inactive" });
	});

	it("does not require a membership row for a signed team lead", async () => {
		await expect(
			authorize({ teamId: "future-team-1", teamRole: "lead" }),
		).resolves.toEqual({ status: "authorized" });
	});

  it("denies the stop-before-authorize side of the child race", async () => {
    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'child-1'",
    );
    await expect(authorize()).resolves.toEqual({ status: "inactive" });
  });

  it("denies when either linked parent authority has stopped", async () => {
    await client.exec(
      "UPDATE workflow_executions SET stop_requested_at = now() WHERE id = 'workflow-1'",
    );
    await expect(authorize()).resolves.toEqual({ status: "parent_inactive" });

    await client.exec(`
			UPDATE workflow_executions SET stop_requested_at = null WHERE id = 'workflow-1';
			UPDATE sessions SET stop_requested_at = now() WHERE id = 'parent-1';
		`);
    await expect(authorize()).resolves.toEqual({ status: "parent_inactive" });
  });

  it("requires a fully published target and exact workspace principal", async () => {
    await client.exec(
      "UPDATE sessions SET runtime_app_id = null WHERE id = 'child-1'",
    );
    await expect(authorize()).resolves.toEqual({
      status: "runtime_unpublished",
    });

    await expect(
      repository.authorizeSessionRuntimeStart({
        sessionId: "child-1",
        runtimeAppId: "agent-session-parent",
        runtimeInstanceId: "child-1",
        userId: "other-user",
        projectId: "project-1",
        teamId: null,
        teamRole: "none",
      }),
    ).resolves.toEqual({ status: "principal_mismatch" });
  });

  it("rejects a runtime generation that no longer matches the published target", async () => {
    await expect(authorize()).resolves.toEqual({ status: "authorized" });
    await client.exec(
      "UPDATE sessions SET runtime_app_id = 'agent-session-replacement' WHERE id = 'child-1'",
    );

    await expect(authorize()).resolves.toEqual({
      status: "runtime_superseded",
    });
    await expect(
      authorize(
        { teamId: null, teamRole: "none" },
        "agent-session-replacement",
      ),
    ).resolves.toEqual({ status: "authorized" });
  });

  it("rejects a late shared-pool generation after a newer instance is published", async () => {
    await client.exec(`
      UPDATE sessions
      SET runtime_app_id = 'agent-runtime-shared-pool',
          dapr_instance_id = 'session-runtime-gen2'
      WHERE id = 'child-1'
    `);

    await expect(
      authorize(
        { teamId: null, teamRole: "none" },
        "agent-runtime-shared-pool",
        "session-runtime-gen1",
      ),
    ).resolves.toEqual({ status: "runtime_superseded" });
    await expect(
      authorize(
        { teamId: null, teamRole: "none" },
        "agent-runtime-shared-pool",
        "session-runtime-gen2",
      ),
    ).resolves.toEqual({ status: "authorized" });
  });

  it("keeps an exact team child pending until membership promotion", async () => {
    await client.exec(`
			INSERT INTO teams (id, workflow_execution_id, lead_session_id)
			VALUES ('team-1', 'workflow-1', 'parent-1');
			INSERT INTO team_members (id, team_id, session_id, role, status)
			VALUES ('member-1', 'team-1', 'child-1', 'member', 'starting');
		`);
    const team = { teamId: "team-1", teamRole: "member" as const };

    await expect(authorize(team)).resolves.toEqual({ status: "team_pending" });
    await client.exec(
      "UPDATE team_members SET status = 'working' WHERE id = 'member-1'",
    );
    await expect(authorize(team)).resolves.toEqual({ status: "authorized" });
  });

  it("denies immediately when stop wins while team promotion is pending", async () => {
    await client.exec(`
			INSERT INTO teams (id, workflow_execution_id, lead_session_id)
			VALUES ('team-1', 'workflow-1', 'parent-1');
			INSERT INTO team_members (id, team_id, session_id, role, status)
			VALUES ('member-1', 'team-1', 'child-1', 'member', 'starting');
		`);
    const team = { teamId: "team-1", teamRole: "member" as const };

    await expect(authorize(team)).resolves.toEqual({ status: "team_pending" });
    await client.exec(`
			UPDATE sessions
			SET stop_requested_at = now(), runtime_app_id = null
			WHERE id = 'child-1'
		`);
    await expect(authorize(team)).resolves.toEqual({ status: "inactive" });
  });

  it("fails closed when a signed team child lost its exact reservation", async () => {
    await client.exec(`
			INSERT INTO teams (id, workflow_execution_id, lead_session_id)
			VALUES ('team-1', 'workflow-1', 'parent-1')
		`);
    await expect(
      authorize({ teamId: "team-1", teamRole: "member" }),
    ).resolves.toEqual({ status: "team_inactive" });
  });

  it("permits stop after authorization because the Dapr child already exists", async () => {
    await expect(authorize()).resolves.toEqual({ status: "authorized" });
    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'child-1'",
    );
    await expect(authorize()).resolves.toEqual({ status: "inactive" });
  });
});
