import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "$lib/types/sessions";

const attachWorkspaceSandboxMock = vi.fn();
const createSessionMock = vi.fn();
const listSessionsMock = vi.fn();
const recordSessionSandboxProvisioningErrorMock = vi.fn();
const sendUserEventMock = vi.fn();
const spawnSessionWorkflowMock = vi.fn();
const provisionSessionSandboxWithRetryMock = vi.fn();
const sandboxProvisionFailureMessageMock = vi.fn();
const resolveAgentRefMock = vi.fn();
const findOrCreateExperimentAgentMock = vi.fn();
const isAgentConfigEquivalentMock = vi.fn();
const safeCreateInteractiveSessionMlflowRunMock = vi.fn();

vi.mock("$lib/server/sessions/registry", () => ({
	attachWorkspaceSandbox: (...args: unknown[]) =>
		attachWorkspaceSandboxMock(...args),
	createSession: (...args: unknown[]) => createSessionMock(...args),
	listSessions: (...args: unknown[]) => listSessionsMock(...args),
	recordSessionSandboxProvisioningError: (...args: unknown[]) =>
		recordSessionSandboxProvisioningErrorMock(...args),
}));

vi.mock("$lib/server/sessions/events", () => ({
	sendUserEvent: (...args: unknown[]) => sendUserEventMock(...args),
}));

vi.mock("$lib/server/sessions/spawn", () => ({
	spawnSessionWorkflow: (...args: unknown[]) => spawnSessionWorkflowMock(...args),
}));

vi.mock("$lib/server/sandboxes/provision", () => ({
	provisionSessionSandboxWithRetry: (...args: unknown[]) =>
		provisionSessionSandboxWithRetryMock(...args),
	sandboxProvisionFailureMessage: (...args: unknown[]) =>
		sandboxProvisionFailureMessageMock(...args),
}));

vi.mock("$lib/server/agents/registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

vi.mock("$lib/server/agents/ephemeral", () => ({
	findOrCreateExperimentAgent: (...args: unknown[]) =>
		findOrCreateExperimentAgentMock(...args),
}));

vi.mock("$lib/utils/agent-config-diff", () => ({
	isAgentConfigEquivalent: (...args: unknown[]) =>
		isAgentConfigEquivalentMock(...args),
}));

vi.mock("$lib/server/observability/mlflow-lifecycle", () => ({
	safeCreateInteractiveSessionMlflowRun: (...args: unknown[]) =>
		safeCreateInteractiveSessionMlflowRunMock(...args),
}));

import { POST } from "./+server";

describe("POST /api/v1/sessions sandbox provisioning", () => {
	beforeEach(() => {
		attachWorkspaceSandboxMock.mockReset();
		createSessionMock.mockReset();
		listSessionsMock.mockReset();
		recordSessionSandboxProvisioningErrorMock.mockReset();
		sendUserEventMock.mockReset();
		spawnSessionWorkflowMock.mockReset();
		provisionSessionSandboxWithRetryMock.mockReset();
		sandboxProvisionFailureMessageMock.mockReset();
		resolveAgentRefMock.mockReset();
		findOrCreateExperimentAgentMock.mockReset();
		isAgentConfigEquivalentMock.mockReset();
		safeCreateInteractiveSessionMlflowRunMock.mockReset();

		createSessionMock.mockResolvedValue(sampleSession());
		resolveAgentRefMock.mockResolvedValue(sampleAgent());
		safeCreateInteractiveSessionMlflowRunMock.mockResolvedValue(null);
		spawnSessionWorkflowMock.mockResolvedValue({
			instanceId: "session-1",
			natsSubject: "session.events.session-1",
		});
		sandboxProvisionFailureMessageMock.mockImplementation((err: unknown) =>
			err instanceof Error
				? `OpenShell sandbox provisioning failed: ${err.message}`
				: "OpenShell sandbox provisioning failed",
		);
	});

	it("attaches a successfully provisioned eager sandbox", async () => {
		provisionSessionSandboxWithRetryMock.mockResolvedValue({
			sandboxName: "ws-ready",
			workspaceRef: "workspace/ws-ready",
			rootPath: "/sandbox",
		});

		const response = (await POST(
			sessionCreateEvent({ agentId: "agent-1" }),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(provisionSessionSandboxWithRetryMock).toHaveBeenCalledWith({
			executionId: "session-1",
			name: "Session 1",
			sandboxTemplate: "base",
			keepAfterRun: true,
		});
		expect(attachWorkspaceSandboxMock).toHaveBeenCalledWith(
			"session-1",
			"ws-ready",
		);
		expect(recordSessionSandboxProvisioningErrorMock).not.toHaveBeenCalled();
		expect(body.session.workspaceSandboxName).toBe("ws-ready");
		expect(body.session.errorMessage).toBeNull();
	});

	it("persists the final eager sandbox provisioning failure while keeping session create non-fatal", async () => {
		const err = new Error(
			"status: Internal, message: failed to decode Protobuf message",
		);
		provisionSessionSandboxWithRetryMock.mockRejectedValue(err);

		const response = (await POST(
			sessionCreateEvent({ agentId: "agent-1" }),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(recordSessionSandboxProvisioningErrorMock).toHaveBeenCalledWith(
			"session-1",
			"OpenShell sandbox provisioning failed: status: Internal, message: failed to decode Protobuf message",
		);
		expect(body.session.workspaceSandboxName).toBeNull();
		expect(body.session.errorMessage).toBe(
			"OpenShell sandbox provisioning failed: status: Internal, message: failed to decode Protobuf message",
		);
		expect(spawnSessionWorkflowMock).toHaveBeenCalledWith("session-1");
	});
});

function sessionCreateEvent(body: Record<string, unknown>): never {
	return {
		request: new Request("http://localhost/api/v1/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			session: {
				userId: "user-1",
				projectId: "project-1",
			},
		},
	} as never;
}

function sampleAgent() {
	return {
		id: "agent-1",
		name: "Coding Agent",
		slug: "coding-agent",
		version: 1,
		config: {},
		runtimeAppId: "agent-runtime-coding-agent",
		mlflowModelVersion: null,
		mlflowModelName: null,
		mlflowUri: null,
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
		sandboxName: "dapr-agent-py",
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
	};
}
