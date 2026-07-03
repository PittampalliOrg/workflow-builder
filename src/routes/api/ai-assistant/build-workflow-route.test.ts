import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("AI assistant build-workflow route", () => {
	it("loads and saves workflow definitions through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "build-workflow/+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("getWorkflowByRef");
		expect(source).toContain("updateWorkflowDefinition");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
