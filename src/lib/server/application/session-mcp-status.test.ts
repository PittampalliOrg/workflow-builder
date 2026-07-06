import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionMcpStatusService } from "$lib/server/application/session-mcp-status";
import type {
	SessionMcpAgentConfigReader,
	SessionMcpCredentialStatusReader,
	WorkflowDataService,
} from "$lib/server/application/ports";
import type { SessionDetail } from "$lib/types/sessions";

describe("ApplicationSessionMcpStatusService", () => {
	let workflowData: Pick<WorkflowDataService, "getSessionEventStreamSnapshot">;
	let agentConfigs: SessionMcpAgentConfigReader;
	let credentials: SessionMcpCredentialStatusReader;
	let service: ApplicationSessionMcpStatusService;

	beforeEach(() => {
		workflowData = {
			getSessionEventStreamSnapshot: vi.fn(async () =>
				sessionDetail({
					agentId: "agent-1",
					agentVersion: 7,
					vaultIds: ["vault-1", "vault-2"],
				}),
			),
		};
		agentConfigs = {
			getAgentMcpConfig: vi.fn(async () => ({
				mcpServers: [
					{
						server_name: "GitHub",
						url: "https://mcp.example/github",
					},
					{
						displayName: "Local tool",
					},
				],
			})),
		};
		credentials = {
			hasCredentialForMcpServer: vi.fn(async ({ mcpServerUrl }) =>
				mcpServerUrl.includes("github"),
			),
		};
		service = new ApplicationSessionMcpStatusService({
			workflowData,
			agentConfigs,
			credentials,
		});
	});

	it("returns MCP credential health for the scoped session agent", async () => {
		const result = await service.getStatus(commandInput());

		expect(workflowData.getSessionEventStreamSnapshot).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
		});
		expect(agentConfigs.getAgentMcpConfig).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 7,
		});
		expect(credentials.hasCredentialForMcpServer).toHaveBeenCalledWith({
			vaultIds: ["vault-1", "vault-2"],
			mcpServerUrl: "https://mcp.example/github",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				vaultCount: 2,
				servers: [
					{
						name: "GitHub",
						url: "https://mcp.example/github",
						authenticated: true,
						credentialDisplayName: null,
						lastUsedAt: null,
					},
					{
						name: "Local tool",
						url: null,
						authenticated: false,
						credentialDisplayName: null,
						lastUsedAt: null,
					},
				],
			},
		});
	});

	it("returns not found for sessions outside workflowData scope", async () => {
		vi.mocked(workflowData.getSessionEventStreamSnapshot).mockResolvedValue(null);

		const result = await service.getStatus(commandInput());

		expect(result).toEqual({
			status: "not_found",
			message: "Session not found",
		});
		expect(agentConfigs.getAgentMcpConfig).not.toHaveBeenCalled();
	});

	it("returns not found when the session agent cannot be resolved", async () => {
		vi.mocked(agentConfigs.getAgentMcpConfig).mockResolvedValue(null);

		const result = await service.getStatus(commandInput());

		expect(result).toEqual({ status: "not_found", message: "Agent not found" });
		expect(credentials.hasCredentialForMcpServer).not.toHaveBeenCalled();
	});

	it("reports unauthenticated servers when no matching credential exists", async () => {
		vi.mocked(credentials.hasCredentialForMcpServer).mockResolvedValue(false);

		const result = await service.getStatus(commandInput());

		expect(result).toMatchObject({
			status: "ok",
			body: {
				servers: [
					{
						name: "GitHub",
						url: "https://mcp.example/github",
						authenticated: false,
					},
					{
						name: "Local tool",
						url: null,
						authenticated: false,
					},
				],
			},
		});
	});

	it("returns an empty server list when the agent has no MCP config", async () => {
		vi.mocked(agentConfigs.getAgentMcpConfig).mockResolvedValue({});

		const result = await service.getStatus(commandInput());

		expect(result).toEqual({
			status: "ok",
			body: {
				vaultCount: 2,
				servers: [],
			},
		});
	});
});

function commandInput() {
	return {
		sessionId: "session-1",
		userId: "user-1",
		projectId: "project-1",
	};
}

function sessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
	return {
		id: "session-1",
		title: "Session",
		status: "running",
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
		mlflowSessionId: null,
		workflowId: null,
		workflowName: null,
		agentName: null,
		agentSlug: null,
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lastEventAt: null,
		pendingInput: null,
		completedAt: null,
		archivedAt: null,
		daprInstanceId: "session-1",
		natsSubject: null,
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: null,
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
		pausedAt: null,
		...overrides,
	};
}
