import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session sandbox route", () => {
	it("keeps lifecycle guards while routing session reads through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("inspectDurableRun");
		expect(source).toContain("Stop the run before destroying its sandbox");
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
