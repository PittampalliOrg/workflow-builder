import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const resolveAgentRefMock = vi.fn();

vi.mock("$lib/server/sessions/registry", () => ({
	getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock("$lib/server/agents/registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

import { resolveSessionRuntimeTarget } from "./runtime-target";

describe("resolveSessionRuntimeTarget", () => {
	beforeEach(() => {
		getSessionMock.mockReset();
		resolveAgentRefMock.mockReset();
	});

	it("prefers the runtime app persisted on the session", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 1,
			runtimeAppId: "agent-session-abc123",
			runtimeSandboxName: "agent-host-agent-session-abc123",
		});

		const target = await resolveSessionRuntimeTarget("s1");

		expect(target).toEqual({
			appId: "agent-session-abc123",
			invokeTarget: "agent-session-abc123",
			runtimeSandboxName: "agent-host-agent-session-abc123",
			source: "persisted",
		});
		expect(resolveAgentRefMock).not.toHaveBeenCalled();
	});

	it("falls back to the agent runtime for legacy sessions", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 2,
			runtimeAppId: null,
			runtimeSandboxName: null,
		});
		resolveAgentRefMock.mockResolvedValueOnce({
			slug: "code-agent",
			runtimeAppId: null,
		});

		const target = await resolveSessionRuntimeTarget("s1");

		expect(resolveAgentRefMock).toHaveBeenCalledWith({ id: "a1", version: 2 });
		expect(target).toEqual({
			appId: "agent-runtime-code-agent",
			invokeTarget: "agent-runtime-code-agent",
			runtimeSandboxName: null,
			source: "agent",
		});
	});
});
