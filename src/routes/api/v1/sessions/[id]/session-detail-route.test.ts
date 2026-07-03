import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session detail route", () => {
	it("routes session persistence and lifecycle decisions through application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).toContain("workflowData.updateSessionTitle");
		expect(source).toContain("sessionLifecycle.getSessionCoordinatorOwner");
		expect(source).toContain("sessionLifecycle.deleteSession");
		expect(source).toContain("sessionLifecycle.archiveSession");
		expect(source).not.toContain("$lib/server/lifecycle");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toMatch(
			/import\s*\{[^}]*\b(getSession|updateSessionTitle|deleteSession|archiveSession)\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/registry["']/,
		);
	});
});
