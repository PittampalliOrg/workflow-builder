import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("session spawn wiring", () => {
	it("keeps session row lookup and runtime attachment behind workflow-data", () => {
		const source = readFileSync(new URL("./spawn.ts", import.meta.url), "utf8");

		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).toContain("workflowData.resolveSessionAgent");
		expect(source).toContain("workflowData.resolvePeerAgentDispatchContext");
		expect(source).toContain("workflowData.attachSessionRuntime");
		expect(source).toContain("workflowData.listSessionEvents");
		expect(source).toContain("workflowData.appendSessionEvent");
		expect(source).toContain("workflowData.getWorkflowExecutionWorkspaceKey");
		expect(source).toContain("runtimeUsesSharedWorkspace");
		expect(source).toContain("if (options.requireWorkflowHost) throw err");
		expect(source).toContain("options.requireWorkflowHost && !sessionHost");
		expect(source).toContain("environments.resolveRuntimeByRef");
		expect(source).toContain("sessionCommands.materializeSessionRepositoriesViaHost");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/agents/registry-sync");
		expect(source).not.toContain("$lib/server/environments/registry");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/sessions/repositories");
		expect(source).not.toContain("resolveEnvironmentRef");
		expect(source).not.toContain("attachRuntime");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("appendEvent(");
		expect(source).not.toContain("listEvents(");
	});
});
