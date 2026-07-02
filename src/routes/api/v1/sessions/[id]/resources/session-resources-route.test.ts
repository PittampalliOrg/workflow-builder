import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session resources route", () => {
	it("routes resource persistence through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.listSessionResources");
		expect(source).toContain("workflowData.addSessionResource");
		expect(source).toContain("projectId: locals.session.projectId");
		expect(source).toContain("userId: locals.session.userId");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toMatch(
			/import\s*\{[^}]*\b(addResource|getSession|listResources)\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/registry["']/,
		);
	});
});
