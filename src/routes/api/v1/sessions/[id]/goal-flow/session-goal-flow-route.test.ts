import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session goal flow route", () => {
	it("scopes session reads through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionEventStreamSnapshot");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("isResourceInScope");
	});
});
