import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session runtime config route", () => {
	it("loads runtime config through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionRuntimeConfig");
		expect(source).not.toContain("$lib/server/sessions/runtime-config");
		expect(source).not.toMatch(
			/import\s*\{[^}]*\bgetSessionRuntimeConfig\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/runtime-config["']/,
		);
	});
});
