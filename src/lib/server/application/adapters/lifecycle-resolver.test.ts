import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresLifecycleTargetResolver } from "./lifecycle-resolver";
import {
  sessionRuntimeGenerationAppId,
  sessionRuntimeGenerationInstanceId,
} from "$lib/server/lifecycle/resolvers";

describe("Postgres lifecycle stop intent", () => {
  let client: PGlite;
  let resolveTarget: ReturnType<typeof createPostgresLifecycleTargetResolver>;
  let loggedQueries: Array<{ query: string; params: unknown[] }>;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
			CREATE TABLE workflow_executions (
				id text PRIMARY KEY,
				user_id text NOT NULL,
				project_id text,
				status text NOT NULL,
				phase text,
				progress integer,
				output jsonb,
				summary_output jsonb,
				dapr_instance_id text,
				stop_requested_at timestamp,
				stop_requested_mode text,
				stop_reason text,
				error text,
				completed_at timestamp
			);
			CREATE TABLE sessions (
				id text PRIMARY KEY,
				user_id text NOT NULL,
				project_id text,
				agent_id text,
				status text NOT NULL,
				workflow_execution_id text,
				dapr_instance_id text,
				workspace_sandbox_name text,
				runtime_app_id text,
					runtime_sandbox_name text,
					runtime_host_owned boolean NOT NULL DEFAULT true,
					runtime_host_cleanup_completed_at timestamp,
					runtime_provisioning_started_at timestamp,
					runtime_provisioning_app_id text,
					runtime_provisioning_instance_id text,
					runtime_provisioning_sandbox_name text,
					runtime_provisioning_host_owned boolean,
					runtime_provisioning_host_launch_spec jsonb,
				stop_requested_at timestamp,
				stop_requested_mode text,
				stop_reason jsonb,
				completed_at timestamp,
				updated_at timestamp NOT NULL DEFAULT now()
			);
			CREATE TABLE workflow_agent_runs (
				id text PRIMARY KEY,
				workflow_execution_id text,
				dapr_instance_id text,
				agent_workflow_id text,
				status text,
				error text,
				completed_at timestamp,
				updated_at timestamp NOT NULL DEFAULT now()
			);
			CREATE TABLE workflow_workspace_sessions (
				workspace_ref text PRIMARY KEY,
				workflow_execution_id text,
				backend text NOT NULL,
				status text,
				cleaned_at timestamp,
				updated_at timestamp NOT NULL DEFAULT now()
			);
			CREATE TABLE evaluation_runs (
				id text PRIMARY KEY,
				status text NOT NULL,
				cancel_requested_at timestamp,
				coordinator_execution_id text
			);
			INSERT INTO sessions (
				id, user_id, project_id, status, dapr_instance_id,
				runtime_app_id, runtime_sandbox_name
			) VALUES (
				'session-1', 'user-1', 'project-1', 'running', 'session-1',
				'agent-session-1', 'agent-host-agent-session-1'
			);
		`);
    loggedQueries = [];
    resolveTarget = createPostgresLifecycleTargetResolver(
      drizzle(client, {
        logger: {
          logQuery(query, params) {
            loggedQueries.push({ query, params });
          },
        },
      }) as never,
    );
  });

  afterEach(async () => {
    await client.close();
  });

  async function sessionIntent() {
    const result = await client.query<{
      stop_requested_at: Date | null;
      stop_requested_mode: string | null;
      status: string;
    }>(`
			SELECT stop_requested_at, stop_requested_mode, status
			FROM sessions WHERE id = 'session-1'
		`);
    return result.rows[0];
  }

  it("escalates modes monotonically and treats a legacy null mode as terminate", async () => {
    let target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.markStopRequested("stop", "terminate"),
    ).resolves.toMatchObject({
      mode: "terminate",
    });
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.markStopRequested("clean", "purge"),
    ).resolves.toMatchObject({
      mode: "purge",
    });
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.markStopRequested("weaker retry", "terminate"),
    ).resolves.toMatchObject({
      mode: "purge",
    });
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.markStopRequested("reset", "reset"),
    ).resolves.toMatchObject({
      mode: "reset",
    });
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.markStopRequested("weaker purge", "purge"),
    ).resolves.toMatchObject({
      mode: "reset",
    });

    await client.exec(`
			UPDATE sessions
			SET stop_requested_at = now(), stop_requested_mode = NULL
			WHERE id = 'session-1'
		`);
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.markStopRequested("legacy retry", "terminate"),
    ).resolves.toMatchObject({
      mode: "terminate",
    });
  });

  it("keeps a legacy deterministic host reservation unresolved until its Sandbox is published", async () => {
    await client.exec(`
			UPDATE sessions SET runtime_sandbox_name = NULL WHERE id = 'session-1'
		`);

    const target = await resolveTarget({ kind: "session", id: "session-1" });

    expect(target.unresolvedRuntimeLinkages).toEqual(["session-1"]);
    expect(target.agentRuntimeTargets).toEqual([
      {
        runtimeAppId: "agent-session-1",
        instanceId: "session-1",
        runtimeSandboxName: "agent-host-agent-session-1",
      },
    ]);
  });

  it("resolves the old target and generation-specific prospective target for an active lease", async () => {
    const startedAt = new Date("2026-07-21T12:00:00Z");
    const prospectiveAppId = sessionRuntimeGenerationAppId(
      "session-1",
      startedAt,
    );
    const prospectiveInstanceId = sessionRuntimeGenerationInstanceId(
      "session-1",
      startedAt,
    );
    await client.exec(`
			UPDATE sessions SET
				runtime_app_id = 'agent-runtime-old',
				runtime_sandbox_name = 'agent-host-old',
				runtime_provisioning_started_at = '2026-07-21T12:00:00Z'
			WHERE id = 'session-1'
		`);

    const target = await resolveTarget({ kind: "session", id: "session-1" });

    expect(target.unresolvedRuntimeLinkages).toEqual(["session-1"]);
    expect(target.runtimeProvisioningLeases).toEqual([
      {
        sessionId: "session-1",
        startedAt,
        prospectiveTarget: {
          runtimeAppId: prospectiveAppId,
          instanceId: prospectiveInstanceId,
          runtimeSandboxName: `agent-host-${prospectiveAppId}`,
        },
      },
    ]);
    expect(target.agentRuntimeTargets).toEqual([
      {
        runtimeAppId: "agent-runtime-old",
        instanceId: "session-1",
        runtimeSandboxName: "agent-host-old",
      },
      target.runtimeProvisioningLeases[0].prospectiveTarget,
    ]);
  });

	it("resolves an accepted shared-pool crash window from its staged target", async () => {
		const startedAt = new Date("2026-07-21T12:00:00Z");
		const instanceId = sessionRuntimeGenerationInstanceId(
			"session-1",
			startedAt,
		);
		await client.exec(`
			UPDATE sessions SET
				runtime_app_id = NULL,
				runtime_sandbox_name = NULL,
				dapr_instance_id = NULL,
				runtime_provisioning_started_at = '2026-07-21T12:00:00Z',
				runtime_provisioning_app_id = 'agent-runtime-browser-pool',
				runtime_provisioning_instance_id = '${instanceId}',
				runtime_provisioning_sandbox_name = NULL,
				runtime_provisioning_host_owned = false
			WHERE id = 'session-1'
		`);

		const target = await resolveTarget({ kind: "session", id: "session-1" });

		expect(target.runtimeProvisioningLeases).toEqual([
			{
				sessionId: "session-1",
				startedAt,
				prospectiveTarget: {
					runtimeAppId: "agent-runtime-browser-pool",
					instanceId,
					runtimeSandboxName: null,
					ownsRuntimeSandbox: false,
				},
			},
		]);
		expect(target.agentRuntimeTargets).toEqual([
			target.runtimeProvisioningLeases[0].prospectiveTarget,
		]);
		expect(target.sandboxNames).toEqual([]);
	});

	it("resolves a dedicated crash-window Sandbox from its staged target", async () => {
		const startedAt = new Date("2026-07-21T12:00:00Z");
		const instanceId = sessionRuntimeGenerationInstanceId(
			"session-1",
			startedAt,
		);
		await client.exec(`
			UPDATE sessions SET
				runtime_app_id = NULL,
				runtime_sandbox_name = NULL,
				dapr_instance_id = NULL,
				runtime_provisioning_started_at = '2026-07-21T12:00:00Z',
				runtime_provisioning_app_id = 'agent-session-exact',
				runtime_provisioning_instance_id = '${instanceId}',
				runtime_provisioning_sandbox_name = 'agent-host-agent-session-exact',
				runtime_provisioning_host_owned = true
			WHERE id = 'session-1'
		`);

		const target = await resolveTarget({ kind: "session", id: "session-1" });
		expect(target.runtimeProvisioningLeases[0]?.prospectiveTarget).toEqual({
			runtimeAppId: "agent-session-exact",
			instanceId,
			runtimeSandboxName: "agent-host-agent-session-exact",
		});
		expect(target.sandboxNames).toEqual([
			"agent-host-agent-session-exact",
		]);
	});

  it("deduplicates a prospective target that was already published", async () => {
    const startedAt = new Date("2026-07-21T12:00:00Z");
    const appId = sessionRuntimeGenerationAppId("session-1", startedAt);
    const instanceId = sessionRuntimeGenerationInstanceId(
      "session-1",
      startedAt,
    );
    await client.exec(`
				UPDATE sessions SET
					runtime_app_id = '${appId}',
					runtime_sandbox_name = 'agent-host-${appId}',
					dapr_instance_id = '${instanceId}',
					runtime_provisioning_started_at = '2026-07-21T12:00:00Z'
			WHERE id = 'session-1'
		`);

    const target = await resolveTarget({ kind: "session", id: "session-1" });
    expect(target.agentRuntimeTargets).toHaveLength(1);
    expect(target.runtimeProvisioningLeases).toHaveLength(1);
  });

  it("retains independently aged leases for multiple workflow children", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, dapr_instance_id
			) VALUES ('workflow-leases', 'user-1', 'project-1', 'running', 'workflow-leases');
			UPDATE sessions SET
				workflow_execution_id = 'workflow-leases',
				runtime_provisioning_started_at = '2026-07-21T12:00:00Z'
			WHERE id = 'session-1';
			INSERT INTO sessions (
				id, user_id, project_id, status, workflow_execution_id,
				dapr_instance_id, runtime_provisioning_started_at
			) VALUES (
				'session-2', 'user-1', 'project-1', 'running', 'workflow-leases',
				'session-2', '2026-07-21T12:05:00Z'
			);
		`);

    const target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-leases",
    });
    expect(
      target.runtimeProvisioningLeases
        .map((lease) => ({
          sessionId: lease.sessionId,
          startedAt: lease.startedAt,
        }))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    ).toEqual([
      { sessionId: "session-1", startedAt: new Date("2026-07-21T12:00:00Z") },
      { sessionId: "session-2", startedAt: new Date("2026-07-21T12:05:00Z") },
    ]);
    expect(target.unresolvedRuntimeLinkages).toHaveLength(2);
    expect(target.unresolvedRuntimeLinkages).toEqual(
      expect.arrayContaining(["session-1", "session-2"]),
    );
  });

  it("acknowledges only the exact stopped provisioning generation", async () => {
    const startedAt = new Date("2026-07-21T12:00:00Z");
    await client.exec(`
      UPDATE sessions
      SET runtime_provisioning_started_at = '2026-07-21T12:00:00Z',
		  runtime_provisioning_app_id = 'shared-runtime',
		  runtime_provisioning_instance_id = 'staged-instance',
		  runtime_provisioning_sandbox_name = NULL,
		  runtime_provisioning_host_owned = false
      WHERE id = 'session-1'
    `);
    const target = await resolveTarget({ kind: "session", id: "session-1" });

    await expect(
      target.acknowledgeRuntimeProvisioningCompensation(
        "session-1",
        startedAt,
      ),
    ).resolves.toBe(false);
    await target.markStopRequested("operator stop", "terminate");
    await expect(
      target.acknowledgeRuntimeProvisioningCompensation(
        "session-1",
        new Date("2026-07-21T11:59:59Z"),
      ),
    ).resolves.toBe(false);
    await expect(
      target.acknowledgeRuntimeProvisioningCompensation(
        "different-session",
        startedAt,
      ),
    ).resolves.toBe(false);
    await expect(
      target.acknowledgeRuntimeProvisioningCompensation(
        "session-1",
        startedAt,
      ),
    ).resolves.toBe(true);
		const cleared = await client.query<{
			runtime_provisioning_started_at: Date | null;
			runtime_provisioning_app_id: string | null;
			runtime_provisioning_instance_id: string | null;
			runtime_provisioning_sandbox_name: string | null;
			runtime_provisioning_host_owned: boolean | null;
		}>(`
			SELECT runtime_provisioning_started_at,
			       runtime_provisioning_app_id,
			       runtime_provisioning_instance_id,
			       runtime_provisioning_sandbox_name,
			       runtime_provisioning_host_owned
			FROM sessions WHERE id = 'session-1'
		`);
		expect(cleared.rows[0]).toEqual({
			runtime_provisioning_started_at: null,
			runtime_provisioning_app_id: null,
			runtime_provisioning_instance_id: null,
			runtime_provisioning_sandbox_name: null,
			runtime_provisioning_host_owned: null,
		});
    await expect(
      target.acknowledgeRuntimeProvisioningCompensation(
        "session-1",
        startedAt,
      ),
    ).resolves.toBe(false);
  });

  it("does not treat a published shared target as provisioning", async () => {
    await client.exec(`
			UPDATE sessions SET
				runtime_app_id = 'shared-agent-runtime',
				runtime_sandbox_name = NULL,
				runtime_provisioning_started_at = NULL
			WHERE id = 'session-1'
		`);

    const target = await resolveTarget({ kind: "session", id: "session-1" });
    expect(target.unresolvedRuntimeLinkages).toEqual([]);
    expect(target.runtimeProvisioningLeases).toEqual([]);
    expect(target.agentRuntimeTargets).toEqual([
      {
        runtimeAppId: "shared-agent-runtime",
        instanceId: "session-1",
        runtimeSandboxName: null,
      },
    ]);
  });

	  it("routes a borrowed native peer without owning its parent Sandbox", async () => {
	    await client.exec(`
	      UPDATE sessions SET
	        runtime_app_id = 'agent-session-parent',
	        runtime_sandbox_name = 'agent-host-parent',
	        runtime_host_owned = false,
	        runtime_provisioning_started_at = NULL
	      WHERE id = 'session-1'
	    `);

	    const target = await resolveTarget({ kind: "session", id: "session-1" });
	    expect(target.agentRuntimeTargets).toEqual([
	      {
	        runtimeAppId: "agent-session-parent",
	        instanceId: "session-1",
	        runtimeSandboxName: "agent-host-parent",
	        ownsRuntimeSandbox: false,
	      },
	    ]);
	    expect(target.sandboxNames).toEqual([]);
	  });

  it("does not classify a script-team lead anchor as runtime provisioning", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, dapr_instance_id
			) VALUES ('workflow-team', 'user-1', 'project-1', 'running', 'workflow-team');
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES (
				'script-lead-workflow-team', 'user-1', 'project-1',
				'script-team-lead', 'idle', 'workflow-team'
			);
		`);

    const workflowTarget = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-team",
    });
    expect(workflowTarget.unresolvedRuntimeLinkages).toEqual([]);
    expect(workflowTarget.runtimeProvisioningLeases).toEqual([]);
    expect(workflowTarget.agentRuntimeTargets).toEqual([]);

    const sessionTarget = await resolveTarget({
      kind: "session",
      id: "script-lead-workflow-team",
    });
    expect(sessionTarget.dbActive).toBe(true);
    expect(sessionTarget.unresolvedRuntimeLinkages).toEqual([]);
    expect(sessionTarget.runtimeProvisioningLeases).toEqual([]);
    expect(sessionTarget.agentRuntimeTargets).toEqual([]);
  });

  it("does not let a stale lease make a crash-finalized session active", async () => {
    await client.exec(`
			UPDATE sessions SET
				status = 'failed',
				completed_at = now(),
				runtime_provisioning_started_at = now()
			WHERE id = 'session-1'
		`);

    const target = await resolveTarget({ kind: "session", id: "session-1" });
    expect(target.dbActive).toBe(false);
    expect(target.runtimeProvisioningLeases).toEqual([]);
    expect(target.unresolvedRuntimeLinkages).toEqual([]);
  });

  it("resolves a session-owned workspace Sandbox for lifecycle cleanup", async () => {
    await client.exec(`
			UPDATE sessions
			SET workspace_sandbox_name = 'workspace-session-1'
			WHERE id = 'session-1'
		`);

    const target = await resolveTarget({ kind: "session", id: "session-1" });
    expect(target.workspaceSandboxNames).toEqual(["workspace-session-1"]);
    expect(target.workspaceRetentionIdentities).toEqual([
      {
        durableExecutionId: "session-1",
        databaseExecutionId: null,
      },
    ]);
    expect(target.workspaceCleanupExecutionIds).toEqual([]);
  });

  it("resolves only active OpenShell workflow workspaces", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, dapr_instance_id
			) VALUES ('workflow-1', 'user-1', 'project-1', 'running', 'workflow-1');
			UPDATE sessions
			SET workflow_execution_id = 'workflow-1',
				workspace_sandbox_name = 'workspace-session-1'
			WHERE id = 'session-1';
			INSERT INTO workflow_workspace_sessions (
				workspace_ref, workflow_execution_id, backend, status
			) VALUES
				('openshell-workspace', 'workflow-1', 'openshell', 'active'),
				('juicefs-workspace', 'workflow-1', 'juicefs', 'active'),
				('cleaned-openshell-workspace', 'workflow-1', 'openshell', 'cleaned');
		`);

    const target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-1",
    });
    expect(target.workspaceSandboxNames).toEqual(["workspace-session-1"]);
    expect(target.workspaceRetentionIdentities).toEqual([
      {
        durableExecutionId: "workflow-1",
        databaseExecutionId: "workflow-1",
      },
      {
        durableExecutionId: "session-1",
        databaseExecutionId: "workflow-1",
      },
    ]);
    expect(target.workspaceCleanupExecutionIds).toEqual(["workflow-1"]);
  });

  it("keeps cancellation authoritative over a terminal projection written after stop intent", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, phase, progress, dapr_instance_id,
				output, summary_output
			) VALUES (
				'workflow-stop-race', 'user-1', 'project-1', 'running', 'running', 40,
				'workflow-stop-race',
				'{"success":true,"outputs":{"returnValue":{"completedNaturally":true}},"workflowOutput":{"completedNaturally":true},"durationMs":123,"phase":"completed"}',
				'{"result":"natural completion"}'
			)
		`);

    let target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-stop-race",
    });
    const intent = await target.markStopRequested("Stopped by user", "terminate");
    const staleCompletedAt = new Date(intent.requestedAt.getTime() + 1_000);
    await client.query(
      `UPDATE workflow_executions
       SET status = 'success', phase = 'completed', progress = 100,
           completed_at = $1
       WHERE id = 'workflow-stop-race'`,
      [staleCompletedAt],
    );

    target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-stop-race",
    });
    await expect(
      target.finalizeDb("Stopped by user", "terminated", "terminate"),
    ).resolves.toBe("finalized");

    const result = await client.query<{
      status: string;
      phase: string | null;
      progress: number | null;
      stop_requested_at: Date | null;
      stop_requested_mode: string | null;
      stop_reason: string | null;
			output: Record<string, unknown> | null;
			summary_output: Record<string, unknown> | null;
    }>(`
      SELECT status, phase, progress, stop_requested_at, stop_requested_mode,
					 stop_reason, output, summary_output
      FROM workflow_executions
      WHERE id = 'workflow-stop-race'
    `);
    expect(result.rows[0]).toMatchObject({
      status: "cancelled",
      phase: "cancelled",
      progress: 100,
      stop_requested_at: null,
	      stop_requested_mode: "terminate",
      stop_reason: "Stopped by user",
			output: {
				success: false,
				outputs: null,
				workflowOutput: null,
				durationMs: 123,
				phase: "cancelled",
				error: "Stopped by user",
			},
			summary_output: null,
    });
  });

	it("canonicalizes an already-cancelled rolling-version row while finalizing its stop", async () => {
		await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, phase, progress, dapr_instance_id,
				output, summary_output, stop_requested_at, stop_requested_mode,
				stop_reason
			) VALUES (
				'workflow-legacy-cancelled', 'user-1', 'project-1', 'cancelled',
				'completed', 100, 'workflow-legacy-cancelled',
				'{"success":true,"outputs":{"returnValue":{"completedNaturally":true}},"workflowOutput":{"completedNaturally":true}}',
				'{"result":"natural completion"}', now(), 'terminate', 'Stopped by user'
			)
		`);

		const target = await resolveTarget({
			kind: "workflowExecution",
			id: "workflow-legacy-cancelled",
		});
		await expect(
			target.finalizeDb("Stopped by user", "terminated", "terminate"),
		).resolves.toBe("finalized");

		const result = await client.query<{
			status: string;
			phase: string | null;
			output: Record<string, unknown> | null;
			summary_output: Record<string, unknown> | null;
			stop_requested_at: Date | null;
			stop_requested_mode: string | null;
		}>(`
			SELECT status, phase, output, summary_output, stop_requested_at,
			       stop_requested_mode
			FROM workflow_executions
			WHERE id = 'workflow-legacy-cancelled'
		`);
		expect(result.rows[0]).toEqual({
			status: "cancelled",
			phase: "cancelled",
			output: {
				success: false,
				outputs: null,
				workflowOutput: null,
				durationMs: null,
				phase: "cancelled",
				error: "Stopped by user",
			},
			summary_output: null,
			stop_requested_at: null,
			stop_requested_mode: "terminate",
		});
	});

	it("keeps stop intent pending when scheduler linkage changes after target refresh", async () => {
		await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, phase, progress, dapr_instance_id
			) VALUES (
				'workflow-late-link', 'user-1', 'project-1', 'running', 'running', 20,
				'placeholder-instance'
			)
		`);

		let target = await resolveTarget({
			kind: "workflowExecution",
			id: "workflow-late-link",
		});
		await target.markStopRequested("Stopped by user", "terminate");
		target = await resolveTarget({
			kind: "workflowExecution",
			id: "workflow-late-link",
		});
		expect(target.parentInstanceIds).toEqual(["placeholder-instance"]);

		await client.exec(`
			UPDATE workflow_executions
			SET dapr_instance_id = 'late-real-instance'
			WHERE id = 'workflow-late-link'
		`);
		await expect(
			target.finalizeDb("Stopped by user", "terminated", "terminate"),
		).resolves.toBe("mode_changed");

		let persisted = await client.query<{
			status: string;
			stop_requested_at: Date | null;
		}>(`
			SELECT status, stop_requested_at
			FROM workflow_executions
			WHERE id = 'workflow-late-link'
		`);
		expect(persisted.rows[0]).toMatchObject({
			status: "running",
			stop_requested_at: expect.any(Date),
		});

		target = await resolveTarget({
			kind: "workflowExecution",
			id: "workflow-late-link",
		});
		expect(target.parentInstanceIds).toEqual(["late-real-instance"]);
		await expect(
			target.finalizeDb("Stopped by user", "terminated", "terminate"),
		).resolves.toBe("finalized");
		persisted = await client.query<{
			status: string;
			stop_requested_at: Date | null;
		}>(`
			SELECT status, stop_requested_at
			FROM workflow_executions
			WHERE id = 'workflow-late-link'
		`);
		expect(persisted.rows[0]).toEqual({
			status: "cancelled",
			stop_requested_at: null,
		});
	});

	it("does not turn a terminal result into cancellation during no-intent repair", async () => {
		await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, phase, progress, dapr_instance_id,
				completed_at, output
			) VALUES (
				'workflow-no-intent-terminal', 'user-1', 'project-1', 'success',
				'completed', 100, 'workflow-no-intent-terminal', now(),
				'{"success":true,"workflowOutput":{"completedNaturally":true}}'
			)
		`);

		const target = await resolveTarget({
			kind: "workflowExecution",
			id: "workflow-no-intent-terminal",
		});
		await expect(target.finalizeDb("repair", "terminated")).resolves.toBe(
			"finalized",
		);

		const result = await client.query<{
			status: string;
			phase: string | null;
			output: Record<string, unknown> | null;
		}>(`
			SELECT status, phase, output
			FROM workflow_executions
			WHERE id = 'workflow-no-intent-terminal'
		`);
		expect(result.rows[0]).toEqual({
			status: "success",
			phase: "completed",
			output: {
				success: true,
				workflowOutput: { completedNaturally: true },
			},
		});
	});

  it("preserves a natural completion that predates a later cleanup stop", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, phase, progress, dapr_instance_id,
				completed_at
			) VALUES (
				'workflow-completed-first', 'user-1', 'project-1', 'success',
				'completed', 100, 'workflow-completed-first',
				'2026-01-01T00:00:00Z'
			)
		`);

    let target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-completed-first",
    });
    await target.markStopRequested("cleanup terminal run", "terminate");
    target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-completed-first",
    });
    await expect(
      target.finalizeDb("cleanup terminal run", "terminated", "terminate"),
    ).resolves.toBe("finalized");

    const result = await client.query<{
      status: string;
      phase: string | null;
      stop_requested_at: Date | null;
      stop_reason: string | null;
    }>(`
      SELECT status, phase, stop_requested_at, stop_reason
      FROM workflow_executions
      WHERE id = 'workflow-completed-first'
    `);
    expect(result.rows[0]).toMatchObject({
      status: "success",
      phase: "completed",
      stop_requested_at: null,
      stop_reason: "cleanup terminal run",
    });
  });

  it("preserves workflow workspace state on terminate and cleans it on purge", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, dapr_instance_id
			) VALUES ('workflow-1', 'user-1', 'project-1', 'running', 'workflow-1');
			INSERT INTO workflow_workspace_sessions (
				workspace_ref, workflow_execution_id, backend, status
			) VALUES ('openshell-workspace', 'workflow-1', 'openshell', 'active');
		`);

    let target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-1",
    });
    await target.markStopRequested("stop", "terminate");
    target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-1",
    });
    await expect(
      target.finalizeDb("stopped", "terminated", "terminate"),
    ).resolves.toBe("finalized");
    let workspace = await client.query<{
      status: string;
      cleaned_at: Date | null;
    }>(`
			SELECT status, cleaned_at
			FROM workflow_workspace_sessions
			WHERE workspace_ref = 'openshell-workspace'
		`);
    expect(workspace.rows[0]).toMatchObject({
      status: "active",
      cleaned_at: null,
    });

    target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-1",
    });
    await target.markStopRequested("clean", "purge");
    target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-1",
    });
    await expect(
      target.finalizeDb("cleaned", "terminated", "purge"),
    ).resolves.toBe("finalized");
    workspace = await client.query<{
      status: string;
      cleaned_at: Date | null;
    }>(`
			SELECT status, cleaned_at
			FROM workflow_workspace_sessions
			WHERE workspace_ref = 'openshell-workspace'
		`);
    expect(workspace.rows[0]?.status).toBe("cleaned");
    expect(workspace.rows[0]?.cleaned_at).toBeInstanceOf(Date);
  });

  it("keeps an escalated intent pending when a weaker finalizer loses its mode fence", async () => {
    let target = await resolveTarget({ kind: "session", id: "session-1" });
    await target.markStopRequested("stop", "terminate");
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await client.exec(`
			UPDATE sessions SET stop_requested_mode = 'reset' WHERE id = 'session-1'
		`);

    await expect(
      target.finalizeDb("stopped", "terminated", "terminate"),
    ).resolves.toBe("mode_changed");
    await expect(sessionIntent()).resolves.toMatchObject({
      status: "running",
      stop_requested_mode: "reset",
    });

    target = await resolveTarget({ kind: "session", id: "session-1" });
    await expect(
      target.finalizeDb("reset complete", "terminated", "reset"),
    ).resolves.toBe("finalized");
    await expect(sessionIntent()).resolves.toMatchObject({
      status: "terminated",
      stop_requested_at: null,
      stop_requested_mode: null,
    });
    const cleanup = await client.query<{
      runtime_host_cleanup_completed_at: Date | null;
    }>(`
			SELECT runtime_host_cleanup_completed_at
			FROM sessions
			WHERE id = 'session-1'
		`);
    expect(cleanup.rows[0]?.runtime_host_cleanup_completed_at).toBeInstanceOf(
      Date,
    );
  });

  it("acknowledges the exact owned runtime host with postgres-js-safe timestamp parameters", async () => {
    await client.exec(`
			UPDATE sessions SET
				runtime_app_id = 'agent-session-explicit',
				dapr_instance_id = 'dapr-instance-explicit',
				runtime_sandbox_name = 'agent-host-agent-session-explicit',
				runtime_host_owned = true,
				runtime_host_cleanup_completed_at = NULL
			WHERE id = 'session-1'
		`);
    let target = await resolveTarget({ kind: "session", id: "session-1" });
    await target.markStopRequested("CLI session stopped", "terminate");
    target = await resolveTarget({ kind: "session", id: "session-1" });
    loggedQueries = [];

    await expect(
      target.finalizeDb("CLI session stopped", "terminated", "terminate"),
    ).resolves.toBe("finalized");

    const cleanupUpdate = loggedQueries.find(
      ({ query }) =>
        query.startsWith('update "sessions"') &&
        query.includes('"runtime_host_cleanup_completed_at"'),
    );
    expect(cleanupUpdate).toBeDefined();
    expect(cleanupUpdate?.params.some((param) => param instanceof Date)).toBe(
      false,
    );

    const persisted = await client.query<{
      status: string;
      runtime_host_cleanup_completed_at: Date | null;
    }>(`
			SELECT status, runtime_host_cleanup_completed_at
			FROM sessions
			WHERE id = 'session-1'
		`);
    expect(persisted.rows[0]).toMatchObject({
      status: "terminated",
      runtime_host_cleanup_completed_at: expect.any(Date),
    });
  });

  it("does not acknowledge a runtime host after its Sandbox target changes", async () => {
    let target = await resolveTarget({ kind: "session", id: "session-1" });
    await target.markStopRequested("CLI session stopped", "terminate");
    target = await resolveTarget({ kind: "session", id: "session-1" });
    await client.exec(`
			UPDATE sessions
			SET runtime_sandbox_name = 'agent-host-agent-session-replaced'
			WHERE id = 'session-1'
		`);

    await expect(
      target.finalizeDb("CLI session stopped", "terminated", "terminate"),
    ).resolves.toBe("finalized");

    const persisted = await client.query<{
      runtime_host_cleanup_completed_at: Date | null;
    }>(`
			SELECT runtime_host_cleanup_completed_at
			FROM sessions
			WHERE id = 'session-1'
		`);
    expect(persisted.rows[0]?.runtime_host_cleanup_completed_at).toBeNull();
  });

  it("acks child intents satisfied by a parent but preserves a stronger child reset", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (
				id, user_id, project_id, status, dapr_instance_id
			) VALUES ('workflow-1', 'user-1', 'project-1', 'running', 'workflow-1');
			UPDATE sessions
			SET workflow_execution_id = 'workflow-1'
			WHERE id = 'session-1';
			INSERT INTO sessions (
				id, user_id, project_id, status, workflow_execution_id,
				dapr_instance_id, runtime_app_id, runtime_sandbox_name
			) VALUES (
				'session-2', 'user-1', 'project-1', 'running', 'workflow-1',
				'session-2', 'agent-session-2', 'agent-host-agent-session-2'
			);
		`);
    const target = await resolveTarget({
      kind: "workflowExecution",
      id: "workflow-1",
    });
    await target.markStopRequested("clean workflow", "purge");
    await client.exec(`
			UPDATE sessions SET stop_requested_mode = 'reset' WHERE id = 'session-2'
		`);

    await expect(
      target.finalizeDb("cleaned", "terminated", "purge"),
    ).resolves.toBe("finalized");
    const children = await client.query<{
      id: string;
      stop_requested_at: Date | null;
      stop_requested_mode: string | null;
      status: string;
    }>(`
			SELECT id, stop_requested_at, stop_requested_mode, status
			FROM sessions ORDER BY id
		`);
    expect(children.rows).toEqual([
      expect.objectContaining({
        id: "session-1",
        status: "terminated",
        stop_requested_at: null,
        stop_requested_mode: null,
      }),
      expect.objectContaining({
        id: "session-2",
        status: "terminated",
        stop_requested_mode: "reset",
      }),
    ]);
  });
});
