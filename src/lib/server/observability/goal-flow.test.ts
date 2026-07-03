import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GoalFlow } from "$lib/types/observability";
import { buildGoalFlow } from "./goal-flow";

describe("observability goal flow", () => {
	it("keeps goal persistence behind workflow-data", () => {
		const source = readFileSync(new URL("./goal-flow.ts", import.meta.url), "utf8");

		expect(source).toContain("workflowData");
		expect(source).not.toContain("$lib/server/goals/repo");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("getCurrentGoalForSessions");
		expect(source).not.toContain("listGoalFlowEvents");
	});

	it("asks workflow-data for each candidate session until a goal flow is found", async () => {
		const flow = { status: "active", attempts: [] } as unknown as GoalFlow;
		const reader = {
			getSessionGoalFlow: vi
				.fn()
				.mockResolvedValueOnce({ status: "ok", goalFlow: null })
				.mockResolvedValueOnce({ status: "not_found" })
				.mockResolvedValueOnce({ status: "ok", goalFlow: flow }),
		};

		await expect(
			buildGoalFlow(["session-1", "session-1", "missing", "session-2"], [], reader),
		).resolves.toBe(flow);

		expect(reader.getSessionGoalFlow).toHaveBeenCalledTimes(3);
		expect(reader.getSessionGoalFlow).toHaveBeenNthCalledWith(1, {
			sessionId: "session-1",
			agentDecisions: [],
		});
		expect(reader.getSessionGoalFlow).toHaveBeenNthCalledWith(2, {
			sessionId: "missing",
			agentDecisions: [],
		});
		expect(reader.getSessionGoalFlow).toHaveBeenNthCalledWith(3, {
			sessionId: "session-2",
			agentDecisions: [],
		});
	});
});
