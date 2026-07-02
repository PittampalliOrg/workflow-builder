import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session detail route", () => {
	it("routes session persistence through workflow-data while preserving lifecycle guards", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).toContain("workflowData.updateSessionTitle");
		expect(source).toContain("workflowData.deleteSession");
		expect(source).toContain("workflowData.archiveSession");
		expect(source).toContain("inspectDurableRun");
		expect(source).toContain("Stop the run before deleting this session");
		expect(source).toContain("Stop the run before archiving this session");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toMatch(
			/import\s*\{[^}]*\b(getSession|updateSessionTitle|deleteSession|archiveSession)\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/registry["']/,
		);
	});
});
