import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session compute route", () => {
	it("loads compute read models through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionRuntimeCompute");
		expect(source).not.toContain("workflowData.getSessionRuntimeDebugTarget");
		expect(source).not.toContain("$lib/server/kube/client");
		expect(source).not.toContain("$lib/server/metrics/resources");
		expect(source).not.toContain("$lib/server/sessions/runtime-target");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
