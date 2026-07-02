import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("new session page server loader", () => {
	it("loads runtime metadata through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getNewSessionPageReadModel");
		expect(source).not.toContain("$lib/server/agents/runtime-registry");
		expect(source).not.toContain("listRuntimes");
	});
});
