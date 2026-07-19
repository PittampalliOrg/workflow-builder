import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationPeerSessionSpawnService } from "$lib/server/application/peer-session-spawn";
import type {
	PeerAgentDispatchContext,
	PeerSessionRecord,
	SandboxProvisioner,
	SessionRepository,
	SessionWorkflowSpawner,
	WorkflowDataService,
} from "$lib/server/application/ports";
import type { WorkflowMcpSessionTokenSigner } from "$lib/server/application/ports/workflow-mcp-auth";
import type {
  PeerSessionSpawnPolicy,
  PeerSessionSpawnPrincipal,
} from "$lib/server/application/peer-session-spawn";

describe("ApplicationPeerSessionSpawnService", () => {
	let peerSession: PeerSessionRecord;
	let dispatchContext: PeerAgentDispatchContext;
	let workflowData: Pick<
		WorkflowDataService,
    | "ensurePeerSession"
    | "resolvePeerAgentDispatchContext"
    | "getSessionDetail"
    | "getSessionFileOwner"
	>;
	let workflowSpawner: SessionWorkflowSpawner;
	let sandboxProvisioner: SandboxProvisioner;
	let sessions: Pick<
		SessionRepository,
		"attachWorkspaceSandbox" | "recordSandboxProvisioningError"
	>;
	let service: ApplicationPeerSessionSpawnService;
  let workflowMcpSessionTokens: WorkflowMcpSessionTokenSigner;
  const principal: PeerSessionSpawnPrincipal = {
    userId: "user-1",
    projectId: "project-1",
    sessionId: "parent-session-1",
    capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
  };
  const callAgentPolicy: PeerSessionSpawnPolicy = { kind: "call_agent" };

	beforeEach(() => {
		peerSession = {
			id: "ca-session-1",
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
			vaultIds: ["vault-1"],
			daprInstanceId: null,
			natsSubject: null,
      parentExecutionId: "parent-session-1",
		};
		dispatchContext = {
			agentConfig: {
				systemPrompt: "Peer",
			} as unknown as PeerAgentDispatchContext["agentConfig"],
			environmentConfig: { image: "env-image" },
			callableAgents: [
        {
          slug: "peer",
          agentId: "agent-peer",
          version: 3,
          appId: "dapr-agent-py",
          team: "project-1",
          registryKey: "project-1/peer",
        },
				{
					slug: "reviewer",
					agentId: "agent-reviewer",
					version: 2,
					appId: "dapr-agent-py",
					team: "project-1",
					registryKey: "project-1/reviewer",
				},
			],
			registryTeam: "project-1",
		};
		workflowData = {
			ensurePeerSession: vi.fn(async () => ({
				ok: true as const,
				session: peerSession,
				reused: false,
			})),
			resolvePeerAgentDispatchContext: vi.fn(async () => dispatchContext),
      getSessionDetail: vi.fn(async ({ sessionId }) =>
        sessionId === "parent-session-1"
          ? ({
              agentId: "agent-parent",
              agentVersion: 1,
            } as Awaited<ReturnType<WorkflowDataService["getSessionDetail"]>>)
          : null,
      ),
      getSessionFileOwner: vi.fn(async (sessionId) => ({
        id: sessionId,
        userId: "user-1",
        projectId: "project-1",
        status: "running" as const,
        completedAt: null,
      })),
    };
    workflowMcpSessionTokens = {
      sign: vi.fn(() => "signed-child-token"),
		};
		workflowSpawner = {
			spawnSessionWorkflow: vi.fn(async () => ({
				instanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
			})),
		};
		sandboxProvisioner = {
			provision: vi.fn(async () => ({
				sandboxName: "ws-peer-1",
				workspaceRef: "ref-1",
				rootPath: "/sandbox",
			})),
		};
		sessions = {
			attachWorkspaceSandbox: vi.fn(async () => {}),
			recordSandboxProvisioningError: vi.fn(async () => {}),
		};
		service = new ApplicationPeerSessionSpawnService({
			workflowData,
			workflowSpawner,
      workflowMcpSessionTokens,
			sandboxProvisioner,
			sessions,
		});
	});

  const spawn = (
    payload: unknown,
    policy: PeerSessionSpawnPolicy = callAgentPolicy,
  ) => service.spawnPeerSession(payload, principal, policy);

	it("validates required peer-spawn fields before ensuring a session", async () => {
    await expect(spawn({})).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			message: "sessionId is required",
		});
    await expect(spawn({ sessionId: "ca-session-1" })).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			message: "peerAgentId is required",
		});
		await expect(
      spawn({
				sessionId: "x".repeat(65),
				peerAgentId: "agent-peer",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			message: "sessionId must be ≤64 chars (Dapr workflow cap)",
		});
		expect(workflowData.ensurePeerSession).not.toHaveBeenCalled();
	});

	it("ensures and spawns a fresh peer session (no sandbox by default)", async () => {
    const result = await spawn(body({ title: "Peer review" }));

		expect(result).toEqual({
			status: "ok",
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
				sandboxName: null,
        workflowMcpSessionToken: "signed-child-token",
				reused: false,
			},
		});
		expect(workflowData.ensurePeerSession).toHaveBeenCalledWith({
			sessionId: "ca-session-1",
			peerAgentId: "agent-peer",
			prompt: "Review this change",
			parentSessionId: "parent-session-1",
      parentInstanceId: null,
			title: "Peer review",
		});
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
			"ca-session-1",
      {
        workflowMcpCapabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none",
        },
      },
		);
		expect(sandboxProvisioner.provision).not.toHaveBeenCalled();
	});

	it("provisions + attaches a workspace sandbox BEFORE spawn when opted in", async () => {
		const callOrder: string[] = [];
		vi.mocked(sandboxProvisioner.provision).mockImplementationOnce(async () => {
			callOrder.push("provision");
      return {
        sandboxName: "ws-peer-1",
        workspaceRef: "ref-1",
        rootPath: "/sandbox",
      };
		});
    vi.mocked(sessions.attachWorkspaceSandbox).mockImplementationOnce(
      async () => {
			callOrder.push("attach");
      },
    );
		vi.mocked(workflowSpawner.spawnSessionWorkflow).mockImplementationOnce(
			async () => {
				callOrder.push("spawn");
				return {
					instanceId: "ca-session-1",
					natsSubject: "session.events.ca-session-1",
				};
			},
		);

    const result = await spawn(
			body({ title: "teammate:impl", provisionSandbox: true }),
		);

		expect(sandboxProvisioner.provision).toHaveBeenCalledWith({
			executionId: "ca-session-1",
			name: "teammate:impl",
			sandboxTemplate: "base",
			keepAfterRun: true,
		});
		expect(sessions.attachWorkspaceSandbox).toHaveBeenCalledWith({
			sessionId: "ca-session-1",
			workspaceSandboxName: "ws-peer-1",
		});
		// Attach must land before the workflow spawn reads the session row.
		expect(callOrder).toEqual(["provision", "attach", "spawn"]);
		expect(result).toMatchObject({
			status: "ok",
			body: { sandboxName: "ws-peer-1" },
		});
	});

	it("degrades (records error, still spawns) when sandbox provisioning fails", async () => {
		vi.mocked(sandboxProvisioner.provision).mockRejectedValueOnce(
			new Error("Kueue admission timeout"),
		);

    const result = await spawn(body({ provisionSandbox: true }));

		expect(sessions.recordSandboxProvisioningError).toHaveBeenCalledWith({
			sessionId: "ca-session-1",
			errorMessage: "Kueue admission timeout",
		});
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
			"ca-session-1",
      expect.objectContaining({
        workflowMcpCapabilities: expect.objectContaining({ teamRole: "none" }),
      }),
		);
		expect(result).toMatchObject({
			status: "ok",
			body: { sandboxName: null, reused: false },
		});
	});

	it("returns reused sessions without spawning unless skipSpawn is requested", async () => {
		vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
			ok: true,
			session: {
				...peerSession,
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
			},
			reused: true,
		});

    const result = await spawn(body());

		expect(result).toEqual({
			status: "ok",
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
        workflowMcpSessionToken: "signed-child-token",
				reused: true,
			},
		});
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
    expect(workflowData.resolvePeerAgentDispatchContext).toHaveBeenCalledTimes(
      1,
    );
	});

	it("returns dispatch context for skipSpawn callers", async () => {
    const result = await spawn(body({ skipSpawn: true }));

		expect(result).toEqual({
			status: "ok",
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: null,
				natsSubject: null,
				reused: false,
				agentConfig: { systemPrompt: "Peer" },
				environmentConfig: { image: "env-image" },
				vaultIds: ["vault-1"],
				callableAgents: dispatchContext.callableAgents,
				registryTeam: "project-1",
        workflowMcpSessionToken: "signed-child-token",
				skipSpawn: true,
			},
		});
		expect(workflowData.resolvePeerAgentDispatchContext).toHaveBeenCalledWith({
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
		});
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("maps workflow-data and dispatch-resolution failures to route-safe errors", async () => {
		vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
			ok: false,
			status: 404,
			message: "Peer agent missing",
		});
    await expect(spawn(body())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Peer agent missing",
		});

    vi.mocked(workflowData.resolvePeerAgentDispatchContext)
      .mockResolvedValueOnce(dispatchContext)
      .mockResolvedValueOnce(null);
    await expect(spawn(body({ skipSpawn: true }))).resolves.toEqual({
			status: "error",
			httpStatus: 500,
			message: "could not re-resolve peer agent-peer",
		});
	});

	it("returns 202 with session ids when workflow spawn fails after row creation", async () => {
		vi.mocked(workflowSpawner.spawnSessionWorkflow).mockRejectedValueOnce(
			new Error("Dapr unavailable"),
		);

    await expect(spawn(body())).resolves.toEqual({
			status: "ok",
			httpStatus: 202,
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: null,
				natsSubject: null,
        workflowMcpSessionToken: "signed-child-token",
				reused: false,
				error: "Dapr unavailable",
			},
		});
	});

  it("rejects parent lineage and callable-agent violations", async () => {
    await expect(
      spawn(body({ parentSessionId: "another-session" })),
    ).resolves.toMatchObject({ status: "error", httpStatus: 403 });

    dispatchContext.callableAgents = [];
    await expect(spawn(body())).resolves.toEqual({
      status: "error",
      httpStatus: 403,
      message: "Peer agent is not in the parent session's callable allowlist",
    });
  });

  it("rejects a reused session whose agent or parent lineage conflicts", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: { ...peerSession, agentId: "different-agent" },
      reused: true,
    });

    await expect(spawn(body())).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "Existing peer session does not match the requested agent and lineage",
    });
  });

  it("mints member capability only for the signed team lead", async () => {
    const teamPrincipal: PeerSessionSpawnPrincipal = {
      ...principal,
      capabilities: {
        scriptDepth: 1,
        teamId: "team-1",
        teamRole: "lead",
      },
    };
    const result = await service.spawnPeerSession(body(), teamPrincipal, {
      kind: "team",
      teamId: "team-1",
    });

    expect(result.status).toBe("ok");
    expect(workflowMcpSessionTokens.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ca-session-1",
        capabilities: {
          scriptDepth: 1,
          teamId: "team-1",
          teamRole: "member",
        },
      }),
    );

    await expect(
      service.spawnPeerSession(body(), principal, {
        kind: "team",
        teamId: "team-1",
      }),
    ).resolves.toMatchObject({ status: "error", httpStatus: 403 });
  });
});

function body(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "ca-session-1",
		peerAgentId: "agent-peer",
		prompt: "Review this change",
		parentSessionId: "parent-session-1",
		parentInstanceId: "parent-instance-1",
		...overrides,
	};
}
