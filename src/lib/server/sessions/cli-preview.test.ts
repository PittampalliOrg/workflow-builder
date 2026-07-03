import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	executionPreviewBackend,
	resolveCliPreviewTarget,
	resolveExecutionCliPreviewTarget,
	type CliPreviewDataPort,
} from "$lib/server/sessions/cli-preview";

const mocks = vi.hoisted(() => ({
	getAgentWorkflowHostPod: vi.fn(),
	maybeProvisionAgentWorkflowHost: vi.fn(),
	waitForAgentWorkflowHostAppReady: vi.fn(),
}));

vi.mock("$lib/server/kube/client", () => ({
	getAgentWorkflowHostPod: mocks.getAgentWorkflowHostPod,
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	sessionHostAppId: (sessionId: string) => `agent-${sessionId}`,
	maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
	waitForAgentWorkflowHostAppReady: mocks.waitForAgentWorkflowHostAppReady,
}));

describe("cli-preview persistence boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAgentWorkflowHostPod.mockResolvedValue({ podIP: "10.0.0.20" });
	});

	it("does not import direct database modules", () => {
		const source = readFileSync(new URL("./cli-preview.ts", import.meta.url), "utf8");

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/runtime-target");
	});

	it("resolves a session preview target through workflow-data runtime target reads", async () => {
		const data = cliPreviewData({
			getSessionRuntimeDebugTarget: vi.fn(async () => ({
				appId: "agent-session-1",
				invokeTarget: "agent-session-1",
				runtimeSandboxName: "agent-host-agent-session-1",
				source: "persisted" as const,
				agentSlug: "codex-agent",
				agentRuntime: "codex-cli",
			})),
		});

		const result = await resolveCliPreviewTarget("session-1", "project-1", data);

		expect(data.getSessionRuntimeDebugTarget).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
		expect(mocks.getAgentWorkflowHostPod).toHaveBeenCalledWith("agent-session-1");
		expect(result).toEqual({
			ok: true,
			target: { podIP: "10.0.0.20", runtime: "codex-cli" },
		});
	});

	it("detects CLI execution previews through workflow-data before openshell fallback", async () => {
		const data = cliPreviewData({
			hasInteractiveCliSessionForExecution: vi.fn(async () => true),
		});

		await expect(executionPreviewBackend("exec-1", data)).resolves.toBe("cli");
		expect(data.hasInteractiveCliSessionForExecution).toHaveBeenCalledWith("exec-1");
		expect(data.getExecutionById).not.toHaveBeenCalled();
		expect(data.listWorkflowWorkspaceSessionsByExecutionId).not.toHaveBeenCalled();
	});

	it("falls back to openshell preview metadata through workflow-data", async () => {
		const data = cliPreviewData({
			hasInteractiveCliSessionForExecution: vi.fn(async () => false),
			getExecutionById: vi.fn(
				async () =>
					({
						id: "exec-1",
						input: { triggerData: { keepSandbox: true } },
						output: {
							workflowOutput: { sandboxName: "sandbox-1" },
							outputs: {},
						},
					}) as never,
			),
			listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => [
				{
					workspaceRef: "workspace-1",
					workflowExecutionId: "exec-1",
					rootPath: "/sandbox/workspaces/exec-1",
					status: "active" as const,
					sandboxState: { details: { sandboxName: "sandbox-1" } },
					createdAt: new Date("2026-07-03T00:00:00.000Z"),
				},
			]),
		});

		await expect(executionPreviewBackend("exec-1", data)).resolves.toBe("openshell");
		expect(data.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(data.listWorkflowWorkspaceSessionsByExecutionId).toHaveBeenCalledWith({
			executionId: "exec-1",
			limit: 1,
		});
	});

	it("resolves an execution preview target through workflow-data execution reads", async () => {
		const data = cliPreviewData({
			getExecutionById: vi.fn(
				async () =>
					({
						id: "exec-1",
						projectId: "project-1",
						daprInstanceId: "dapr-exec-1",
					}) as never,
			),
			hasInteractiveCliSessionForExecution: vi.fn(async () => true),
		});

		const result = await resolveExecutionCliPreviewTarget("exec-1", "project-1", data, {
			provisionIfMissing: false,
		});

		expect(data.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(data.hasInteractiveCliSessionForExecution).toHaveBeenCalledWith("exec-1");
		expect(mocks.getAgentWorkflowHostPod).toHaveBeenCalledWith("agent-exec-preview-exec-1");
		expect(result).toEqual({
			ok: true,
			target: {
				podIP: "10.0.0.20",
				appId: "agent-exec-preview-exec-1",
				sharedWorkspaceKey: "dapr-exec-1",
				reused: true,
			},
		});
	});
});

function cliPreviewData(overrides: Partial<CliPreviewDataPort> = {}): CliPreviewDataPort {
	return {
		getSessionRuntimeDebugTarget: vi.fn(async () => null),
		hasInteractiveCliSessionForExecution: vi.fn(async () => false),
		getExecutionById: vi.fn(async () => null),
		listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => []),
		...overrides,
	};
}
