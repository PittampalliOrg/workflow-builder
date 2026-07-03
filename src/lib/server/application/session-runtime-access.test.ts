import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionRuntimeAccessService } from "$lib/server/application/session-runtime-access";
import type {
	SessionRuntimeCapabilityReader,
	SessionRuntimeDebugTarget,
	SessionRuntimePodLocator,
	WorkflowDataService,
} from "$lib/server/application/ports";

describe("ApplicationSessionRuntimeAccessService", () => {
	let workflowData: Pick<WorkflowDataService, "getSessionRuntimeDebugTarget">;
	let pods: SessionRuntimePodLocator;
	let capabilities: SessionRuntimeCapabilityReader;
	let service: ApplicationSessionRuntimeAccessService;

	beforeEach(() => {
		workflowData = {
			getSessionRuntimeDebugTarget: vi.fn(async () => runtimeTarget()),
		};
		pods = {
			getSessionRuntimePod: vi.fn(async () => ({
				name: "runtime-pod",
				namespace: "workflow-builder",
				podIP: "10.0.0.10",
				containers: [
					{ name: "chromium", ready: true },
					{ name: "workspace", ready: false },
				],
			})),
			getAgentWorkflowHostPod: vi.fn(async () => ({
				name: "cli-pod",
				namespace: "workflow-builder",
				podIP: "10.0.0.11",
				containers: [{ name: "cli-agent-py", ready: true }],
			})),
		};
		capabilities = {
			isShellContainerAllowed: vi.fn((container) =>
				new Set(["chromium", "workspace"]).has(container),
			),
			hasInteractiveTerminal: vi.fn((runtime) => runtime === "codex-cli"),
		};
		service = new ApplicationSessionRuntimeAccessService({
			workflowData,
			pods,
			capabilities,
		});
	});

	it("rejects invalid shell containers before session lookup", async () => {
		const result = await service.resolveShell({
			...commandInput(),
			container: "database",
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 400,
			message: "Invalid container",
		});
		expect(workflowData.getSessionRuntimeDebugTarget).not.toHaveBeenCalled();
		expect(pods.getSessionRuntimePod).not.toHaveBeenCalled();
	});

	it("returns not found when scoped runtime target lookup fails", async () => {
		vi.mocked(workflowData.getSessionRuntimeDebugTarget).mockResolvedValue(null);

		const result = await service.resolveShell({
			...commandInput(),
			container: "chromium",
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Session not found in workspace",
		});
		expect(pods.getSessionRuntimePod).not.toHaveBeenCalled();
	});

	it("returns unavailable when the shell runtime pod is missing", async () => {
		vi.mocked(pods.getSessionRuntimePod).mockResolvedValue(null);

		const result = await service.resolveShell({
			...commandInput(),
			container: "chromium",
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 503,
			message: "Agent pod not running",
		});
	});

	it("returns unavailable when the requested shell container is not ready", async () => {
		const result = await service.resolveShell({
			...commandInput(),
			container: "workspace",
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 503,
			message: "workspace container not ready",
		});
	});

	it("returns shell pod coordinates for a ready container", async () => {
		const result = await service.resolveShell({
			...commandInput(),
			container: "chromium",
		});

		expect(pods.getSessionRuntimePod).toHaveBeenCalledWith({
			appId: "agent-runtime-session-1",
			agentSlug: "agent-1",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				pod: "runtime-pod",
				namespace: "workflow-builder",
				container: "chromium",
			},
		});
	});

	it("rejects CLI terminal access for non-interactive runtimes", async () => {
		vi.mocked(workflowData.getSessionRuntimeDebugTarget).mockResolvedValue(
			runtimeTarget({ agentRuntime: "dapr-agent-py" }),
		);

		const result = await service.resolveCliTerminal(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 409,
			message: "Session runtime does not expose an interactive terminal",
		});
		expect(pods.getAgentWorkflowHostPod).not.toHaveBeenCalled();
	});

	it("returns unavailable when the CLI workflow host pod has no IP", async () => {
		vi.mocked(pods.getAgentWorkflowHostPod).mockResolvedValue({
			name: "cli-pod",
			namespace: "workflow-builder",
			podIP: null,
			containers: [],
		});

		const result = await service.resolveCliTerminal(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 503,
			message: "Agent pod not running",
		});
	});

	it("returns CLI terminal pod coordinates for interactive runtimes", async () => {
		const result = await service.resolveCliTerminal(commandInput());

		expect(pods.getAgentWorkflowHostPod).toHaveBeenCalledWith(
			"agent-runtime-session-1",
		);
		expect(result).toEqual({
			status: "ok",
			body: { podIp: "10.0.0.11", port: 8002 },
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

function runtimeTarget(
	overrides: Partial<SessionRuntimeDebugTarget> = {},
): SessionRuntimeDebugTarget {
	return {
		appId: "agent-runtime-session-1",
		invokeTarget: "agent-runtime-session-1",
		runtimeSandboxName: "sandbox-session-1",
		source: "agent",
		agentSlug: "agent-1",
		agentRuntime: "codex-cli",
		...overrides,
	};
}
