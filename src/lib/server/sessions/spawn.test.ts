import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("session spawn wiring", () => {
	it("keeps session row lookup and runtime attachment behind workflow-data", () => {
		const source = readFileSync(new URL("./spawn.ts", import.meta.url), "utf8");

		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).toContain("workflowData.attachSessionRuntime");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("attachRuntime");
		expect(source).not.toContain("getSession(");
	});
});
