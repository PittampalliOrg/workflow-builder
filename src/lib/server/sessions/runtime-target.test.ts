import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const resolveAgentRefMock = vi.fn();

vi.mock("$lib/server/sessions/registry", () => ({
	getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock("$lib/server/agents/registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

import {
	decideGoalHarness,
	goalObjectiveRequestsNative,
	resolveSessionRuntimeTarget,
	runtimeHasNativeGoalHarness,
	stripNativeGoalPrefix,
} from "./runtime-target";

describe("runtimeHasNativeGoalHarness", () => {
	it("is true only for claude/codex CLI adapters, false for agy + non-CLI", () => {
		expect(runtimeHasNativeGoalHarness({ family: "interactive-cli", cliAdapter: "claude-code" })).toBe(true);
		expect(runtimeHasNativeGoalHarness({ family: "interactive-cli", cliAdapter: "codex" })).toBe(true);
		// agy: interactive-cli but no native goal harness → custom loop
		expect(runtimeHasNativeGoalHarness({ family: "interactive-cli", cliAdapter: "antigravity" })).toBe(false);
		// non-CLI runtimes have no native harness
		expect(runtimeHasNativeGoalHarness({ family: "durable-session", cliAdapter: undefined })).toBe(false);
		expect(runtimeHasNativeGoalHarness(null)).toBe(false);
	});
});

describe("decideGoalHarness (evaluator default, native opt-in via /goal prefix)", () => {
	it("defaults to evaluator (non-native) with no prefix, even on claude/codex", () => {
		expect(decideGoalHarness("Build the thing", true)).toEqual({ native: false, objective: "Build the thing" });
	});
	it("opts into native when prefixed AND the runtime has a harness", () => {
		expect(decideGoalHarness("/goal all tests pass", true)).toEqual({ native: true, objective: "all tests pass" });
	});
	it("strips the prefix but stays evaluator when no native harness (agy/dapr)", () => {
		expect(decideGoalHarness("/goal all tests pass", false)).toEqual({ native: false, objective: "all tests pass" });
	});
	it("detects + strips the prefix", () => {
		expect(goalObjectiveRequestsNative("/goal x")).toBe(true);
		expect(goalObjectiveRequestsNative("goal x")).toBe(false);
		expect(goalObjectiveRequestsNative("  /goal x")).toBe(true);
		expect(stripNativeGoalPrefix("/goal  do X")).toBe("do X");
	});
});

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
