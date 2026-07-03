import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = {
	getSessionRuntimeTarget: vi.fn(),
	getSessionRuntimeDebugTarget: vi.fn(),
};

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

import {
	decideGoalHarness,
	goalObjectiveRequestsNative,
	resolveSessionRuntimeDebugTarget,
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

describe("runtime target infrastructure boundary", () => {
	it("keeps direct database access outside the runtime-target facade", () => {
		const source = readFileSync(
			new URL("./runtime-target.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

describe("resolveSessionRuntimeTarget", () => {
	beforeEach(() => {
		workflowDataMock.getSessionRuntimeTarget.mockReset();
		workflowDataMock.getSessionRuntimeDebugTarget.mockReset();
	});

	it("resolves runtime targets through workflow-data", async () => {
		workflowDataMock.getSessionRuntimeTarget.mockResolvedValueOnce({
			appId: "agent-session-abc123",
			invokeTarget: "agent-session-abc123",
			runtimeSandboxName: "agent-host-agent-session-abc123",
			source: "persisted",
		});

		const target = await resolveSessionRuntimeTarget("s1");

		expect(target).toEqual({
			appId: "agent-session-abc123",
			invokeTarget: "agent-session-abc123",
			runtimeSandboxName: "agent-host-agent-session-abc123",
			source: "persisted",
		});
		expect(workflowDataMock.getSessionRuntimeTarget).toHaveBeenCalledWith({
			sessionId: "s1",
		});
	});

	it("resolves runtime debug targets through workflow-data", async () => {
		workflowDataMock.getSessionRuntimeDebugTarget.mockResolvedValueOnce({
			appId: "agent-runtime-code-agent",
			invokeTarget: "agent-runtime-code-agent",
			runtimeSandboxName: null,
			source: "agent",
			agentSlug: "code-agent",
			agentRuntime: "codex-cli",
		});

		const target = await resolveSessionRuntimeDebugTarget("s1", "project-1");

		expect(target).toEqual({
			appId: "agent-runtime-code-agent",
			invokeTarget: "agent-runtime-code-agent",
			runtimeSandboxName: null,
			source: "agent",
			agentSlug: "code-agent",
			agentRuntime: "codex-cli",
		});
		expect(workflowDataMock.getSessionRuntimeDebugTarget).toHaveBeenCalledWith({
			sessionId: "s1",
			projectId: "project-1",
		});
	});
});
