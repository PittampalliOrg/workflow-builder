import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationPeerSessionSpawnService } from "$lib/server/application/peer-session-spawn";
import { ApplicationTeamMemberLaunchService } from "$lib/server/application/team-member-launch";
import type {
	PeerAgentDispatchContext,
	PeerSessionRecord,
	SandboxProvisioner,
  SessionLifecycleController,
	SessionRepository,
  SessionSandboxDestroyer,
	SessionWorkflowSpawner,
  TeamMemberPeerDispatchRecipe,
  TeamMemberRow,
  TeamStore,
	WorkflowDataService,
} from "$lib/server/application/ports";
import type { ApplicationTeamMailboxEligibilityService } from "$lib/server/application/team-mailbox-eligibility";
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
  let sandboxDestroyer: SessionSandboxDestroyer;
	let sessions: Pick<
		SessionRepository,
    | "attachWorkspaceSandbox"
    | "attachSessionRuntime"
    | "acknowledgeRuntimeProvisioningCompensation"
    | "recordSandboxProvisioningError"
	>;
	let service: ApplicationPeerSessionSpawnService;
  let workflowMcpSessionTokens: WorkflowMcpSessionTokenSigner;
  let teamMailboxDelivery: {
    requestDeliveryAfterRuntimePublished: (
      sessionId: string,
    ) => Promise<"empty" | "published">;
  };
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
      status: "rescheduling",
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
			vaultIds: ["vault-1"],
			daprInstanceId: null,
			natsSubject: null,
      runtimeAppId: null,
      runtimeProvisioningStartedAt: null,
      workflowExecutionId: "exec-1",
      parentExecutionId: "parent-session-1",
      stopRequestedAt: null,
      completedAt: null,
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
              workflowExecutionId: "exec-1",
              runtimeAppId: "agent-session-parent",
              runtimeSandboxName: "agent-host-parent",
            } as Awaited<ReturnType<WorkflowDataService["getSessionDetail"]>>)
          : null,
      ),
      getSessionFileOwner: vi.fn(async (sessionId) => ({
        id: sessionId,
        userId: "user-1",
        projectId: "project-1",
        status: "running" as const,
        completedAt: null,
        stopRequestedAt: null,
      })),
    };
    workflowMcpSessionTokens = {
      sign: vi.fn(() => "signed-child-token"),
		};
		workflowSpawner = {
      reserveSessionWorkflow: vi.fn(async () => ({
        startedAt: new Date("2026-07-21T12:00:00.000Z"),
      })),
      releaseSessionWorkflow: vi.fn(async () => true),
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
      attachWorkspaceSandbox: vi.fn(async () => true),
      attachSessionRuntime: vi.fn(async () => true),
      acknowledgeRuntimeProvisioningCompensation: vi.fn(async () => true),
			recordSandboxProvisioningError: vi.fn(async () => {}),
		};
    sandboxDestroyer = {
      deleteRuntimeSandbox: vi.fn(async (name: string) => ({
        name,
        kind: "runtime" as const,
        status: "deleted" as const,
      })),
      deleteWorkspaceSandbox: vi.fn(async (name: string) => ({
        name,
        kind: "workspace" as const,
        status: "deleted" as const,
      })),
    };
    teamMailboxDelivery = {
      requestDeliveryAfterRuntimePublished: vi.fn(
        async (_sessionId: string) => "empty" as const,
      ),
    };
		service = new ApplicationPeerSessionSpawnService({
			workflowData,
			workflowSpawner,
      workflowMcpSessionTokens,
			sandboxProvisioner,
			sessions,
      sandboxDestroyer,
      teamMailboxDelivery,
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
      workflowExecutionId: "exec-1",
			parentSessionId: "parent-session-1",
      parentInstanceId: null,
			title: "Peer review",
		});
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
			"ca-session-1",
      {
        provisioningLease: {
          startedAt: new Date("2026-07-21T12:00:00.000Z"),
        },
        workflowMcpCapabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none",
        },
      },
		);
		expect(sandboxProvisioner.provision).not.toHaveBeenCalled();
	});

  it("does not provision external resources when runtime reservation loses", async () => {
    vi.mocked(workflowSpawner.reserveSessionWorkflow).mockResolvedValueOnce(
      null,
    );

    await expect(spawn(body({ provisionSandbox: true }))).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "Session ca-session-1 is stopping or terminal",
    });
    expect(sandboxProvisioner.provision).not.toHaveBeenCalled();
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
  });

  it("returns structured pending when a reused active peer already owns provisioning", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: peerSession,
      reused: true,
    });
    vi.mocked(workflowSpawner.reserveSessionWorkflow).mockResolvedValueOnce(
      null,
    );

    await expect(spawn(body({ provisionSandbox: true }))).resolves.toEqual({
      status: "pending",
      httpStatus: 202,
      code: "runtime_provisioning",
      message:
        "Session ca-session-1 runtime provisioning is already in progress",
      body: {
        sessionId: "ca-session-1",
        reused: true,
        pending: true,
      },
    });
    expect(sandboxProvisioner.provision).not.toHaveBeenCalled();
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
  });

  it("keeps a persisted team launch when the real peer service loses its lease race", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: peerSession,
      reused: true,
    });
    vi.mocked(workflowSpawner.reserveSessionWorkflow).mockResolvedValueOnce(
      null,
    );
    const teamPrincipal: PeerSessionSpawnPrincipal = {
      ...principal,
      capabilities: {
        scriptDepth: 0,
        teamId: "team-1",
        teamRole: "lead",
      },
    };
    const recipe: TeamMemberPeerDispatchRecipe = {
      version: 1,
      teamId: "team-1",
      principal: teamPrincipal as TeamMemberPeerDispatchRecipe["principal"],
      request: {
        sessionId: "ca-session-1",
        peerAgentId: "agent-peer",
        peerAgentVersion: 3,
        prompt: "Review this change",
        parentSessionId: "parent-session-1",
        title: "teammate:worker",
        skipSpawn: false,
        provisionSandbox: true,
        sandboxTemplate: null,
      },
    };
    const member: TeamMemberRow = {
      id: "member-1",
      team_id: "team-1",
      session_id: "ca-session-1",
      agent_slug: "peer",
      name: "worker",
      role: "member",
      model: null,
      status: "starting",
      plan_mode_required: false,
      joined_at: "2026-07-21T00:00:00.000Z",
      updated_at: "2026-07-21T00:00:00.000Z",
      launch_operation_id: "launch-1",
      launch_kind: "spawn",
      launch_started_at: "2026-07-21T00:00:00.000Z",
      launch_dispatch_recipe: recipe,
    };
    const teams: Pick<
      TeamStore,
      | "beginMemberSpawn"
      | "beginMemberRevival"
      | "findMemberSpawnReplay"
      | "findMemberRevivalReplay"
      | "promoteStartingMember"
      | "requestMemberLaunchCleanup"
      | "completeMemberLaunchCleanup"
    > = {
      beginMemberSpawn: vi.fn(async () => null),
      beginMemberRevival: vi.fn(async () => null),
      findMemberSpawnReplay: vi.fn(async () => ({
        member,
        state: "in_flight" as const,
        dispatchRecipe: recipe,
      })),
      findMemberRevivalReplay: vi.fn(async () => null),
      promoteStartingMember: vi.fn(async () => true),
      requestMemberLaunchCleanup: vi.fn(async () => ({
        action: "purge" as const,
      })),
      completeMemberLaunchCleanup: vi.fn(async () => true),
    };
    const lifecycle: Pick<SessionLifecycleController, "stopSession"> = {
      stopSession: vi.fn(async () => ({
        confirmed: true,
        state: "confirmed" as const,
      })),
    };
    const eligibility: Pick<
      ApplicationTeamMailboxEligibilityService,
      "checkParticipants"
    > = {
      checkParticipants: vi.fn(async () => ({
        status: "ok" as const,
        runtimeId: "dapr-agent-py",
        agentVersion: 3,
      })),
    };
    const teamLaunch = new ApplicationTeamMemberLaunchService({
      teams,
      peers: service,
      lifecycle,
      eligibility,
    });

    await expect(
      teamLaunch.inspectNewMemberReplay(
        {
          teamId: "team-1",
          sessionId: "ca-session-1",
          name: "worker",
        },
        teamPrincipal,
        {
          prompt: recipe.request.prompt,
          title: recipe.request.title,
          skipSpawn: recipe.request.skipSpawn,
          provisionSandbox: recipe.request.provisionSandbox,
          sandboxTemplate: recipe.request.sandboxTemplate,
        },
      ),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202, body: { pending: true } },
    });
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

	it("provisions + attaches a workspace sandbox BEFORE spawn when opted in", async () => {
		const callOrder: string[] = [];
    vi.mocked(workflowSpawner.reserveSessionWorkflow).mockImplementationOnce(
      async () => {
        callOrder.push("reserve");
        return { startedAt: new Date("2026-07-21T12:00:00.000Z") };
      },
    );
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
        return true;
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
    expect(callOrder).toEqual(["reserve", "provision", "attach", "spawn"]);
		expect(result).toMatchObject({
			status: "ok",
			body: { sandboxName: "ws-peer-1" },
		});
	});

  it("deletes the workspace and refuses spawn when stop wins attachment", async () => {
    vi.mocked(sessions.attachWorkspaceSandbox).mockResolvedValueOnce(false);

    const result = await spawn(body({ provisionSandbox: true }));

    expect(result).toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "Session ca-session-1 stopped while its workspace was provisioning",
    });
    expect(sandboxDestroyer.deleteWorkspaceSandbox).toHaveBeenCalledWith(
      "ws-peer-1",
    );
    expect(workflowSpawner.releaseSessionWorkflow).toHaveBeenCalledWith(
      "ca-session-1",
      { startedAt: new Date("2026-07-21T12:00:00.000Z") },
    );
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
  });

  it("releases the exact lease even when workspace deletion throws", async () => {
    vi.mocked(sessions.attachWorkspaceSandbox).mockResolvedValueOnce(false);
    vi.mocked(sandboxDestroyer.deleteWorkspaceSandbox).mockRejectedValueOnce(
      new Error("workspace deletion failed"),
    );

    await expect(spawn(body({ provisionSandbox: true }))).resolves.toEqual({
      status: "error",
      httpStatus: 500,
      message: "workspace deletion failed",
    });
    expect(workflowSpawner.releaseSessionWorkflow).toHaveBeenCalledWith(
      "ca-session-1",
      { startedAt: new Date("2026-07-21T12:00:00.000Z") },
    );
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
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
        status: "running",
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
        runtimeAppId: "agent-session-peer",
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
    expect(
      teamMailboxDelivery.requestDeliveryAfterRuntimePublished,
    ).toHaveBeenCalledWith("ca-session-1");
  });

  it("redrives a reused row until runtime execution provides positive evidence", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: {
        ...peerSession,
        status: "rescheduling",
        daprInstanceId: "ca-session-1",
        natsSubject: "session.events.ca-session-1",
      },
      reused: true,
    });

    await expect(spawn(body())).resolves.toMatchObject({
      status: "ok",
      body: { sessionId: "ca-session-1", reused: true },
    });
    expect(workflowSpawner.reserveSessionWorkflow).toHaveBeenCalledWith(
      "ca-session-1",
    );
    expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
      "ca-session-1",
      expect.any(Object),
    );
  });

  it("treats a published rescheduling child as positive dispatch evidence", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: {
        ...peerSession,
        status: "rescheduling",
        daprInstanceId: "ca-session-1",
        natsSubject: "session.events.ca-session-1",
        runtimeAppId: "agent-session-peer",
        runtimeProvisioningStartedAt: null,
      },
      reused: true,
    });

    await expect(spawn(body())).resolves.toMatchObject({
      status: "ok",
      body: { sessionId: "ca-session-1", reused: true },
    });
    expect(workflowSpawner.reserveSessionWorkflow).not.toHaveBeenCalled();
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a reused row after child stop intent wins", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: {
        ...peerSession,
        status: "running",
        daprInstanceId: "ca-session-1",
        stopRequestedAt: new Date("2026-07-21T20:00:00.000Z"),
      },
      reused: true,
    });

    await expect(spawn(body())).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "Session ca-session-1 is stopping or terminal",
    });
    expect(workflowSpawner.reserveSessionWorkflow).not.toHaveBeenCalled();
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
  });

  it("rejects before child creation when parent stop intent exists", async () => {
    vi.mocked(workflowData.getSessionFileOwner).mockResolvedValueOnce({
      id: "parent-session-1",
      userId: "user-1",
      projectId: "project-1",
      status: "running",
      completedAt: null,
      stopRequestedAt: new Date("2026-07-21T20:00:00.000Z"),
    });

    await expect(spawn(body())).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "Peer spawn parent is stopping or terminal",
    });
    expect(workflowData.ensurePeerSession).not.toHaveBeenCalled();
	});

	it("returns dispatch context for skipSpawn callers", async () => {
    const result = await spawn(body({ skipSpawn: true }));

		expect(result).toEqual({
			status: "ok",
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
        daprInstanceId: "ca-session-1",
        natsSubject: "session.events.ca-session-1",
        runtimeAppId: "agent-session-parent",
				reused: false,
				agentConfig: { systemPrompt: "Peer" },
				environmentConfig: { image: "env-image" },
				vaultIds: ["vault-1"],
				callableAgents: dispatchContext.callableAgents,
				registryTeam: "project-1",
        workflowMcpSessionToken: "signed-child-token",
				skipSpawn: true,
        requiresStartAuthority: true,
			},
		});
		expect(workflowData.resolvePeerAgentDispatchContext).toHaveBeenCalledWith({
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
		});
    expect(sessions.attachSessionRuntime).toHaveBeenCalledWith({
      sessionId: "ca-session-1",
      expectedStartedAt: new Date("2026-07-21T12:00:00.000Z"),
      daprInstanceId: "ca-session-1",
      natsSubject: "session.events.ca-session-1",
      runtimeAppId: "agent-session-parent",
      runtimeSandboxName: "agent-host-parent",
      runtimeHostOwned: false,
    });
    expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
    expect(
      teamMailboxDelivery.requestDeliveryAfterRuntimePublished,
    ).toHaveBeenCalledWith("ca-session-1");
  });

  it("replays a successfully attached native peer after its response was lost", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: {
        ...peerSession,
        status: "rescheduling",
        daprInstanceId: "ca-session-1",
        natsSubject: "session.events.ca-session-1",
        runtimeAppId: "agent-session-parent",
        runtimeProvisioningStartedAt: null,
      },
      reused: true,
    });

    await expect(spawn(body({ skipSpawn: true }))).resolves.toEqual({
      status: "ok",
      body: {
        sessionId: "ca-session-1",
        agentId: "agent-peer",
        agentVersion: 3,
        daprInstanceId: "ca-session-1",
        natsSubject: "session.events.ca-session-1",
        runtimeAppId: "agent-session-parent",
        reused: true,
        agentConfig: { systemPrompt: "Peer" },
        environmentConfig: { image: "env-image" },
        vaultIds: ["vault-1"],
        callableAgents: dispatchContext.callableAgents,
        registryTeam: "project-1",
        workflowMcpSessionToken: "signed-child-token",
        skipSpawn: true,
        requiresStartAuthority: true,
      },
    });
    expect(workflowSpawner.reserveSessionWorkflow).not.toHaveBeenCalled();
    expect(sessions.attachSessionRuntime).not.toHaveBeenCalled();
    expect(
      teamMailboxDelivery.requestDeliveryAfterRuntimePublished,
    ).toHaveBeenCalledWith("ca-session-1");
  });

  it("rejects native replay when the published target is not the parent runtime", async () => {
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: {
        ...peerSession,
        daprInstanceId: "ca-session-1",
        runtimeAppId: "agent-session-foreign",
        runtimeProvisioningStartedAt: null,
      },
      reused: true,
    });

    await expect(spawn(body({ skipSpawn: true }))).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "Published native peer runtime does not match the parent runtime target",
    });
    expect(workflowSpawner.reserveSessionWorkflow).not.toHaveBeenCalled();
    expect(sessions.attachSessionRuntime).not.toHaveBeenCalled();
  });

  it("releases the exact lease when native runtime attachment throws", async () => {
    vi.mocked(sessions.attachSessionRuntime).mockRejectedValueOnce(
      new Error("runtime attachment failed"),
    );

    await expect(spawn(body({ skipSpawn: true }))).resolves.toEqual({
      status: "error",
      httpStatus: 500,
      message: "runtime attachment failed",
    });
    expect(workflowSpawner.releaseSessionWorkflow).toHaveBeenCalledWith(
      "ca-session-1",
      { startedAt: new Date("2026-07-21T12:00:00.000Z") },
    );
    expect(
      sessions.acknowledgeRuntimeProvisioningCompensation,
    ).not.toHaveBeenCalled();
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
    expect(
      teamMailboxDelivery.requestDeliveryAfterRuntimePublished,
    ).not.toHaveBeenCalled();
  });

  it("acknowledges the exact stopped lease when native attachment loses its race", async () => {
    vi.mocked(sessions.attachSessionRuntime).mockResolvedValueOnce(false);
    vi.mocked(workflowSpawner.releaseSessionWorkflow).mockResolvedValueOnce(
      false,
    );

    await expect(spawn(body({ skipSpawn: true }))).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "Session ca-session-1 stopped before native peer dispatch",
    });
    expect(workflowSpawner.releaseSessionWorkflow).toHaveBeenCalledWith(
      "ca-session-1",
      { startedAt: new Date("2026-07-21T12:00:00.000Z") },
    );
    expect(
      sessions.acknowledgeRuntimeProvisioningCompensation,
    ).toHaveBeenCalledWith({
      sessionId: "ca-session-1",
      expectedStartedAt: new Date("2026-07-21T12:00:00.000Z"),
    });
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

  it("returns a retriable gateway error when workflow dispatch is not confirmed", async () => {
		vi.mocked(workflowSpawner.spawnSessionWorkflow).mockRejectedValueOnce(
			new Error("Dapr unavailable"),
		);

    await expect(spawn(body())).resolves.toEqual({
      status: "error",
      httpStatus: 502,
      message: "Dapr unavailable",
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
    const result = await service.spawnPeerSession(
      body({ peerAgentVersion: 3 }),
      teamPrincipal,
      {
      kind: "team",
      teamId: "team-1",
      },
    );

    expect(result.status).toBe("ok");
    expect(workflowData.ensurePeerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        peerAgentId: "agent-peer",
        peerAgentVersion: 3,
      }),
    );
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
      service.spawnPeerSession(body({ peerAgentVersion: 3 }), principal, {
        kind: "team",
        teamId: "team-1",
      }),
    ).resolves.toMatchObject({ status: "error", httpStatus: 403 });
  });

  it("requires an explicit pinned version before any team peer effect", async () => {
    const teamPrincipal: PeerSessionSpawnPrincipal = {
      ...principal,
      capabilities: {
        scriptDepth: 1,
        teamId: "team-1",
        teamRole: "lead",
      },
    };

    await expect(
      service.spawnPeerSession(body(), teamPrincipal, {
        kind: "team",
        teamId: "team-1",
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 400,
      message: "peerAgentVersion is required for team peer spawn",
    });
    expect(workflowData.getSessionDetail).not.toHaveBeenCalled();
    expect(workflowData.ensurePeerSession).not.toHaveBeenCalled();
    expect(workflowSpawner.reserveSessionWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a reused team peer whose pinned version differs", async () => {
    const teamPrincipal: PeerSessionSpawnPrincipal = {
      ...principal,
      capabilities: {
        scriptDepth: 1,
        teamId: "team-1",
        teamRole: "lead",
      },
    };
    vi.mocked(workflowData.ensurePeerSession).mockResolvedValueOnce({
      ok: true,
      session: { ...peerSession, agentVersion: 2 },
      reused: true,
    });

    await expect(
      service.spawnPeerSession(body({ peerAgentVersion: 3 }), teamPrincipal, {
        kind: "team",
        teamId: "team-1",
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "Existing peer session does not match the requested agent and lineage",
    });
    expect(workflowData.ensurePeerSession).toHaveBeenCalledWith(
      expect.objectContaining({ peerAgentVersion: 3 }),
    );
    expect(workflowSpawner.reserveSessionWorkflow).not.toHaveBeenCalled();
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
