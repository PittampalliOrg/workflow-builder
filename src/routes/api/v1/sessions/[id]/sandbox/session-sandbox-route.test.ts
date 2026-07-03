import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session sandbox route", () => {
	it("delegates sandbox deletion to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionSandboxes.deleteSessionSandboxes");
		expect(source).not.toContain("$lib/server/openshell-runtime");
		expect(source).not.toContain("$lib/server/kube/client");
		expect(source).not.toContain("$lib/server/lifecycle");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("workflowData.getSessionDetail");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
