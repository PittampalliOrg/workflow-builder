import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionCommandService } from "$lib/server/application/session-commands";
import { CliTokenError } from "$lib/server/users/cli-credentials";
import type {
	SandboxProvisioner,
	SessionAgentResolver,
	SessionEventLog,
	SessionExperimentAgentStore,
	SessionRepository,
	SessionRepositoryMounter,
	SessionTraceLifecycleStore,
	SessionWorkflowSpawner,
} from "$lib/server/application/ports";
import type { AgentConfig } from "$lib/types/agents";
import type { SessionDetail, SessionEventEnvelope } from "$lib/types/sessions";

describe("ApplicationSessionCommandService", () => {
	let sessions: SessionRepository;
	let sessionEvents: SessionEventLog;
	let sessionAgents: SessionAgentResolver;
	let sessionExperimentAgents: SessionExperimentAgentStore;
	let sandboxProvisioner: SandboxProvisioner;
	let repositoryMounter: SessionRepositoryMounter;
	let workflowSpawner: SessionWorkflowSpawner;
	let sessionTraceLifecycle: SessionTraceLifecycleStore;
	let service: ApplicationSessionCommandService;

	beforeEach(() => {
		sessions = fakeSessions();
		sessionEvents = fakeSessionEvents();
		sessionAgents = fakeSessionAgents();
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
		};
		workflowSpawner = {
			spawnSessionWorkflow: vi.fn(async () => ({
				instanceId: "session-1",
				natsSubject: "session.events.session-1",
			})),
		};
		sessionTraceLifecycle = {
			createInteractiveSessionTraceRun: vi.fn(async () => null),
			patchInteractiveSessionTraces: vi.fn(async () => undefined),
		};
		service = new ApplicationSessionCommandService({
			sessions,
			sessionEvents,
			sessionAgents,
			sessionExperimentAgents,
			sandboxProvisioner,
			repositoryMounter,
			workflowSpawner,
			sessionTraceLifecycle,
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
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith("session-1");
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
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith("session-1");
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
		expect(workflowSpawner.spawnSessionWorkflow).toHaveBeenCalledWith("session-1");
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
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenLastCalledWith({
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

		expect(result).toEqual({ status: "not_found", message: "Session not found" });
		expect(workflowSpawner.spawnSessionWorkflow).not.toHaveBeenCalled();
	});
});

function fakeSessions(): SessionRepository {
	return {
		listSessions: vi.fn(async () => []),
		getSession: vi.fn(async () => null),
		createSession: vi.fn(async () => sampleSession()),
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
		getSessionRuntimeDebugTarget: vi.fn(async () => null),
		getBrowserSessionTarget: vi.fn(async () => null),
		listCliWorkspaceSessionCandidates: vi.fn(async () => []),
		getWorkflowEnsureSession: vi.fn(async () => null),
		createWorkflowEnsureSession: vi.fn(async () => undefined),
		updateWorkflowEnsureSessionRuntime: vi.fn(async () => undefined),
		listTerminalWorkflowSessionRuntimeHosts: vi.fn(async () => []),
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
	};
}

function fakeSessionEvents(): SessionEventLog {
	return {
		appendSessionEvent: vi.fn(async (sessionId, event) => ({
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
		}) satisfies SessionEventEnvelope),
		getSessionEvent: vi.fn(async () => null),
		listSessionEvents: vi.fn(async () => []),
	};
}

function fakeSessionAgents(): SessionAgentResolver {
	return {
		resolveSessionAgent: vi.fn(async () => ({
			id: "agent-1",
			name: "Coding Agent",
			slug: "coding-agent",
			version: 1,
			config: {} as AgentConfig,
			runtime: "dapr-agent-py",
			runtimeAppId: "agent-runtime-coding-agent",
			mlflowModelVersion: null,
			mlflowModelName: null,
			mlflowUri: null,
		})),
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
