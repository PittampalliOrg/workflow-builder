import { beforeEach, describe, expect, it, vi } from "vitest";

const daprFetchMock = vi.fn();
const resolveSessionRuntimeTargetMock = vi.fn();
const waitForAgentWorkflowHostAppReadyMock = vi.fn();
const workflowDataMock = {
	getSessionDetail: vi.fn(),
};

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: (...args: unknown[]) => daprFetchMock(...args),
	getDaprSidecarUrl: () => "http://dapr-sidecar",
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

vi.mock("$lib/server/sessions/runtime-target", () => ({
	resolveSessionRuntimeTarget: (...args: unknown[]) =>
		resolveSessionRuntimeTargetMock(...args),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	waitForAgentWorkflowHostAppReady: (...args: unknown[]) =>
		waitForAgentWorkflowHostAppReadyMock(...args),
}));

import { raiseSessionEvent } from "./control";

describe("raiseSessionEvent", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
		workflowDataMock.getSessionDetail.mockReset();
		resolveSessionRuntimeTargetMock.mockReset();
		waitForAgentWorkflowHostAppReadyMock.mockReset();
		vi.unstubAllGlobals();
		delete process.env.AGENT_RUNTIME_NAMESPACE;
		delete process.env.POD_NAMESPACE;
	});

	it("returns 409 before a session is attached to a Dapr instance", async () => {
		workflowDataMock.getSessionDetail.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 1,
			daprInstanceId: null,
		});

		const result = await raiseSessionEvent("s1", "session.control.update_agent_config", {
			modelSpec: "openai/o3",
		});

		expect(result.status).toBe(409);
		expect(daprFetchMock).not.toHaveBeenCalled();
	});

	it("routes control events to the persisted owning runtime target", async () => {
		workflowDataMock.getSessionDetail.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 2,
			daprInstanceId: "s1",
		});
		resolveSessionRuntimeTargetMock.mockResolvedValueOnce({
			appId: "agent-session-abc123",
			invokeTarget: "agent-session-abc123",
			runtimeSandboxName: "agent-host-agent-session-abc123",
			source: "persisted",
		});
		waitForAgentWorkflowHostAppReadyMock.mockResolvedValueOnce({
			ok: true,
			attempts: 1,
			status: 200,
			baseUrl: "http://10.244.1.20:8002",
			podName: "agent-host-agent-session-abc123",
			podIP: "10.244.1.20",
		});
		daprFetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

		const result = await raiseSessionEvent("s1", "session.control.update_agent_config", {
			patch: { modelSpec: "openai/o3" },
		});

		expect(result.ok).toBe(true);
		expect(resolveSessionRuntimeTargetMock).toHaveBeenCalledWith("s1");
		expect(waitForAgentWorkflowHostAppReadyMock).toHaveBeenCalledWith({
			agentAppId: "agent-session-abc123",
		});
		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://10.244.1.20:8002/internal/sessions/raise-event",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					instanceId: "s1",
					eventName: "session.control.update_agent_config",
					payload: { patch: { modelSpec: "openai/o3" } },
				}),
			}),
		);
	});
});
