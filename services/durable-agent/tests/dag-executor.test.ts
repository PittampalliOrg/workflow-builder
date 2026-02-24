import { describe, expect, it } from "vitest";
import {
	computeReadyTasks,
	markDownstreamSkipped,
	isDeadlocked,
	buildTaskPrompt,
	parseStreamJsonOutput,
	initTaskStates,
	summarizeTaskStates,
	type TaskState,
} from "../src/service/dag-executor.js";
import type { ClaudeTask } from "../src/service/claude-plan-schema.js";

function task(overrides: Partial<ClaudeTask> & { id: string }): ClaudeTask {
	return {
		subject: `Task ${overrides.id}`,
		description: `Description for task ${overrides.id}`,
		status: "pending",
		blocked: (overrides.blockedBy ?? []).length > 0,
		blockedBy: [],
		targetPaths: [],
		acceptanceCriteria: [],
		...overrides,
	};
}

// ── computeReadyTasks ─────────────────────────────────────────

describe("computeReadyTasks", () => {
	it("returns all tasks when none have dependencies", () => {
		const tasks = [task({ id: "1" }), task({ id: "2" }), task({ id: "3" })];
		const states = initTaskStates(tasks);
		const ready = computeReadyTasks(tasks, states);
		expect(ready.map((t) => t.id)).toEqual(["1", "2", "3"]);
	});

	it("returns only unblocked tasks in a linear chain", () => {
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", blockedBy: ["1"] }),
			task({ id: "3", blockedBy: ["2"] }),
		];
		const states = initTaskStates(tasks);

		// Only task 1 is ready initially
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual(["1"]);

		// After task 1 completes, task 2 is ready
		states["1"].status = "completed";
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual(["2"]);

		// After task 2 completes, task 3 is ready
		states["2"].status = "completed";
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual(["3"]);
	});

	it("handles diamond dependency pattern", () => {
		//   1
		//  / \
		// 2   3
		//  \ /
		//   4
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", blockedBy: ["1"] }),
			task({ id: "3", blockedBy: ["1"] }),
			task({ id: "4", blockedBy: ["2", "3"] }),
		];
		const states = initTaskStates(tasks);

		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual(["1"]);

		states["1"].status = "completed";
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual([
			"2",
			"3",
		]);

		states["2"].status = "completed";
		// Task 4 still blocked by 3
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual(["3"]);

		states["3"].status = "completed";
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual(["4"]);
	});

	it("does not return tasks already in_progress or completed", () => {
		const tasks = [task({ id: "1" }), task({ id: "2" })];
		const states = initTaskStates(tasks);
		states["1"].status = "in_progress";
		states["2"].status = "completed";
		expect(computeReadyTasks(tasks, states)).toEqual([]);
	});

	it("does not return tasks blocked by failed dependencies", () => {
		const tasks = [task({ id: "1" }), task({ id: "2", blockedBy: ["1"] })];
		const states = initTaskStates(tasks);
		states["1"].status = "failed";
		expect(computeReadyTasks(tasks, states).map((t) => t.id)).toEqual([]);
	});
});

// ── markDownstreamSkipped ─────────────────────────────────────

describe("markDownstreamSkipped", () => {
	it("marks direct dependents as skipped", () => {
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", blockedBy: ["1"] }),
			task({ id: "3", blockedBy: ["1"] }),
		];
		const states = initTaskStates(tasks);
		states["1"].status = "failed";

		markDownstreamSkipped("1", tasks, states);

		expect(states["2"].status).toBe("skipped");
		expect(states["3"].status).toBe("skipped");
	});

	it("propagates through transitive dependencies", () => {
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", blockedBy: ["1"] }),
			task({ id: "3", blockedBy: ["2"] }),
			task({ id: "4", blockedBy: ["3"] }),
		];
		const states = initTaskStates(tasks);
		states["1"].status = "failed";

		markDownstreamSkipped("1", tasks, states);

		expect(states["2"].status).toBe("skipped");
		expect(states["3"].status).toBe("skipped");
		expect(states["4"].status).toBe("skipped");
	});

	it("does not skip already completed tasks", () => {
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", blockedBy: ["1"] }),
			task({ id: "3", blockedBy: ["1"] }),
		];
		const states = initTaskStates(tasks);
		states["1"].status = "failed";
		states["2"].status = "completed";

		markDownstreamSkipped("1", tasks, states);

		expect(states["2"].status).toBe("completed"); // Not overwritten
		expect(states["3"].status).toBe("skipped");
	});

	it("handles diamond patterns without double-visiting", () => {
		//   1 (failed)
		//  / \
		// 2   3
		//  \ /
		//   4
		const tasks = [
			task({ id: "1" }),
			task({ id: "2", blockedBy: ["1"] }),
			task({ id: "3", blockedBy: ["1"] }),
			task({ id: "4", blockedBy: ["2", "3"] }),
		];
		const states = initTaskStates(tasks);
		states["1"].status = "failed";

		markDownstreamSkipped("1", tasks, states);

		expect(states["2"].status).toBe("skipped");
		expect(states["3"].status).toBe("skipped");
		expect(states["4"].status).toBe("skipped");
	});
});

// ── isDeadlocked ──────────────────────────────────────────────

describe("isDeadlocked", () => {
	it("returns false when there are ready tasks", () => {
		const tasks = [task({ id: "1" }), task({ id: "2", blockedBy: ["1"] })];
		const states = initTaskStates(tasks);
		expect(isDeadlocked(tasks, states)).toBe(false);
	});

	it("returns false when all tasks are completed", () => {
		const tasks = [task({ id: "1" }), task({ id: "2" })];
		const states = initTaskStates(tasks);
		states["1"].status = "completed";
		states["2"].status = "completed";
		expect(isDeadlocked(tasks, states)).toBe(false);
	});

	it("returns false when all tasks are in terminal state (mix of completed/failed/skipped)", () => {
		const tasks = [task({ id: "1" }), task({ id: "2" }), task({ id: "3" })];
		const states = initTaskStates(tasks);
		states["1"].status = "completed";
		states["2"].status = "failed";
		states["3"].status = "skipped";
		expect(isDeadlocked(tasks, states)).toBe(false);
	});

	it("returns true when tasks are pending but all blocked by failed deps", () => {
		const tasks = [task({ id: "1" }), task({ id: "2", blockedBy: ["1"] })];
		const states = initTaskStates(tasks);
		states["1"].status = "failed";
		// Task 2 is pending but blocked by failed task 1 -> deadlocked
		expect(isDeadlocked(tasks, states)).toBe(true);
	});

	it("returns false when in_progress tasks exist", () => {
		const tasks = [task({ id: "1" }), task({ id: "2", blockedBy: ["1"] })];
		const states = initTaskStates(tasks);
		states["1"].status = "in_progress";
		expect(isDeadlocked(tasks, states)).toBe(false);
	});
});

// ── buildTaskPrompt ───────────────────────────────────────────

describe("buildTaskPrompt", () => {
	it("builds a prompt with no prerequisites", () => {
		const t = task({
			id: "1",
			subject: "Create index file",
			description: "Create src/index.ts with basic exports",
		});
		const prompt = buildTaskPrompt(t, "Build the project", []);

		expect(prompt).toContain("Overall goal: Build the project");
		expect(prompt).toContain("## Current Task: Create index file");
		expect(prompt).toContain("Create src/index.ts with basic exports");
		expect(prompt).not.toContain("Completed prerequisites:");
	});

	it("includes completed prerequisites context", () => {
		const t = task({
			id: "2",
			subject: "Add tests",
			description: "Add unit tests for index module",
			blockedBy: ["1"],
		});
		const completedContext = [
			{ id: "1", subject: "Create index file", output: "Created src/index.ts" },
		];
		const prompt = buildTaskPrompt(t, "Build the project", completedContext);

		expect(prompt).toContain("Completed prerequisites:");
		expect(prompt).toContain("[1] Create index file — Created src/index.ts");
	});

	it("includes target paths and acceptance criteria", () => {
		const t = task({
			id: "1",
			subject: "Update config",
			description: "Update the configuration file",
			targetPaths: ["src/config.ts", "tsconfig.json"],
			acceptanceCriteria: ["Config loads without errors", "All tests pass"],
		});
		const prompt = buildTaskPrompt(t, "Fix config", []);

		expect(prompt).toContain("Target files: src/config.ts, tsconfig.json");
		expect(prompt).toContain("- Config loads without errors");
		expect(prompt).toContain("- All tests pass");
	});

	it("truncates long predecessor output", () => {
		const longOutput = "x".repeat(1000);
		const t = task({
			id: "2",
			subject: "Next task",
			description: "Do something",
			blockedBy: ["1"],
		});
		const completedContext = [
			{ id: "1", subject: "Previous", output: longOutput },
		];
		const prompt = buildTaskPrompt(t, "Goal", completedContext);

		// Should truncate to 500 chars
		expect(prompt.length).toBeLessThan(longOutput.length);
	});
});

// ── parseStreamJsonOutput ─────────────────────────────────────

describe("parseStreamJsonOutput", () => {
	it("returns error for empty output", () => {
		const result = parseStreamJsonOutput("");
		expect(result.success).toBe(false);
		expect(result.error).toContain("Empty");
	});

	it("parses a stream-json result message", () => {
		const lines = [
			'{"type":"assistant","message":{"content":"Working on it..."}}',
			'{"type":"result","result":"All changes applied successfully."}',
		].join("\n");

		const result = parseStreamJsonOutput(lines);
		expect(result.success).toBe(true);
		expect(result.output).toBe("All changes applied successfully.");
	});

	it("parses a result with nested content", () => {
		const lines = [
			'{"type":"result","result":{"content":"Done","text":"All good"}}',
		].join("\n");

		const result = parseStreamJsonOutput(lines);
		expect(result.success).toBe(true);
		expect(result.output).toBe("Done");
	});

	it("falls back to assistant message if no result type found", () => {
		const lines = [
			'{"type":"assistant","message":{"content":"I completed the task."}}',
		].join("\n");

		const result = parseStreamJsonOutput(lines);
		expect(result.success).toBe(true);
		expect(result.output).toBe("I completed the task.");
	});

	it("falls back to raw stdout for non-JSON output", () => {
		const result = parseStreamJsonOutput("Some plain text output from Claude");
		expect(result.success).toBe(true);
		expect(result.output).toContain("Some plain text output");
	});

	it("handles malformed JSON lines gracefully", () => {
		const lines = [
			"not json",
			"{invalid json}",
			'{"type":"result","result":"Success"}',
		].join("\n");

		const result = parseStreamJsonOutput(lines);
		expect(result.success).toBe(true);
		expect(result.output).toBe("Success");
	});
});

// ── summarizeTaskStates ───────────────────────────────────────

describe("summarizeTaskStates", () => {
	it("counts all status types correctly", () => {
		const states: Record<string, TaskState> = {
			"1": { status: "completed", retries: 0 },
			"2": { status: "failed", retries: 1 },
			"3": { status: "skipped", retries: 0 },
			"4": { status: "pending", retries: 0 },
			"5": { status: "in_progress", retries: 0 },
		};
		const summary = summarizeTaskStates(states);
		expect(summary).toEqual({
			completed: 1,
			failed: 1,
			skipped: 1,
			pending: 1,
			inProgress: 1,
		});
	});

	it("returns zeros for empty state", () => {
		const summary = summarizeTaskStates({});
		expect(summary).toEqual({
			completed: 0,
			failed: 0,
			skipped: 0,
			pending: 0,
			inProgress: 0,
		});
	});
});
