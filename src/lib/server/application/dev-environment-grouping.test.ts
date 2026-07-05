import { describe, expect, it } from "vitest";
import { groupDevEnvironmentSummaries } from "$lib/server/application/dev-environment-grouping";
import type { DevEnvironmentSummaryReadModel } from "$lib/server/application/ports";

function row(over: Partial<DevEnvironmentSummaryReadModel>): DevEnvironmentSummaryReadModel {
	return {
		executionId: "exec-1",
		workspaceRef: "ws-1",
		service: "workflow-builder",
		browseUrl: null,
		podIP: null,
		port: 3000,
		syncUrl: null,
		ready: true,
		needsDapr: false,
		daprAppId: null,
		sandboxName: null,
		sessionId: null,
		sessionUrl: null,
		runStatus: null,
		createdAt: "2026-07-04T10:00:00.000Z",
		...over,
	};
}

describe("groupDevEnvironmentSummaries", () => {
	it("renders a multi-service session as ONE environment with N services", () => {
		const groups = groupDevEnvironmentSummaries([
			row({
				service: "workflow-orchestrator",
				workspaceRef: "ws-b",
				createdAt: "2026-07-04T10:01:00.000Z",
				sessionId: null,
			}),
			row({
				service: "workflow-builder",
				workspaceRef: "ws-a",
				createdAt: "2026-07-04T10:00:00.000Z",
				sessionId: "session-1",
				sessionUrl: "/sessions/session-1",
				runStatus: "running",
			}),
		]);
		expect(groups).toHaveLength(1);
		const [group] = groups;
		expect(group.executionId).toBe("exec-1");
		expect(group.services.map((s) => s.service)).toEqual([
			"workflow-builder",
			"workflow-orchestrator",
		]);
		// Primary = the first (newest) row; birth = earliest createdAt.
		expect(group.primary.service).toBe("workflow-orchestrator");
		expect(group.createdAt).toBe("2026-07-04T10:00:00.000Z");
		// Session/runStatus surface from whichever row carries them.
		expect(group.sessionId).toBe("session-1");
		expect(group.runStatus).toBe("running");
	});

	it("is ready only when EVERY service is ready", () => {
		const [group] = groupDevEnvironmentSummaries([
			row({ service: "workflow-builder", ready: true }),
			row({ service: "workflow-orchestrator", workspaceRef: "ws-b", ready: false }),
		]);
		expect(group.ready).toBe(false);
	});

	it("preserves newest-first ordering across executions", () => {
		const groups = groupDevEnvironmentSummaries([
			row({ executionId: "exec-new", createdAt: "2026-07-04T12:00:00.000Z" }),
			row({ executionId: "exec-old", createdAt: "2026-07-04T09:00:00.000Z" }),
		]);
		expect(groups.map((g) => g.executionId)).toEqual(["exec-new", "exec-old"]);
	});

	it("handles the empty list", () => {
		expect(groupDevEnvironmentSummaries([])).toEqual([]);
	});
});
