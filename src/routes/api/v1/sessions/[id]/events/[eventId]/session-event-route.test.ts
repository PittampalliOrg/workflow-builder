import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session event detail route", () => {
	it("loads full event payloads through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionEvent");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toMatch(
			/import\s*\{[^}]*\bgetEvent\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/events["']/,
		);
	});
});
