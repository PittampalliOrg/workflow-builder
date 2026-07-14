import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateScript, validateScript } from "./sandbox.js";

const script = readFileSync(
	new URL("../../../scripts/fixtures/dynamic-scripts/code-eval-item.js", import.meta.url),
	"utf8",
);

describe("code-eval-item port", () => {
	it("validates", async () => {
		const v = await validateScript(script);
		expect(v.ok, v.error).toBe(true);
	});
	it("first round dispatches the workspace profile action", async () => {
		const res = await evaluateScript({
			script,
			args: {
				taskId: "HumanEval/0",
				runtimeProbeCommand: "python -V",
				solvePrompt: "solve it",
				agentRef: { id: "agent-1", version: 2 },
				evaluation: { itemId: "i1", expectedOutput: { testFileContent: "assert True" } },
			},
			budget: { total: 1_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(res.status).toBe("need");
		expect(res.tasks[0].kind).toBe("action");
		expect(res.tasks[0].actionSlug).toBe("workspace/profile");
		expect(res.tasks[0].opts.label).toBe("workspace_profile");
		expect(res.tasks[0].position?.line).toBeGreaterThan(0);
	});
});
