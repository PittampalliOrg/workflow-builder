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

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
			CREATE TABLE workflow_executions (
				id text PRIMARY KEY,
				user_id text NOT NULL,
				project_id text,
				status text NOT NULL,
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
    resolveTarget = createPostgresLifecycleTargetResolver(
      drizzle(client) as never,
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
