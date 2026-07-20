import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionCommandService } from "$lib/server/application/session-commands";
import { CliTokenError } from "$lib/server/application/cli-credentials";
import type {
	AgentRuntimeSyncPort,
	SandboxProvisioner,
	SessionAgentResolver,
	SessionAgentSlugResolver,
	SessionEventLog,
	SessionExperimentAgentStore,
	SessionRepository,
	SessionRepositoryMounter,
	SessionSandboxDestroyer,
	SessionWorkflowSpawner,
	WorkspaceProjectRepository,
	WorkflowEphemeralAgentStore,
	WorkflowPublishedAgent,
} from "$lib/server/application/ports";
import type { AgentConfig } from "$lib/types/agents";
import type {
	SessionDetail,
	SessionEventEnvelope,
	SessionSummary,
} from "$lib/types/sessions";

describe("ApplicationSessionCommandService", () => {
	let sessions: SessionRepository;
	let sessionEvents: SessionEventLog;
	let sessionAgents: SessionAgentResolver;
	let sessionAgentSlugs: SessionAgentSlugResolver;
	let sessionExperimentAgents: SessionExperimentAgentStore;
	let sandboxProvisioner: SandboxProvisioner;
	let repositoryMounter: SessionRepositoryMounter;
	let sandboxDestroyer: SessionSandboxDestroyer;
	let workflowSpawner: SessionWorkflowSpawner;
	let workspaceProjects: WorkspaceProjectRepository;
	let workflowEphemeralAgents: WorkflowEphemeralAgentStore;
	let agentRuntimeSync: AgentRuntimeSyncPort;
	let service: ApplicationSessionCommandService;

	beforeEach(() => {
		sessions = fakeSessions();
		sessionEvents = fakeSessionEvents();
		sessionAgents = fakeSessionAgents();
		sessionAgentSlugs = {
			resolveSessionAgentIdBySlug: vi.fn(async () => "agent-1"),
		};
		sessionExperimentAgents = fakeSessionExperimentAgents();
		sandboxProvisioner = {
			provision: vi.fn(async () => ({
				sandboxName: "ws-ready",
				workspaceRef: "workspace/ws-ready",
				rootPath: "/sandbox",
			})),
		};
		repositoryMounter = {
			mountSessionRepositories: vi.fn(async () => undefined),
			mountSessionRepositoriesViaHost: vi.fn(async () => undefined),
			mountSessionRepository: vi.fn(async () => undefined),
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
		workflowSpawner = {
			spawnSessionWorkflow: vi.fn(async () => ({
				instanceId: "session-1",
				natsSubject: "session.events.session-1",
			})),
		};
		workspaceProjects = fakeWorkspaceProjects();
		workflowEphemeralAgents = {
			findOrCreateWorkflowEphemeralAgent: vi.fn(async () => ({
				agentId: "workflow-ephemeral-agent-1",
				agentVersion: 3,
			})),
		};
		agentRuntimeSync = {
			syncAgentRuntime: vi.fn(async () => undefined),
		};
		service = new ApplicationSessionCommandService({
			sessions,
			sessionEvents,
			sessionAgents,
			sessionAgentSlugs,
			sessionExperimentAgents,
			sandboxProvisioner,
			repositoryMounter,
			workflowSpawner,
			workspaceProjects,
			sandboxDestroyer,
			workflowEphemeralAgents,
			agentRuntimeSync,
		});
	});

	it("creates an eager session through ports and attaches the provisioned sandbox", async () => {
		const result = await service.createInteractiveSession({
			userId: "user-1",
			projectId: "project-1",
			body: { agentId: "agent-1", initialMessage: "hello" },
		});

		expect(result.status).toBe("created");
		if (result.status !== "created") return;
		expect(sessions.createSession).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: undefined,
			environmentId: undefined,
			environmentVersion: undefined,
			vaultIds: undefined,
			title: undefined,
			userId: "user-1",
			projectId: "project-1",
			resumedFromSessionId: null,
		});
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "user.message",
			data: {
				type: "user.message",
				content: [{ type: "text", text: "hello" }],
			},
			processedAt: null,
		});
		expect(sandboxProvisioner.provision).toHaveBeenCalledWith({
			executionId: "session-1",
			name: "Session 1",
			sandboxTemplate: "base",
			keepAfterRun: true,
		});
		expect(sessions.attachWorkspaceSandbox).toHaveBeenCalledWith({
			sessionId: "session-1",
			workspaceSandboxName: "ws-ready",
		});
    expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
      "session-1",
    );
		expect(result.session.workspaceSandboxName).toBe("ws-ready");
		expect(result.session.daprInstanceId).toBe("session-1");
	});

	it("keeps session creation non-fatal when eager sandbox provisioning fails", async () => {
		vi.mocked(sandboxProvisioner.provision).mockRejectedValue(
			new Error("failed to decode Protobuf message"),
		);

		const result = await service.createInteractiveSession({
			userId: "user-1",
			projectId: "project-1",
			body: { agentId: "agent-1" },
		});

		expect(result.status).toBe("created");
		if (result.status !== "created") return;
		expect(sessions.recordSandboxProvisioningError).toHaveBeenCalledWith({
			sessionId: "session-1",
			errorMessage:
				"OpenShell sandbox provisioning failed: failed to decode Protobuf message",
		});
		expect(repositoryMounter.mountSessionRepositories).not.toHaveBeenCalled();
    expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
      "session-1",
    );
		expect(result.session.errorMessage).toBe(
			"OpenShell sandbox provisioning failed: failed to decode Protobuf message",
		);
	});

	it("returns existing workflow runtime when the session is already started", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue({
			...sampleSession(),
			daprInstanceId: "existing-instance",
			natsSubject: "session.events.existing-instance",
		});

		const result = await service.startSessionWorkflow({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({
			status: "already_started",
			instanceId: "existing-instance",
			natsSubject: "session.events.existing-instance",
			alreadyStarted: true,
		});
		expect(sessions.updateSessionStatusUnlessTerminated).not.toHaveBeenCalled();
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("starts an unstarted session through workflow spawner and status ports", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue(sampleSession());

		const result = await service.startSessionWorkflow({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({
			status: "started",
			instanceId: "session-1",
			natsSubject: "session.events.session-1",
			alreadyStarted: false,
		});
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith({
			id: "session-1",
			status: "rescheduling",
			errorMessage: null,
		});
    expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
      "session-1",
    );
	});

	it("keeps CLI token spawn failures retry-safe and returns a precondition result", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue(sampleSession());
		vi.mocked(workflowSpawner.spawnSessionWorkflow).mockRejectedValue(
			new CliTokenError("CLI_TOKEN_MISSING", "agy", "AGY login required"),
		);

		const result = await service.startSessionWorkflow({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({
			status: "precondition_failed",
			code: "CLI_TOKEN_MISSING",
			provider: "agy",
			settingsPath: "/settings/cli-tokens",
			message: "AGY login required",
		});
    expect(
      sessions.updateSessionStatusUnlessTerminated,
    ).toHaveBeenLastCalledWith({
			id: "session-1",
			status: "rescheduling",
			errorMessage: "AGY login required",
		});
	});

	it("does not start sessions outside the caller project", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue({
			...sampleSession(),
			projectId: "other-project",
		});

		const result = await service.startSessionWorkflow({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
		});

    expect(result).toEqual({
      status: "not_found",
      message: "Session not found",
    });
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("adds a session resource through ports without mounting when no sandbox is live", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue(sampleSession());

		const result = await service.addSessionResource({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
			body: { type: "file", fileId: "file-1", mountPath: "/sandbox/file.txt" },
		});

		expect(result.status).toBe("created");
		if (result.status !== "created") return;
		expect(sessions.addSessionResource).toHaveBeenCalledWith({
			sessionId: "session-1",
			resource: {
				type: "file",
				fileId: "file-1",
				mountPath: "/sandbox/file.txt",
				repoUrl: undefined,
				checkoutRef: undefined,
				authTokenCredentialId: undefined,
				appConnectionExternalId: undefined,
			},
		});
		expect(sandboxProvisioner.provision).not.toHaveBeenCalled();
		expect(repositoryMounter.mountSessionRepository).not.toHaveBeenCalled();
	});

	it("mounts a newly added repository into an existing live sandbox", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue({
			...sampleSession(),
			workspaceSandboxName: "ws-ready",
		});

		const result = await service.addSessionResource({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
			body: {
				type: "github_repository",
				repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
				checkoutRef: "main",
				mountPath: "/sandbox/workflow-builder",
			},
		});

		expect(result.status).toBe("created");
		if (result.status !== "created") return;
		expect(sandboxProvisioner.provision).toHaveBeenCalledWith({
			executionId: "session-1",
			name: "Session 1",
			keepAfterRun: true,
		});
		expect(repositoryMounter.mountSessionRepository).toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({
				type: "github_repository",
				repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
				checkoutRef: "main",
				mountPath: "/sandbox/workflow-builder",
			}),
			{
				executionId: "session-1",
				workspaceRef: "workspace/ws-ready",
				rootPath: "/sandbox",
			},
		);
	});

	it("materializes workflow session repositories through resource and mount ports", async () => {
		await service.materializeWorkflowSessionRepositories({
			sessionId: "session-1",
			repositories: [
				{
					repoUrl: " https://github.com/PittampalliOrg/workflow-builder ",
					checkoutRef: "main",
					mountPath: "/sandbox/workflow-builder",
					authTokenCredentialId: "credential-1",
					appConnectionExternalId: "connection-1",
				},
			],
			workflowExecutionId: "execution-1",
			workspaceRef: "workspace/ws-ready",
			cwd: "/sandbox",
		});

		expect(sessions.listSessionResources).toHaveBeenCalledWith("session-1");
		expect(sessions.addSessionResource).toHaveBeenCalledWith({
			sessionId: "session-1",
			resource: {
				type: "github_repository",
				repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
				checkoutRef: "main",
				mountPath: "/sandbox/workflow-builder",
				authTokenCredentialId: "credential-1",
				appConnectionExternalId: "connection-1",
			},
		});
		expect(repositoryMounter.mountSessionRepositories).toHaveBeenCalledWith(
			"session-1",
			{
				executionId: "execution-1",
				workspaceRef: "workspace/ws-ready",
				rootPath: "/sandbox",
			},
		);
	});

	it("does not duplicate workflow repository resources when one already exists", async () => {
		vi.mocked(sessions.listSessionResources).mockResolvedValue([
			{
				id: "resource-1",
				sessionId: "session-1",
				type: "github_repository",
				fileId: null,
				mountPath: null,
				repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
				checkoutRef: null,
				authTokenCredentialId: null,
				appConnectionExternalId: null,
				mountedAt: null,
				removedAt: null,
			},
		]);

		await service.materializeWorkflowSessionRepositories({
			sessionId: "session-1",
			repositories: [
				{ repoUrl: "https://github.com/PittampalliOrg/workflow-builder" },
			],
			workflowExecutionId: "execution-1",
			workspaceRef: "workspace/ws-ready",
			cwd: null,
		});

		expect(sessions.addSessionResource).not.toHaveBeenCalled();
		expect(repositoryMounter.mountSessionRepositories).toHaveBeenCalledWith(
			"session-1",
			{
				executionId: "execution-1",
				workspaceRef: "workspace/ws-ready",
				rootPath: null,
			},
		);
	});

	it("delegates host repository mounts through the repository mounter port", async () => {
		await service.materializeSessionRepositoriesViaHost({
			sessionId: "session-1",
			hostBaseUrl: "http://agent-runtime:8002",
		});

    expect(
      repositoryMounter.mountSessionRepositoriesViaHost,
    ).toHaveBeenCalledWith("session-1", "http://agent-runtime:8002");
	});

	it("reaps terminal workflow session hosts through the sandbox destroyer port", async () => {
    vi.mocked(
      sessions.listReapableWorkflowSessionRuntimeHosts,
    ).mockResolvedValue([
			{ sessionId: "old-session", runtimeAppId: "agent-session-old" },
			{ sessionId: "session-1", runtimeAppId: "agent-session-current" },
		]);

		await service.reapTerminatedWorkflowSessionRuntimeHosts({
			workflowExecutionId: "execution-1",
			exceptSessionId: "session-1",
		});

    expect(
      sessions.listReapableWorkflowSessionRuntimeHosts,
    ).toHaveBeenCalledWith({
			workflowExecutionId: "execution-1",
		});
		expect(sandboxDestroyer.deleteRuntimeSandbox).toHaveBeenCalledWith(
			"agent-host-agent-session-old",
		);
		expect(sandboxDestroyer.deleteRuntimeSandbox).not.toHaveBeenCalledWith(
			"agent-host-agent-session-current",
		);
	});

	it("appends workflow swap degradation events through the event-log port", async () => {
		await service.appendWorkflowSessionSwapDegradedEvent({
			sessionId: "session-1",
			runtimeId: "agy-cli",
			decision: "warn",
			drops: [{ capability: "mcp", severity: "warn" }],
		});

		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "runtime.swap_degraded",
			data: {
				runtimeId: "agy-cli",
				decision: "warn",
				drops: [{ capability: "mcp", severity: "warn" }],
			},
			sourceEventId: "swap:session-1:agy-cli",
		});
	});

	it("appends workflow initial user messages through the event-log port", async () => {
		await service.appendWorkflowSessionInitialMessage({
			sessionId: "session-1",
			text: " hello ",
		});

		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "user.message",
			data: {
				type: "user.message",
				content: [{ type: "text", text: "hello" }],
			},
			processedAt: null,
		});
	});

	it("resolves published workflow session agents without touching the ephemeral store", async () => {
		const publishedAgent: WorkflowPublishedAgent = {
			agentId: "agent-published",
			agentVersion: 9,
			agentSlug: "published-agent",
			agentAppId: "agent-runtime-published-agent",
			mlflowUri: null,
			mlflowModelName: null,
			mlflowModelVersion: null,
		};

		const result = await service.resolveWorkflowSessionAgent({
			publishedAgent,
			workflowId: "workflow-1",
			nodeId: "run-agent",
			agentConfig: { runtime: "codex-cli" } as AgentConfig,
			userId: "user-1",
		});

		expect(result).toEqual({
			agentId: "agent-published",
			agentVersion: 9,
		});
		expect(
			workflowEphemeralAgents.findOrCreateWorkflowEphemeralAgent,
		).not.toHaveBeenCalled();
	});

	it("resolves inline workflow session agents through the ephemeral-agent port", async () => {
		const agentConfig = {
			runtime: "codex-cli",
			modelSpec: "openai/gpt-5.5",
		} as AgentConfig;

		const result = await service.resolveWorkflowSessionAgent({
			publishedAgent: null,
			workflowId: "workflow-1",
			nodeId: "run-agent",
			agentConfig,
			userId: "user-1",
		});

		expect(
			workflowEphemeralAgents.findOrCreateWorkflowEphemeralAgent,
		).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			nodeId: "run-agent",
			agentConfig,
			userId: "user-1",
		});
		expect(result).toEqual({
			agentId: "workflow-ephemeral-agent-1",
			agentVersion: 3,
		});
	});

	it("syncs workflow session agent runtimes through the runtime-sync port", async () => {
		await service.syncWorkflowSessionAgentRuntime({ agentId: "agent-1" });

		expect(agentRuntimeSync.syncAgentRuntime).toHaveBeenCalledWith("agent-1");
	});

	it("propagates runtime sync failures unless best-effort is requested", async () => {
		vi.mocked(agentRuntimeSync.syncAgentRuntime).mockRejectedValueOnce(
			new Error("sync failed"),
		);

		await expect(
			service.syncWorkflowSessionAgentRuntime({ agentId: "agent-1" }),
		).rejects.toThrow("sync failed");
	});

	it("keeps best-effort runtime sync failures non-fatal", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.mocked(agentRuntimeSync.syncAgentRuntime).mockRejectedValueOnce(
			new Error("sync failed"),
		);

		await expect(
			service.syncWorkflowSessionAgentRuntime({
				agentId: "agent-1",
				bestEffort: true,
				context: "existing session session-1",
			}),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(
			"[sessions] sync runtime for existing session session-1 failed:",
			"sync failed",
		);
		warn.mockRestore();
	});

	it("drops malformed agent-trigger commands before touching adapters", async () => {
		const result = await service.dispatchAgentTrigger({
			body: { data: { projectId: "project-1" } },
		});

		expect(result).toEqual({ status: "ack", outcome: "missing_fields" });
    expect(
      sessionAgentSlugs.resolveSessionAgentIdBySlug,
    ).not.toHaveBeenCalled();
		expect(sessionAgents.resolveSessionAgent).not.toHaveBeenCalled();
		expect(workspaceProjects.getProjectMembershipDetail).not.toHaveBeenCalled();
		expect(sessions.createSession).not.toHaveBeenCalled();
	});

	it("drops agent-trigger commands when the named agent cannot be resolved", async () => {
    vi.mocked(
      sessionAgentSlugs.resolveSessionAgentIdBySlug,
    ).mockResolvedValueOnce(null);

		const result = await service.dispatchAgentTrigger({
			body: agentTriggerBody(),
		});

		expect(result).toEqual({ status: "ack", outcome: "agent_not_found" });
		expect(sessionAgentSlugs.resolveSessionAgentIdBySlug).toHaveBeenCalledWith(
			"writer",
		);
		expect(sessionAgents.resolveSessionAgent).not.toHaveBeenCalled();
		expect(workspaceProjects.getProjectMembershipDetail).not.toHaveBeenCalled();
		expect(sessions.createSession).not.toHaveBeenCalled();
	});

	it("drops agent-trigger commands when the agent belongs to another project", async () => {
		vi.mocked(sessionAgents.resolveSessionAgent).mockResolvedValueOnce({
			...sampleSessionAgent(),
			projectId: "other-project",
		});

		const result = await service.dispatchAgentTrigger({
			body: agentTriggerBody(),
		});

		expect(result).toEqual({
			status: "ack",
			outcome: "project_mismatch",
			agentId: "agent-1",
		});
		expect(workspaceProjects.getProjectMembershipDetail).not.toHaveBeenCalled();
		expect(sessions.createSession).not.toHaveBeenCalled();
	});

	it("drops agent-trigger commands when the user is not a project member", async () => {
    vi.mocked(
      workspaceProjects.getProjectMembershipDetail,
    ).mockResolvedValueOnce(null);

		const result = await service.dispatchAgentTrigger({
			body: agentTriggerBody(),
		});

		expect(result).toEqual({
			status: "ack",
			outcome: "not_member",
			agentId: "agent-1",
		});
		expect(workspaceProjects.getProjectMembershipDetail).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
		expect(sessions.createSession).not.toHaveBeenCalled();
	});

	it("short-circuits duplicate agent-trigger sessions", async () => {
		vi.mocked(sessions.getSession).mockResolvedValueOnce(sampleSession());

		const result = await service.dispatchAgentTrigger({
			body: agentTriggerBody(),
		});

		expect(result).toEqual({
			status: "ack",
			outcome: "duplicate",
			sessionId: expect.stringMatching(/^evt-[a-f0-9]{40}$/),
			agentId: "agent-1",
		});
		expect(sessions.createSession).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("creates deterministic agent-trigger sessions, appends the objective, and spawns", async () => {
		const result = await service.dispatchAgentTrigger({
			body: agentTriggerBody(),
		});

		expect(sessionAgentSlugs.resolveSessionAgentIdBySlug).toHaveBeenCalledWith(
			"writer",
		);
		expect(sessionAgents.resolveSessionAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: undefined,
		});
		expect(sessions.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				id: expect.stringMatching(/^evt-[a-f0-9]{40}$/),
				agentId: "agent-1",
				agentVersion: 1,
				title: "Triggered · Coding Agent",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "user.message",
			data: {
				type: "user.message",
				content: [{ type: "text", text: "Draft the update" }],
			},
			processedAt: null,
		});
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith(
			"session-1",
		);
		expect(result).toEqual({
			status: "ack",
			outcome: "started",
			sessionId: "session-1",
			agentId: "agent-1",
		});
	});

	it("keeps agent-trigger spawn failures ack-safe", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
		vi.mocked(workflowSpawner.spawnSessionWorkflow).mockRejectedValueOnce(
			new Error("spawn failed"),
		);

		const result = await service.dispatchAgentTrigger({
			body: agentTriggerBody(),
		});

		expect(result).toEqual({
			status: "ack",
			outcome: "failed",
			message: "spawn failed",
		});
		expect(error).toHaveBeenCalledWith(
			"[agent-trigger] dispatch failed:",
			"spawn failed",
		);
		error.mockRestore();
	});

	it("rejects invalid session resource payloads before touching persistence", async () => {
		const result = await service.addSessionResource({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
			body: { type: "unknown" },
		});

		expect(result).toEqual({
			status: "invalid",
			message: "type must be 'file' or 'github_repository'",
		});
		expect(sessions.getSession).not.toHaveBeenCalled();
		expect(sessions.addSessionResource).not.toHaveBeenCalled();
	});
});

function agentTriggerBody(overrides: Record<string, unknown> = {}) {
	return {
		id: "ce-1",
		data: {
			agentSlug: "writer",
			projectId: "project-1",
			userId: "user-1",
			objective: "Draft the update",
			dedupKey: "source:event:1",
			...overrides,
		},
	};
}

function fakeSessions(): SessionRepository {
	return {
		listSessions: vi.fn(async () => []),
		getSession: vi.fn(async () => null),
		createSession: vi.fn(async () => sampleSession()),
		ensureSession: vi.fn(async () => ({
			session: sampleSession(),
			created: true,
		})),
		updateSessionTitle: vi.fn(async () => null),
		archiveSession: vi.fn(async () => false),
		deleteSession: vi.fn(async () => false),
		listSessionResources: vi.fn(async () => []),
		addSessionResource: vi.fn(async (input) => ({
			id: "resource-1",
			sessionId: input.sessionId,
			type: input.resource.type,
			fileId: input.resource.fileId ?? null,
			mountPath: input.resource.mountPath ?? null,
			repoUrl: input.resource.repoUrl ?? null,
			checkoutRef: input.resource.checkoutRef ?? null,
			authTokenCredentialId: input.resource.authTokenCredentialId ?? null,
			appConnectionExternalId: input.resource.appConnectionExternalId ?? null,
			mountedAt: null,
			removedAt: null,
		})),
		attachWorkspaceSandbox: vi.fn(async () => undefined),
		recordSandboxProvisioningError: vi.fn(async () => undefined),
		removeSessionResource: vi.fn(async () => false),
		getSessionProvisioningContext: vi.fn(async () => null),
		getSessionContextUsage: vi.fn(async () => null),
		getSessionOwnerUserId: vi.fn(async () => null),
		attachSessionRuntime: vi.fn(async () => undefined),
		getSessionRuntimeTarget: vi.fn(async () => null),
		getSessionRuntimeDebugTarget: vi.fn(async () => null),
		getBrowserSessionTarget: vi.fn(async () => null),
		listCliWorkspaceSessionCandidates: vi.fn(async () => []),
		listLivenessReconcileCandidates: vi.fn(async () => []),
		listWorkflowExecutionSessionRuntimes: vi.fn(async () => []),
		listSandboxSessionOwners: vi.fn(async () => []),
		getWorkflowEnsureSession: vi.fn(async () => null),
		createWorkflowEnsureSession: vi.fn(async () => undefined),
		updateWorkflowEnsureSessionRuntime: vi.fn(async () => undefined),
		listReapableWorkflowSessionRuntimeHosts: vi.fn(async () => []),
		createSessionFork: vi.fn(async () => ({ id: "fork-1" })),
		getPeerSession: vi.fn(async () => null),
		createPeerSession: vi.fn(async () => {
			throw new Error("not used");
		}),
		findSessionIdByDaprInstanceId: vi.fn(async () => null),
		resolveSessionIdForProvisioningEvent: vi.fn(async () => null),
		getSessionFileOwner: vi.fn(async () => null),
		getSessionWorkflowContext: vi.fn(async () => null),
		updateSessionStatus: vi.fn(async () => undefined),
		updateSessionStatusUnlessTerminated: vi.fn(async () => undefined),
		updateSessionStatusRescheduled: vi.fn(async () => undefined),
		bumpSessionLastEventAt: vi.fn(async () => undefined),
		setSessionPendingInput: vi.fn(async () => undefined),
	};
}

function fakeSessionEvents(): SessionEventLog {
	return {
    appendSessionEvent: vi.fn(
      async (sessionId, event) =>
        ({
			id: "event-1",
			sessionId,
			sequence: 1,
			type: event.type,
			data: event.data ?? {},
			processedAt: null,
			sourceEventId: event.sourceEventId ?? null,
			producerId: event.producerId ?? null,
			producerEpoch: event.producerEpoch ?? null,
			createdAt: "2026-05-15T12:00:00.000Z",
			timestamp: "2026-05-15T12:00:00.000Z",
        }) satisfies SessionEventEnvelope,
    ),
		getSessionEvent: vi.fn(async () => null),
		listSessionEvents: vi.fn(async () => []),
		claimUnraisedTeamEvents: vi.fn(async () => []),
		unclaimSessionEvents: vi.fn(async () => {}),
	};
}

function fakeSessionAgents(): SessionAgentResolver {
	return {
		resolveSessionAgent: vi.fn(async () => sampleSessionAgent()),
	};
}

function sampleSessionAgent() {
	return {
		id: "agent-1",
		name: "Coding Agent",
		slug: "coding-agent",
		version: 1,
		projectId: "project-1",
		config: {} as AgentConfig,
		runtime: "dapr-agent-py",
		runtimeAppId: "agent-runtime-coding-agent",
		mlflowModelVersion: null,
		mlflowModelName: null,
		mlflowUri: null,
	};
}

function fakeSessionExperimentAgents(): SessionExperimentAgentStore {
	return {
		resolveSessionForkBaseAgent: vi.fn(async () => null),
		findOrCreateSessionExperimentAgent: vi.fn(async () => ({
			agentId: "experiment-agent-1",
			agentVersion: 1,
		})),
	};
}

function fakeWorkspaceProjects(): WorkspaceProjectRepository {
	const createdAt = new Date("2026-05-15T12:00:00.000Z");
	return {
    hasActiveProjectMembership: vi.fn(async () => true),
		getMemberProjectId: vi.fn(async () => "project-1"),
		getFallbackMemberProjectId: vi.fn(async () => "project-1"),
		listWorkspaceMemberships: vi.fn(async () => [
			{
				id: "project-1",
				displayName: "Project",
				externalId: "workspace-1",
				role: "OPERATOR" as const,
				createdAt,
			},
		]),
		createWorkspaceProject: vi.fn(async (input) => ({
			id: "project-created",
			displayName: input.displayName,
			externalId: input.externalId,
			role: "ADMIN" as const,
			createdAt,
		})),
		updateWorkspaceDisplayName: vi.fn(async () => true),
		getMemberProjectIdBySlug: vi.fn(async () => "project-1"),
		getProjectExternalId: vi.fn(async () => "workspace-1"),
		getProjectMembershipDetail: vi.fn(async () => ({
			id: "project-1",
			displayName: "Project",
			externalId: "workspace-1",
			selfRole: "OPERATOR",
		})),
		getProjectMemberRole: vi.fn(async () => "OPERATOR" as const),
		listProjectMembers: vi.fn(async () => []),
		findPlatformUserForProject: vi.fn(async () => ({
			ok: true as const,
			userId: "user-1",
		})),
		getProjectMember: vi.fn(async () => null),
		projectMemberExists: vi.fn(async () => true),
		countProjectAdmins: vi.fn(async () => 1),
		addProjectMember: vi.fn(async () => ({
			id: "member-1",
			projectId: "project-1",
			userId: "user-1",
			role: "OPERATOR" as const,
			createdAt,
			updatedAt: createdAt,
		})),
		updateProjectMemberRole: vi.fn(async () => null),
		deleteProjectMember: vi.fn(async () => undefined),
	};
}

function sampleSession(): SessionDetail {
	return {
		id: "session-1",
		title: "Session 1",
		status: "rescheduling",
		stopReason: null,
		agentId: "agent-1",
		agentVersion: 1,
		projectId: "project-1",
		environmentId: null,
		environmentVersion: null,
		vaultIds: [],
		usage: {},
		errorMessage: null,
		workflowExecutionId: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		mlflowParentRunId: null,
		mlflowSessionId: "session-1",
		workflowId: null,
		workflowName: null,
		agentName: "Coding Agent",
		agentSlug: "coding-agent",
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-05-15T12:00:00.000Z",
		updatedAt: "2026-05-15T12:00:00.000Z",
		lastEventAt: null,
		pendingInput: null,
		completedAt: null,
		archivedAt: null,
		daprInstanceId: null,
		natsSubject: null,
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: "dapr-agent-py",
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
		pausedAt: null,
	};
}

describe("ApplicationSessionCommandService.getSessionListPage", () => {
	function mkSummary(
		overrides: Partial<SessionSummary> & { id: string },
	): SessionSummary {
		return {
			title: overrides.id,
			status: "idle",
			stopReason: null,
			agentId: "agent-1",
			agentVersion: 1,
			projectId: "proj-1",
			environmentId: null,
			environmentVersion: null,
			vaultIds: [],
			usage: {},
			errorMessage: null,
			workflowExecutionId: null,
			mlflowExperimentId: null,
			mlflowRunId: null,
			mlflowParentRunId: null,
			mlflowSessionId: null,
			workflowId: null,
			workflowName: null,
			agentName: "Agent",
			agentSlug: "claude-code",
			agentAvatar: null,
			agentEphemeral: false,
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
			completedAt: null,
			archivedAt: null,
			...overrides,
		} as SessionSummary;
	}

	function makeService(rows: SessionSummary[], devWorkflowId: string | null) {
		const listSessions = vi.fn(async () => rows);
		const findProjectWorkflowIdByIdOrNamePrefix = vi.fn(
			async () => devWorkflowId,
		);
		const service = new ApplicationSessionCommandService({
			sessions: { listSessions } as unknown as SessionRepository,
			sessionEvents: {} as SessionEventLog,
			sessionAgents: {} as SessionAgentResolver,
			sessionExperimentAgents: {} as SessionExperimentAgentStore,
			sandboxProvisioner: {} as SandboxProvisioner,
			repositoryMounter: {} as SessionRepositoryMounter,
			workflowSpawner: {} as SessionWorkflowSpawner,
			devSessionWorkflows: { findProjectWorkflowIdByIdOrNamePrefix },
		});
		return { service, listSessions, findProjectWorkflowIdByIdOrNamePrefix };
	}

	it("classifies each row and derives hasMore from limit+1", async () => {
		const rows = [
			mkSummary({ id: "s1" }),
			mkSummary({ id: "s2", agentSlug: "exp-abc" }),
			mkSummary({ id: "s3", workflowExecutionId: "e3", workflowId: "wf-x" }),
		];
		const { service, listSessions } = makeService(rows, null);
		const page = await service.getSessionListPage({
			projectId: "proj-1",
			limit: 2,
		});
		// limit+1 requested
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 3, offset: 0 }),
		);
		expect(page.hasMore).toBe(true);
		expect(page.sessions.map((s) => [s.id, s.kind])).toEqual([
			["s1", "interactive"],
			["s2", "experiment"],
		]);
	});

	it("server-narrows kind=dev to the resolved workflow id", async () => {
		const rows = [mkSummary({ id: "d1", workflowId: "wf-dev-42" })];
		const { service, listSessions } = makeService(rows, "wf-dev-42");
		const page = await service.getSessionListPage({
			projectId: "proj-1",
			kind: "dev",
			limit: 10,
		});
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({ workflowId: "wf-dev-42" }),
		);
		expect(page.devWorkflowId).toBe("wf-dev-42");
		expect(page.sessions[0].kind).toBe("dev");
	});

	it("server-narrows kind=workflow to source=workflow", async () => {
		const rows = [
			mkSummary({ id: "w1", workflowExecutionId: "e", workflowId: "wf-a" }),
		];
		const { service, listSessions } = makeService(rows, null);
		await service.getSessionListPage({
			projectId: "proj-1",
			kind: "workflow",
			limit: 10,
		});
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({ source: "workflow" }),
		);
	});

	it("post-filters interactive out of the direct set (drops experiments)", async () => {
		const rows = [
			mkSummary({ id: "i1" }),
			mkSummary({ id: "x1", agentSlug: "exp-y" }),
		];
		const { service, listSessions } = makeService(rows, null);
		const page = await service.getSessionListPage({
			projectId: "proj-1",
			kind: "interactive",
			limit: 10,
		});
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({ source: "direct" }),
		);
		expect(page.sessions.map((s) => s.id)).toEqual(["i1"]);
	});

	it("passes offset through for load-more paging", async () => {
		const { service, listSessions } = makeService([], null);
    await service.getSessionListPage({
      projectId: "proj-1",
      offset: 50,
      limit: 50,
    });
		expect(listSessions).toHaveBeenCalledWith(
			expect.objectContaining({ offset: 50, limit: 51 }),
		);
	});
});
