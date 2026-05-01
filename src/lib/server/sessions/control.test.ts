import { beforeEach, describe, expect, it, vi } from "vitest";

const daprFetchMock = vi.fn();
const getSessionMock = vi.fn();
const resolveAgentRefMock = vi.fn();

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: (...args: unknown[]) => daprFetchMock(...args),
	getDaprSidecarUrl: () => "http://dapr-sidecar",
}));

vi.mock("$lib/server/sessions/registry", () => ({
	getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock("$lib/server/agents/registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

import { raiseSessionEvent } from "./control";

describe("raiseSessionEvent", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
		getSessionMock.mockReset();
		resolveAgentRefMock.mockReset();
		delete process.env.AGENT_RUNTIME_NAMESPACE;
		delete process.env.POD_NAMESPACE;
	});

	it("returns 409 before a session is attached to a Dapr instance", async () => {
		getSessionMock.mockResolvedValueOnce({
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

	it("routes control events to the owning per-agent runtime", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 2,
			daprInstanceId: "s1",
		});
		resolveAgentRefMock.mockResolvedValueOnce({
			slug: "code-agent",
			runtimeAppId: null,
		});
		daprFetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

		const result = await raiseSessionEvent("s1", "session.control.update_agent_config", {
			patch: { modelSpec: "openai/o3" },
		});

		expect(result.ok).toBe(true);
		expect(resolveAgentRefMock).toHaveBeenCalledWith({ id: "a1", version: 2 });
		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://dapr-sidecar/v1.0/invoke/agent-runtime-code-agent/method/internal/sessions/raise-event",
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
