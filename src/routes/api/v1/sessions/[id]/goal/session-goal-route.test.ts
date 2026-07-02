import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session goal route", () => {
	it("keeps session reads and native goal injection behind workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionEventStreamSnapshot");
		expect(source).toContain("workflowData.appendSessionUserEvents");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/sessions/spawn");
		expect(source).not.toContain("appendEvent");
		expect(source).not.toContain("getSession(");
	});
});
