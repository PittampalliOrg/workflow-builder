import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("file registry", () => {
	it("delegates file persistence through workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "registry.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.createWorkflowFile");
		expect(source).toContain("workflowData.listWorkflowFiles");
		expect(source).toContain("workflowData.getWorkflowFile");
		expect(source).toContain("workflowData.getWorkflowFileContent");
		expect(source).toContain("workflowData.archiveWorkflowFile");
		expect(source).toContain("workflowData.deleteWorkflowFile");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
