import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session goal flow route", () => {
	it("loads the goal-flow read model through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionGoalFlow");
		expect(source).not.toContain("$lib/server/observability/goal-flow");
		expect(source).not.toContain("$lib/server/goals/repo");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("isResourceInScope");
	});
});
