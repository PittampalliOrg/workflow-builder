import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentSessionRepository } from "./sessions";
import {
  sessionRuntimeGenerationAppId,
  sessionRuntimeGenerationInstanceId,
} from "$lib/server/lifecycle/resolvers";

describe("CurrentSessionRepository runtime provisioning lease", () => {
  let client: PGlite;
  let repository: CurrentSessionRepository;
  let resolveAgent: ReturnType<typeof vi.fn>;

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
				title text,
				status text NOT NULL,
				stop_reason jsonb,
				stop_requested_mode text,
				pause_requested_at timestamp,
				agent_id text,
				agent_version integer,
				environment_id text,
				environment_version integer,
				vault_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
				dapr_instance_id text,
				nats_subject text,
				sandbox_name text,
				workspace_sandbox_name text,
				runtime_app_id text,
					runtime_sandbox_name text,
					runtime_host_owned boolean NOT NULL DEFAULT true,
					runtime_host_cleanup_completed_at timestamp,
					runtime_host_cleanup_attempted_at timestamp,
						runtime_host_launch_spec jsonb,
						runtime_provisioning_started_at timestamp,
						runtime_provisioning_app_id text,
						runtime_provisioning_instance_id text,
						runtime_provisioning_sandbox_name text,
						runtime_provisioning_host_owned boolean,
						runtime_provisioning_host_launch_spec jsonb,
				workflow_execution_id text,
				parent_execution_id text,
				resumed_from_session_id text,
				mlflow_experiment_id text,
				mlflow_run_id text,
				mlflow_parent_run_id text,
				mlflow_session_id text,
				user_id text,
				project_id text,
				usage jsonb NOT NULL DEFAULT '{}'::jsonb,
				error_message text,
				stop_requested_at timestamp,
				completed_at timestamp,
				created_at timestamp NOT NULL DEFAULT now(),
				updated_at timestamp NOT NULL DEFAULT now(),
				last_event_at timestamp,
				pending_input jsonb,
				archived_at timestamp
			);
			INSERT INTO sessions (
				id, status, agent_id, user_id, runtime_app_id, runtime_sandbox_name
			) VALUES (
				'session-1', 'rescheduling', 'agent-1', 'user-1',
				'agent-runtime-old', 'agent-host-old'
			);
		`);
    resolveAgent = vi.fn(
      async () =>
        ({
          id: "agent-1",
          slug: "agent-1",
          name: "Agent 1",
          version: 1,
          configHash: "hash-1",
          config: {},
          environmentId: null,
          environmentVersion: null,
          defaultVaultIds: [],
          projectId: "project-1",
          runtime: "dapr-agent-py",
          runtimeAppId: "dapr-agent-py",
          mlflowUri: null,
          mlflowModelName: null,
          mlflowModelVersion: null,
          registryStatus: "registered",
        }) as never,
    );
    repository = new CurrentSessionRepository(
      drizzle(client) as never,
      resolveAgent as never,
    );
  });

  afterEach(async () => {
    await client.close();
  });

  async function runtimeRow(sessionId = "session-1") {
    const result = await client.query<{
      runtime_app_id: string | null;
      runtime_sandbox_name: string | null;
      dapr_instance_id: string | null;
      nats_subject: string | null;
      runtime_host_owned: boolean;
      runtime_host_launch_spec: Record<string, unknown> | null;
      runtime_provisioning_started_at: Date | null;
      runtime_provisioning_app_id: string | null;
      runtime_provisioning_instance_id: string | null;
      runtime_provisioning_sandbox_name: string | null;
      runtime_provisioning_host_owned: boolean | null;
      runtime_provisioning_host_launch_spec: Record<string, unknown> | null;
    }>(`
				SELECT dapr_instance_id, nats_subject, runtime_app_id,
				       runtime_sandbox_name, runtime_host_owned,
				       runtime_host_launch_spec,
				       runtime_provisioning_started_at,
				       runtime_provisioning_app_id,
				       runtime_provisioning_instance_id,
			       runtime_provisioning_sandbox_name,
			       runtime_provisioning_host_owned,
			       runtime_provisioning_host_launch_spec
			FROM sessions WHERE id = '${sessionId}'
		`);
    return result.rows[0];
  }

  it("keeps a live lease exclusive without replacing the published target", async () => {
    const firstLease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(firstLease).not.toBeNull();
    const first = await runtimeRow();
    expect(first).toMatchObject({
      runtime_app_id: "agent-runtime-old",
      runtime_sandbox_name: "agent-host-old",
    });
    expect(first.runtime_provisioning_started_at).not.toBeNull();

    const competingLease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(competingLease).toBeNull();
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_started_at: first.runtime_provisioning_started_at,
    });
  });

  it("does not acquire a new provisioning lease for a published durable instance", async () => {
    await client.exec(`
			UPDATE sessions
			SET dapr_instance_id = 'published-instance-1',
			    runtime_app_id = 'agent-session-published',
			    runtime_sandbox_name = 'agent-host-agent-session-published'
			WHERE id = 'session-1'
		`);

    await expect(
      repository.reserveSessionRuntimeProvisioning({ sessionId: "session-1" }),
    ).resolves.toBeNull();
    await expect(runtimeRow()).resolves.toMatchObject({
      dapr_instance_id: "published-instance-1",
      runtime_app_id: "agent-session-published",
      runtime_provisioning_started_at: null,
    });
  });

  it("persists an exact shared-pool crash-window target under the lease", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    const instanceId = sessionRuntimeGenerationInstanceId(
      "session-1",
      lease?.startedAt as Date,
    )!;

    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-runtime-browser-pool",
        durableInstanceId: instanceId,
        runtimeSandboxName: null,
        runtimeHostOwned: false,
        runtimeHostLaunchSpec: null,
      }),
    ).resolves.toBe(true);

    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_app_id: "agent-runtime-old",
      runtime_provisioning_app_id: "agent-runtime-browser-pool",
      runtime_provisioning_instance_id: instanceId,
      runtime_provisioning_sandbox_name: null,
      runtime_provisioning_host_owned: false,
    });
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: new Date(0),
        runtimeAppId: "wrong-runtime",
        durableInstanceId: "wrong-instance",
        runtimeSandboxName: null,
        runtimeHostOwned: false,
        runtimeHostLaunchSpec: null,
      }),
    ).resolves.toBe(false);
  });

  it("grants one atomic cleanup claim for an exact stale staged generation", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    const target = {
      sessionId: "session-1",
      startedAt: lease!.startedAt,
      runtimeAppId: "agent-runtime-browser-pool",
      durableInstanceId: "session-runtime-generation-1",
      runtimeSandboxName: null,
      runtimeHostOwned: false,
      runtimeHostLaunchSpec: null,
      publishedGeneration: false,
    };
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: target.sessionId,
        expectedStartedAt: target.startedAt,
        runtimeAppId: target.runtimeAppId,
        durableInstanceId: target.durableInstanceId,
        runtimeSandboxName: target.runtimeSandboxName,
        runtimeHostOwned: target.runtimeHostOwned,
        runtimeHostLaunchSpec: target.runtimeHostLaunchSpec,
      }),
    ).resolves.toBe(true);

    const claimedAt = new Date(target.startedAt.getTime() + 1_000);
    const claims = await Promise.all([
      repository.claimStaleSessionRuntimeProvisioning({
        current: target,
        claimedAt,
      }),
      repository.claimStaleSessionRuntimeProvisioning({
        current: target,
        claimedAt,
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimedRow = await runtimeRow();
    expect(claimedRow.runtime_provisioning_started_at).not.toBeNull();
    expect(claimedRow.runtime_provisioning_started_at?.getTime()).not.toBe(
      target.startedAt.getTime(),
    );
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_app_id: target.runtimeAppId,
      runtime_provisioning_instance_id: target.durableInstanceId,
    });

    const claimed = { ...target, startedAt: claimedAt };
    const replacement = {
      ...claimed,
      durableInstanceId: "session-runtime-generation-2",
    };
    await expect(
      repository.prepareClaimedSessionRuntimeProvisioningRedrive({
        claimed,
        replacement,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.prepareClaimedSessionRuntimeProvisioningRedrive({
        claimed,
        replacement,
      }),
    ).resolves.toBe(false);
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_instance_id: "session-runtime-generation-2",
    });
  });

  it("lists, CAS-publishes, and completes the exact stale staged target", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    const instanceId = sessionRuntimeGenerationInstanceId(
      "session-1",
      lease?.startedAt as Date,
    )!;
    const launchSpec = {
      version: 1,
      request: { agentAppId: "agent-runtime-generation-1" },
    };
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-runtime-generation-1",
        durableInstanceId: instanceId,
        runtimeSandboxName: "agent-host-generation-1",
        runtimeHostOwned: true,
        runtimeHostLaunchSpec: launchSpec,
      }),
    ).resolves.toBe(true);

    await expect(
      repository.listStaleSessionRuntimeProvisioningTargets({
        staleBefore: new Date(Date.now() + 60_000),
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        sessionId: "session-1",
        startedAt: lease?.startedAt,
        runtimeAppId: "agent-runtime-generation-1",
        durableInstanceId: instanceId,
        runtimeSandboxName: "agent-host-generation-1",
        runtimeHostOwned: true,
        runtimeHostLaunchSpec: launchSpec,
        publishedGeneration: false,
      },
    ]);
    await expect(
      repository.attachStagedSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: new Date(0),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.attachStagedSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    const published = await runtimeRow();
    expect(published).toMatchObject({
      dapr_instance_id: instanceId,
      nats_subject: "session.events.session-1",
      runtime_app_id: "agent-runtime-generation-1",
      runtime_sandbox_name: "agent-host-generation-1",
      runtime_host_owned: true,
      runtime_host_launch_spec: launchSpec,
      runtime_provisioning_app_id: "agent-runtime-generation-1",
      runtime_provisioning_instance_id: instanceId,
      runtime_provisioning_sandbox_name: "agent-host-generation-1",
      runtime_provisioning_host_owned: true,
    });
    expect(published.runtime_provisioning_started_at).not.toBeNull();
    await expect(
      repository.completeStagedSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-runtime-generation-1",
      }),
    ).resolves.toBe("completed");
    await expect(runtimeRow()).resolves.toMatchObject({
      dapr_instance_id: instanceId,
      runtime_app_id: "agent-runtime-generation-1",
      runtime_provisioning_started_at: null,
      runtime_provisioning_app_id: null,
      runtime_provisioning_instance_id: null,
      runtime_provisioning_sandbox_name: null,
      runtime_provisioning_host_owned: null,
    });
  });

  it("retains the exact published lease when stop wins completion", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    const instanceId = sessionRuntimeGenerationInstanceId(
      "session-1",
      lease?.startedAt as Date,
    )!;
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-runtime-generation-1",
        durableInstanceId: instanceId,
        runtimeSandboxName: "agent-host-generation-1",
        runtimeHostOwned: true,
        runtimeHostLaunchSpec: { version: 1 },
      }),
    ).resolves.toBe(true);
    await expect(
      repository.attachStagedSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'session-1'",
    );

    await expect(
      repository.completeStagedSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-runtime-generation-1",
      }),
    ).resolves.toBe("stopped");
    const stopped = await runtimeRow();
    expect(stopped).toMatchObject({
      dapr_instance_id: instanceId,
      runtime_app_id: "agent-runtime-generation-1",
      runtime_provisioning_app_id: "agent-runtime-generation-1",
      runtime_provisioning_instance_id: instanceId,
    });
    expect(stopped.runtime_provisioning_started_at).not.toBeNull();
  });

  it("fails closed when the parent session stops before staged recovery", async () => {
    await client.exec(`
			INSERT INTO sessions (id, status, agent_id, user_id)
			VALUES ('parent-2', 'running', 'agent-1', 'user-1');
			INSERT INTO sessions (
				id, status, agent_id, user_id, parent_execution_id
			) VALUES (
				'child-2', 'rescheduling', 'agent-1', 'user-1', 'parent-2'
			)
		`);
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "child-2",
    });
    expect(lease).not.toBeNull();
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "child-2",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-runtime-shared-pool",
        durableInstanceId: sessionRuntimeGenerationInstanceId(
          "child-2",
          lease?.startedAt as Date,
        )!,
        runtimeSandboxName: null,
        runtimeHostOwned: false,
        runtimeHostLaunchSpec: null,
      }),
    ).resolves.toBe(true);
    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'parent-2'",
    );

    await expect(
      repository.listStaleSessionRuntimeProvisioningTargets({
        staleBefore: new Date(Date.now() + 60_000),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.canReleaseRuntimeProvisioning({
        sessionId: "child-2",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.attachStagedSessionRuntimeProvisioning({
        sessionId: "child-2",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(false);
  });

  it.each(["paused", "failed"])(
    "does not compensate a lease while its parent session is nonterminal %s",
    async (status) => {
      await client.exec(`
				INSERT INTO sessions (id, status, agent_id, user_id)
				VALUES ('parent-nonterminal', 'running', 'agent-1', 'user-1');
				INSERT INTO sessions (
					id, status, agent_id, user_id, parent_execution_id
				) VALUES (
					'child-nonterminal', 'rescheduling', 'agent-1', 'user-1',
					'parent-nonterminal'
				)
			`);
      const lease = await repository.reserveSessionRuntimeProvisioning({
        sessionId: "child-nonterminal",
      });
      expect(lease).not.toBeNull();
      await client.exec(`
				UPDATE sessions
				SET status = '${status}'
				WHERE id = 'parent-nonterminal'
			`);

      await expect(
        repository.canCompensateRuntimeProvisioning({
          sessionId: "child-nonterminal",
          expectedStartedAt: lease?.startedAt as Date,
        }),
      ).resolves.toBe(false);
    },
  );

  it("keeps the first staged launch recipe immutable within a generation", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    const input = {
      sessionId: "session-1",
      expectedStartedAt: lease?.startedAt as Date,
      runtimeAppId: "agent-runtime-generation-1",
      durableInstanceId: sessionRuntimeGenerationInstanceId(
        "session-1",
        lease?.startedAt as Date,
      )!,
      runtimeSandboxName: "agent-host-generation-1",
      runtimeHostOwned: true,
      runtimeHostLaunchSpec: {
        version: 1,
        request: { image: "runtime:v1" },
      },
    };

    await expect(
      repository.stageSessionRuntimeProvisioning(input),
    ).resolves.toBe(true);
    await expect(
      repository.stageSessionRuntimeProvisioning(input),
    ).resolves.toBe(true);
    await expect(
      repository.stageSessionRuntimeProvisioning({
        ...input,
        runtimeHostLaunchSpec: {
          version: 1,
          request: { image: "runtime:v2" },
        },
      }),
    ).resolves.toBe(false);
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_host_launch_spec: {
        version: 1,
        request: { image: "runtime:v1" },
      },
    });
  });

  it("publishes a staged dedicated target and clears all staging fields", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    const instanceId = sessionRuntimeGenerationInstanceId(
      "session-1",
      lease?.startedAt as Date,
    )!;
    const appId = sessionRuntimeGenerationAppId(
      "session-1",
      lease?.startedAt as Date,
    )!;
    const sandboxName = `agent-host-${appId}`;
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: appId,
        durableInstanceId: instanceId,
        runtimeSandboxName: sandboxName,
        runtimeHostOwned: true,
        runtimeHostLaunchSpec: {
          version: 1,
          request: { agentAppId: appId },
        },
      }),
    ).resolves.toBe(true);

    await expect(
      repository.attachSessionRuntime({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        daprInstanceId: instanceId,
        runtimeAppId: appId,
        runtimeSandboxName: sandboxName,
        runtimeHostOwned: true,
      }),
    ).resolves.toBe(true);
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_app_id: appId,
      runtime_sandbox_name: sandboxName,
      runtime_provisioning_started_at: null,
      runtime_provisioning_app_id: null,
      runtime_provisioning_instance_id: null,
      runtime_provisioning_sandbox_name: null,
      runtime_provisioning_host_owned: null,
    });
  });

  it("publishes the actual target and clears the lease", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();

    await expect(
      repository.attachSessionRuntime({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        daprInstanceId: "session-1",
        natsSubject: "session.events.session-1",
        runtimeAppId: "agent-session-new",
        runtimeSandboxName: "agent-host-agent-session-new",
      }),
    ).resolves.toBe(true);

    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_app_id: "agent-session-new",
      runtime_sandbox_name: "agent-host-agent-session-new",
      runtime_provisioning_started_at: null,
    });
  });

  it("preserves the old target and lease when stop wins publication", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await client.exec(`
			UPDATE sessions SET stop_requested_at = now() WHERE id = 'session-1'
		`);

    await expect(
      repository.attachSessionRuntime({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-session-late",
        runtimeSandboxName: "agent-host-agent-session-late",
      }),
    ).resolves.toBe(false);

    const row = await runtimeRow();
    expect(row).toMatchObject({
      runtime_app_id: "agent-runtime-old",
      runtime_sandbox_name: "agent-host-old",
    });
    expect(row.runtime_provisioning_started_at).not.toBeNull();
    await expect(
      repository.reserveSessionRuntimeProvisioning({ sessionId: "session-1" }),
    ).resolves.toBeNull();
  });

  it("takes over an aged lease with a distinct token and runtime generation", async () => {
    await client.exec(`
			UPDATE sessions
			SET runtime_provisioning_started_at =
				date_trunc('milliseconds', now() - interval '11 minutes')
			WHERE id = 'session-1'
		`);
    const agedRow = await runtimeRow();
    const competingLease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });

    expect(agedRow.runtime_provisioning_started_at).not.toBeNull();
    expect(competingLease).not.toBeNull();
    const currentRow = await runtimeRow();
    expect(
      currentRow.runtime_provisioning_started_at?.getTime(),
    ).toBeGreaterThan(agedRow.runtime_provisioning_started_at?.getTime() ?? 0);
    expect(
      sessionRuntimeGenerationAppId(
        "session-1",
        competingLease?.startedAt as Date,
      ),
    ).not.toBe(
      sessionRuntimeGenerationAppId(
        "session-1",
        agedRow.runtime_provisioning_started_at as Date,
      ),
    );
    await expect(
      repository.attachSessionRuntime({
        sessionId: "session-1",
        expectedStartedAt: agedRow.runtime_provisioning_started_at as Date,
        runtimeAppId: "agent-session-stale",
      }),
    ).resolves.toBe(false);
    await expect(runtimeRow()).resolves.toEqual(currentRow);
  });

  it("does not discard an aged staged target during lease takeover", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await expect(
      repository.stageSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "shared-runtime",
        durableInstanceId: sessionRuntimeGenerationInstanceId(
          "session-1",
          lease?.startedAt as Date,
        )!,
        runtimeSandboxName: null,
        runtimeHostOwned: false,
        runtimeHostLaunchSpec: null,
      }),
    ).resolves.toBe(true);
    await client.exec(`
				UPDATE sessions
				SET runtime_provisioning_started_at =
					date_trunc('milliseconds', now() - interval '11 minutes')
				WHERE id = 'session-1'
			`);

    await expect(
      repository.reserveSessionRuntimeProvisioning({ sessionId: "session-1" }),
    ).resolves.toBeNull();
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_app_id: "shared-runtime",
      runtime_provisioning_host_owned: false,
    });
  });

  it("advances the generation beyond updated_at even if the wall clock rolls back", async () => {
    const futureFloor = new Date("2099-01-01T00:00:00.000Z");
    await client.exec(`
			UPDATE sessions
			SET runtime_provisioning_started_at = NULL,
			    updated_at = '${futureFloor.toISOString()}'
			WHERE id = 'session-1'
		`);

    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    expect(lease?.startedAt.getTime()).toBeGreaterThan(futureFloor.getTime());
  });

  it("acknowledges only the exact stopped lease", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await client.exec(`
				UPDATE sessions SET stop_requested_at = now() WHERE id = 'session-1'
			`);

    await expect(
      repository.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_app_id: "agent-runtime-old",
      runtime_sandbox_name: "agent-host-old",
      runtime_provisioning_started_at: null,
    });
  });

  it("encodes compensation timestamps before postgres-js", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const postgresClient = {
      options: { parsers: {}, serializers: {} },
      unsafe: (query: string, params: unknown[]) => {
        calls.push({ sql: query, params: [...params] });
        return { values: async () => [["session-1"]] };
      },
    };
    const postgresRepository = new CurrentSessionRepository(
      drizzlePostgresJs(postgresClient as never) as never,
      resolveAgent as never,
    );
    const expectedStartedAt = new Date("2026-07-22T01:02:03.456Z");

    await expect(
      postgresRepository.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "session-1",
        expectedStartedAt,
      }),
    ).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("GREATEST");
    expect(calls[0].params.some((value) => value instanceof Date)).toBe(false);
    expect(
      calls[0].params.filter(
        (value) => value === expectedStartedAt.toISOString(),
      ),
    ).toHaveLength(2);
  });

  it("recovers one exact published generation and never completes after stop", async () => {
    await client.exec(`
			UPDATE sessions
			SET dapr_instance_id = 'published-instance-1',
			    runtime_app_id = 'agent-session-published',
			    runtime_sandbox_name = 'agent-host-agent-session-published',
			    runtime_host_launch_spec = '{"version":1,"request":{"agentAppId":"agent-session-published"},"secretEnvKeys":[]}'::jsonb
			WHERE id = 'session-1'
		`);
    await expect(
      repository.inspectSessionRuntimeHostRecovery({
        sessionId: "session-1",
        expectedRuntimeAppId: "agent-session-published",
      }),
    ).resolves.toMatchObject({
      runtimeAppId: "agent-session-published",
      runtimeSandboxName: "agent-host-agent-session-published",
    });
    const recovery = await repository.beginSessionRuntimeHostRecovery({
      sessionId: "session-1",
      expectedRuntimeAppId: "agent-session-published",
    });
    expect(recovery).not.toBeNull();
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_app_id: "agent-session-published",
      runtime_provisioning_instance_id: "published-instance-1",
      runtime_provisioning_sandbox_name: "agent-host-agent-session-published",
      runtime_provisioning_host_owned: true,
    });
    await expect(
      repository.inspectSessionRuntimeHostRecovery({
        sessionId: "session-1",
        expectedRuntimeAppId: "agent-session-published",
      }),
    ).resolves.toMatchObject({ recoveryStartedAt: recovery?.startedAt });
    await expect(
      repository.listStaleSessionRuntimeProvisioningTargets({
        staleBefore: new Date((recovery?.startedAt.getTime() ?? 0) + 1),
        limit: 10,
      }),
    ).resolves.toContainEqual({
      sessionId: "session-1",
      startedAt: recovery?.startedAt,
      runtimeAppId: "agent-session-published",
      durableInstanceId: "published-instance-1",
      runtimeSandboxName: "agent-host-agent-session-published",
      runtimeHostOwned: true,
      runtimeHostLaunchSpec: {
        version: 1,
        request: { agentAppId: "agent-session-published" },
        secretEnvKeys: [],
      },
      publishedGeneration: true,
    });
    const concurrent = await repository.beginSessionRuntimeHostRecovery({
      sessionId: "session-1",
      expectedRuntimeAppId: "agent-session-published",
    });
    expect(concurrent?.startedAt).toEqual(recovery?.startedAt);

    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'session-1'",
    );
    await expect(
      repository.completeSessionRuntimeHostRecovery({
        sessionId: "session-1",
        expectedRuntimeAppId: "agent-session-published",
        expectedStartedAt: recovery?.startedAt as Date,
      }),
    ).resolves.toBe("stopped");
    expect((await runtimeRow()).runtime_provisioning_started_at).not.toBeNull();
  });

  it("normalizes a legacy published host without a persisted Sandbox name", async () => {
    await client.exec(`
			UPDATE sessions
			SET dapr_instance_id = 'legacy-published-instance',
			    runtime_app_id = 'agent-session-legacy-published',
			    runtime_sandbox_name = NULL,
			    runtime_host_launch_spec = '{"version":1,"request":{"agentAppId":"agent-session-legacy-published"},"secretEnvKeys":[]}'::jsonb
			WHERE id = 'session-1'
		`);
    const input = {
      sessionId: "session-1",
      expectedRuntimeAppId: "agent-session-legacy-published",
    };

    await expect(
      repository.inspectSessionRuntimeHostRecovery(input),
    ).resolves.toMatchObject({
      runtimeAppId: "agent-session-legacy-published",
      runtimeSandboxName: "agent-host-agent-session-legacy-published",
      recoveryStartedAt: null,
    });

    const recovery = await repository.beginSessionRuntimeHostRecovery(input);
    expect(recovery).toMatchObject({
      runtimeAppId: "agent-session-legacy-published",
      runtimeSandboxName: "agent-host-agent-session-legacy-published",
    });
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_sandbox_name: null,
      runtime_provisioning_app_id: "agent-session-legacy-published",
      runtime_provisioning_instance_id: "legacy-published-instance",
      runtime_provisioning_sandbox_name:
        "agent-host-agent-session-legacy-published",
      runtime_provisioning_host_owned: true,
    });
    await expect(
      repository.inspectSessionRuntimeHostRecovery(input),
    ).resolves.toMatchObject({
      runtimeSandboxName: "agent-host-agent-session-legacy-published",
      recoveryStartedAt: recovery?.startedAt,
    });
  });

  it("rejects published child-host recovery after its parent session stops", async () => {
    await client.exec(`
				INSERT INTO sessions (id, status, agent_id, user_id)
				VALUES ('recovery-parent', 'running', 'agent-1', 'user-1');
				INSERT INTO sessions (
					id, status, agent_id, user_id, parent_execution_id,
					dapr_instance_id, runtime_app_id, runtime_sandbox_name,
					runtime_host_launch_spec
				) VALUES (
					'recovery-child', 'running', 'agent-1', 'user-1',
					'recovery-parent', 'child-instance-1', 'agent-session-child',
					'agent-host-agent-session-child',
					'{"version":1,"request":{"agentAppId":"agent-session-child"},"secretEnvKeys":[]}'::jsonb
				)
			`);
    const recoveryInput = {
      sessionId: "recovery-child",
      expectedRuntimeAppId: "agent-session-child",
    };
    await expect(
      repository.inspectSessionRuntimeHostRecovery(recoveryInput),
    ).resolves.toMatchObject({ runtimeAppId: "agent-session-child" });
    const recovery =
      await repository.beginSessionRuntimeHostRecovery(recoveryInput);
    expect(recovery).not.toBeNull();

    await client.exec(`
				UPDATE sessions
				SET stop_requested_at = now()
				WHERE id = 'recovery-parent'
			`);

    await expect(
      repository.inspectSessionRuntimeHostRecovery(recoveryInput),
    ).resolves.toBeNull();
    await expect(
      repository.beginSessionRuntimeHostRecovery(recoveryInput),
    ).resolves.toBeNull();
    await expect(
      repository.completeSessionRuntimeHostRecovery({
        ...recoveryInput,
        expectedStartedAt: recovery?.startedAt as Date,
      }),
    ).resolves.toBe("stopped");
    expect(
      (await runtimeRow("recovery-child")).runtime_provisioning_started_at,
    ).not.toBeNull();
    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "recovery-child",
        expectedStartedAt: new Date(0),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "recovery-child",
        expectedStartedAt: recovery?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "recovery-child",
        expectedStartedAt: new Date(0),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "recovery-child",
        expectedStartedAt: recovery?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(runtimeRow("recovery-child")).resolves.toMatchObject({
      runtime_app_id: "agent-session-child",
      runtime_sandbox_name: "agent-host-agent-session-child",
      runtime_provisioning_started_at: null,
    });
  });

  it("authorizes workflow-parent compensation only after the workflow terminates", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (id, dapr_instance_id, status)
			VALUES ('workflow-parent', 'dsw-workflow-parent', 'running');
			UPDATE sessions
			SET workflow_execution_id = 'workflow-parent',
			    parent_execution_id = 'dsw-workflow-parent'
			WHERE id = 'session-1'
		`);
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(false);

    await client.exec(`
			UPDATE workflow_executions
			SET status = 'cancelled', completed_at = now()
			WHERE id = 'workflow-parent'
		`);

    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
  });

  it("completes a recovery lease idempotently for an active published generation", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (id, dapr_instance_id, status)
			VALUES ('workflow-recovery', 'dsw-workflow-recovery', 'running');
			UPDATE sessions
			SET dapr_instance_id = 'published-instance-2',
			    runtime_app_id = 'agent-session-published',
			    runtime_sandbox_name = 'agent-host-agent-session-published',
			    runtime_host_launch_spec = '{"version":1,"request":{"agentAppId":"agent-session-published"},"secretEnvKeys":[]}'::jsonb,
			    workflow_execution_id = 'workflow-recovery',
			    parent_execution_id = 'dsw-workflow-recovery'
			WHERE id = 'session-1'
		`);
    const recovery = await repository.beginSessionRuntimeHostRecovery({
      sessionId: "session-1",
      expectedRuntimeAppId: "agent-session-published",
    });
    expect(recovery).not.toBeNull();
    const input = {
      sessionId: "session-1",
      expectedRuntimeAppId: "agent-session-published",
      expectedStartedAt: recovery?.startedAt as Date,
    };
    await expect(
      repository.completeSessionRuntimeHostRecovery(input),
    ).resolves.toBe("completed");
    await expect(
      repository.completeSessionRuntimeHostRecovery(input),
    ).resolves.toBe("already_completed");
    expect((await runtimeRow()).runtime_provisioning_started_at).toBeNull();
  });

  it("does not clear an active lease with the stopped compensation path", async () => {
    const oldLease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(oldLease).not.toBeNull();
    await expect(
      repository.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "session-1",
        expectedStartedAt: oldLease?.startedAt as Date,
      }),
    ).resolves.toBe(false);
    const row = await runtimeRow();
    expect(row.runtime_provisioning_started_at).not.toBeNull();
  });

  it("releases only the exact active lease", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await expect(
      repository.releaseSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: new Date(0),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.releaseSessionRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(runtimeRow()).resolves.toMatchObject({
      runtime_provisioning_started_at: null,
    });
  });

  it("authorizes compensation only for the exact stopped lease", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(false);
    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'session-1'",
    );
    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.canCompensateRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: new Date(0),
      }),
    ).resolves.toBe(false);
  });

  it("authorizes destructive active cleanup only for the exact live lease", async () => {
    const lease = await repository.reserveSessionRuntimeProvisioning({
      sessionId: "session-1",
    });
    expect(lease).not.toBeNull();
    await expect(
      repository.canReleaseRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.canReleaseRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: new Date(0),
      }),
    ).resolves.toBe(false);
    await client.exec(
      "UPDATE sessions SET stop_requested_at = now() WHERE id = 'session-1'",
    );
    await expect(
      repository.canReleaseRuntimeProvisioning({
        sessionId: "session-1",
        expectedStartedAt: lease?.startedAt as Date,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["Dapr workflow instance", "dsw-workflow-1"],
    ["legacy workflow id", "workflow-1"],
  ])("publishes a workflow child through its %s", async (_kind, parentId) => {
    await client.exec(`
			INSERT INTO workflow_executions (id, dapr_instance_id, status)
			VALUES ('workflow-1', 'dsw-workflow-1', 'running')
		`);

    const lease = await repository.createWorkflowEnsureSession({
      id: "workflow-child-1",
      title: "Workflow child",
      agentId: "agent-1",
      agentVersion: 1,
      vaultIds: [],
      userId: "user-1",
      projectId: "project-1",
      sandboxName: "workspace-1",
      workflowExecutionId: "workflow-1",
      parentExecutionId: parentId,
    });
    expect(lease).toEqual({ startedAt: expect.any(Date) });

    await expect(
      repository.updateWorkflowEnsureSessionRuntime({
        sessionId: "workflow-child-1",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-session-workflow-child-1",
        runtimeSandboxName: "agent-host-workflow-child-1",
        runtimeHostOwned: true,
        runtimeHostLaunchSpec: null,
      }),
    ).resolves.toBe(true);

    await expect(runtimeRow("workflow-child-1")).resolves.toMatchObject({
      runtime_app_id: "agent-session-workflow-child-1",
      runtime_sandbox_name: "agent-host-workflow-child-1",
      runtime_provisioning_started_at: null,
    });
  });

  it("does not let workflow lineage bypass a stopped parent session", async () => {
    await client.exec(`
			INSERT INTO workflow_executions (id, dapr_instance_id, status)
			VALUES ('workflow-collision', 'parent-collision', 'running');
			INSERT INTO sessions (
				id, status, agent_id, user_id, stop_requested_at
			) VALUES (
				'parent-collision', 'running', 'agent-1', 'user-1', now()
			)
		`);

    const lease = await repository.createWorkflowEnsureSession({
      id: "workflow-child-collision",
      title: "Workflow child collision",
      agentId: "agent-1",
      agentVersion: 1,
      vaultIds: [],
      userId: "user-1",
      projectId: "project-1",
      sandboxName: "workspace-collision",
      workflowExecutionId: "workflow-collision",
      parentExecutionId: "parent-collision",
    });
    expect(lease).toEqual({ startedAt: expect.any(Date) });

    await expect(
      repository.updateWorkflowEnsureSessionRuntime({
        sessionId: "workflow-child-collision",
        expectedStartedAt: lease?.startedAt as Date,
        runtimeAppId: "agent-session-collision",
        runtimeSandboxName: "agent-host-collision",
        runtimeHostOwned: true,
        runtimeHostLaunchSpec: null,
      }),
    ).resolves.toBe(false);
  });

  it("reads authoritative workflow child ownership and lineage", async () => {
    await client.exec(`
			INSERT INTO sessions (
				id, status, agent_id, agent_version, user_id, project_id,
				workflow_execution_id, parent_execution_id
			) VALUES (
				'workflow-child-authority', 'rescheduling', 'agent-1', 7,
				'user-owner', 'project-owner', 'execution-owner', 'parent-owner'
			)
		`);

    await expect(
      repository.getWorkflowEnsureSession("workflow-child-authority"),
    ).resolves.toMatchObject({
      id: "workflow-child-authority",
      agentId: "agent-1",
      agentVersion: 7,
      userId: "user-owner",
      projectId: "project-owner",
      workflowExecutionId: "execution-owner",
      parentExecutionId: "parent-owner",
    });
  });

  it("inserts a peer already linked while its parent and execution are active", async () => {
    await client.exec(`
      INSERT INTO workflow_executions (id, status)
      VALUES ('workflow-peer-1', 'running')
    `);

    const input = {
      id: "peer-1",
      agentId: "agent-1",
      agentVersion: 1,
      title: "Peer 1",
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: "workflow-peer-1",
      parentExecutionId: "session-1",
    };
    const created = await repository.createPeerSession(input);
    expect(resolveAgent).toHaveBeenCalledWith({ id: "agent-1", version: 1 });
    expect(created).toMatchObject({
      status: "ok",
      created: true,
      session: {
        id: "peer-1",
        agentVersion: 1,
        workflowExecutionId: "workflow-peer-1",
        parentExecutionId: "session-1",
      },
    });

    await expect(repository.createPeerSession(input)).resolves.toMatchObject({
      status: "ok",
      created: false,
      session: { id: "peer-1" },
    });
  });

  it("refuses peer insertion after either workflow or parent stop wins", async () => {
    await client.exec(`
      INSERT INTO workflow_executions (id, status, stop_requested_at)
      VALUES ('workflow-peer-stop', 'running', now())
    `);
    const base = {
      agentId: "agent-1",
      title: "Peer",
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: "workflow-peer-stop",
      parentExecutionId: "session-1",
    };

    await expect(
      repository.createPeerSession({ ...base, id: "peer-stopped-workflow" }),
    ).resolves.toEqual({ status: "execution_not_active" });

    await client.exec(`
      UPDATE workflow_executions
      SET stop_requested_at = NULL
      WHERE id = 'workflow-peer-stop';
      UPDATE sessions
      SET stop_requested_at = now()
      WHERE id = 'session-1'
    `);
    await expect(
      repository.createPeerSession({ ...base, id: "peer-stopped-parent" }),
    ).resolves.toEqual({ status: "execution_not_active" });

    const rows = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM sessions
      WHERE id IN ('peer-stopped-workflow', 'peer-stopped-parent')
    `);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("does not reserve a linked session after workflow stop intent", async () => {
    await client.exec(`
      INSERT INTO workflow_executions (id, status, stop_requested_at)
      VALUES ('workflow-reserve-stop', 'running', now());
      UPDATE sessions
      SET workflow_execution_id = 'workflow-reserve-stop'
      WHERE id = 'session-1'
    `);

    await expect(
      repository.reserveSessionRuntimeProvisioning({ sessionId: "session-1" }),
    ).resolves.toBeNull();
  });
});
