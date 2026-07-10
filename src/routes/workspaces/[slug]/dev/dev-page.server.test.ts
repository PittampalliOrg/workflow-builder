import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("workspace dev page loader", () => {
	it("loads the dev preview hub read model through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("requirePlatformAdmin");
		expect(source).toContain("workflowData.getDevPreviewHubReadModel");
		expect(source).not.toContain(
			"workflowData.findProjectWorkflowIdByIdOrNamePrefix",
		);
		expect(source).not.toContain("$lib/server/workflows/dev-environments");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflows.");
	});
});
