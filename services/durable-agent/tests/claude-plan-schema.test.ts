import { describe, expect, it } from "vitest";
import {
	claudePlanJsonSchema,
	validateClaudeTaskPlan,
} from "../src/service/claude-plan-schema.js";

describe("claude plan schema", () => {
	it("validates a canonical claude task graph", () => {
		const parsed = validateClaudeTaskPlan({
			artifactType: "claude_task_graph_v1",
			goal: "Implement feature",
			estimated_tool_calls: 3,
			tasks: [
				{
					id: "1",
					subject: "Inspect code",
					description: "Read related files",
					status: "pending",
					blocked: false,
					blockedBy: [],
				},
			],
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.plan.tasks[0]?.blockedBy).toEqual([]);
	});

	it("normalizes blockedBy and blocked flag", () => {
		const parsed = validateClaudeTaskPlan({
			goal: "Implement feature",
			estimated_tool_calls: 1,
			tasks: [
				{
					id: "2",
					subject: "Change file",
					description: "Edit source",
					blockedBy: ["1", "1", "2"],
				},
			],
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.plan.tasks[0]?.blockedBy).toEqual(["1"]);
		expect(parsed.plan.tasks[0]?.blocked).toBe(true);
		expect(parsed.plan.tasks[0]?.status).toBe("pending");
		expect(parsed.plan.artifactType).toBe("claude_task_graph_v1");
	});

	it("exposes a strict json schema for claude structured output", () => {
		const schema = claudePlanJsonSchema();
		expect(schema.type).toBe("object");
		expect(
			(schema as { properties?: Record<string, unknown> }).properties,
		).toHaveProperty("tasks");
	});
});
